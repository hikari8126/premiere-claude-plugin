// bridge/test/rename-endpoints.test.js — luồng /rename/* trên thư mục sản phẩm tạm:
// plan → apply → aep → journal → revert một dòng → undo.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PORT = '3036';
process.env.RENAME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-ep-dir-'));
process.env.WATCHFOLDER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-ep-wf-'));
process.env.RENAME_FAKE_AE = '0';

const { app } = require('../server.js');
const aep = require('../aep-relink.js');

// Thư mục sản phẩm: SP/Project/SP.prproj + SP/Footage/*.mov + SP/Project/SP.aep
const SP = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-ep-sp-'));
fs.mkdirSync(path.join(SP, 'Project')); fs.mkdirSync(path.join(SP, 'Footage'));
const PROJ = path.join(SP, 'Project', 'SP.prproj');
fs.writeFileSync(PROJ, 'x');
const F = n => path.join(SP, 'Footage', n);
['IMG_1.mov', 'IMG_2.mov', 'IMG_3.mov'].forEach(n => fs.writeFileSync(F(n), n));

function chunk(id, data) {
  data = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const h = Buffer.alloc(8); h.write(id, 0, 'latin1'); h.writeUInt32BE(data.length, 4);
  return Buffer.concat([h, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
const list = (form, kids) => chunk('LIST', Buffer.concat([Buffer.from(form, 'latin1')].concat(kids)));
const footage = (name, p) => list('Item', [chunk('Utf8', name), list('Pin ', [list('Als2', [chunk('alas', JSON.stringify({ fullpath: p }))])])]);
function aepFile(kids) {
  const body = Buffer.concat([Buffer.from('Egg!', 'latin1')].concat(kids));
  const h = Buffer.alloc(8); h.write('RIFX', 0, 'latin1'); h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
}
const AEP = path.join(SP, 'Project', 'SP.aep');
fs.writeFileSync(AEP, aepFile([list('Fold', [footage('IMG_1.mov', F('IMG_1.mov')), footage('', F('IMG_2.mov'))])]));

const server = app.listen(3036, async () => {
  const base = 'http://127.0.0.1:3036';
  const post = (u, b) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) })
    .then(async r => Object.assign({ status: r.status }, await r.json()));
  const get = u => fetch(base + u).then(r => r.json());
  const rows = [
    { oldPath: F('IMG_1.mov'), newName: 'Higg_01.mov' },
    { oldPath: F('IMG_2.mov'), newName: 'Higg_02.mov' },
    { oldPath: F('IMG_3.mov'), newName: 'Higg_03.mov' },
  ];
  try {
    // 1. plan: không lỗi, tìm thấy .aep với 2 footage khớp
    const plan = await post('/rename/plan', { projectPath: PROJ, rows });
    assert.strictEqual(plan.ok, true, plan.error);
    assert.deepStrictEqual(plan.rows.map(r => r.error), ['', '', '']);
    assert.deepStrictEqual(plan.aep.map(a => [a.name, a.count]), [['SP.aep', 2]]);
    assert.strictEqual(plan.aeRunning, false);
    const quick = await post('/rename/plan', { projectPath: PROJ, rows, scanAep: false });
    assert.strictEqual(quick.aep, undefined, 'scanAep=false không quét');

    // 2. apply có dòng lỗi → 400, không đụng file nào
    const bad = await post('/rename/apply', { projectPath: PROJ, rows: rows.concat([{ oldPath: F('nope.mov'), newName: 'x.mov' }]) });
    assert.strictEqual(bad.status, 400);
    assert.ok(fs.existsSync(F('IMG_1.mov')));

    // 3. apply thật
    const ap = await post('/rename/apply', { projectPath: PROJ, rows, aep: [AEP] });
    assert.strictEqual(ap.ok, true, ap.error);
    assert.ok(ap.batchId);
    assert.deepStrictEqual(fs.readdirSync(path.join(SP, 'Footage')).sort(), ['Higg_01.mov', 'Higg_02.mov', 'Higg_03.mov']);
    assert.strictEqual(fs.readFileSync(F('Higg_02.mov'), 'utf8'), 'IMG_2.mov');

    // 4. AE đang mở → /rename/aep từ chối
    process.env.RENAME_FAKE_AE = '1';
    const blocked = await post('/rename/aep', { projectPath: PROJ, batchId: ap.batchId });
    assert.strictEqual(blocked.status, 409);
    process.env.RENAME_FAKE_AE = '0';

    // 5. relink .aep
    const ae = await post('/rename/aep', { projectPath: PROJ, batchId: ap.batchId });
    assert.strictEqual(ae.ok, true, ae.error);
    assert.deepStrictEqual(ae.files.map(f => [f.name, f.ok, f.replaced, f.renamed]), [['SP.aep', true, 2, 1]]);
    assert.deepStrictEqual(aep.fullpaths(fs.readFileSync(AEP)), [F('Higg_01.mov'), F('Higg_02.mov')]);
    assert.deepStrictEqual(aep.itemNames(fs.readFileSync(AEP)), ['Higg_01.mov', '']);

    // 6. journal
    const j = await get('/rename/journal?projectPath=' + encodeURIComponent(PROJ));
    assert.strictEqual(j.batch.batchId, ap.batchId);
    assert.strictEqual(j.batch.rows.length, 3);
    assert.deepStrictEqual(j.batch.aep, [{ path: AEP, count: 2 }]);

    // 6b. ghi clip đã chuyển bin → undo trả lại để plugin chuyển về
    const nt = await post('/rename/note', { projectPath: PROJ, batchId: ap.batchId, moves: [{ path: F('Higg_01.mov'), fromBin: 'Source / Kling' }, { bad: 1 }] });
    assert.strictEqual(nt.moves, 1);

    // 7. revert riêng dòng 3 (giả lập plugin relink lỗi)
    const rv = await post('/rename/revert', { projectPath: PROJ, batchId: ap.batchId, oldPaths: [F('IMG_3.mov')] });
    assert.strictEqual(rv.reverted, 1);
    assert.ok(fs.existsSync(F('IMG_3.mov')) && !fs.existsSync(F('Higg_03.mov')));

    // 8. batchId sai → 404
    const wrong = await post('/rename/undo', { projectPath: PROJ, batchId: 'nope' });
    assert.strictEqual(wrong.status, 404);

    // 9. undo: file + .aep về như cũ, nhật ký xoá
    const un = await post('/rename/undo', { projectPath: PROJ, batchId: ap.batchId });
    assert.strictEqual(un.ok, true, un.error);
    assert.strictEqual(un.rows.length, 2);
    assert.deepStrictEqual(un.moves, [{ path: F('Higg_01.mov'), fromBin: 'Source / Kling' }]);
    assert.deepStrictEqual(fs.readdirSync(path.join(SP, 'Footage')).sort(), ['IMG_1.mov', 'IMG_2.mov', 'IMG_3.mov']);
    assert.deepStrictEqual(aep.fullpaths(fs.readFileSync(AEP)), [F('IMG_1.mov'), F('IMG_2.mov')]);
    assert.deepStrictEqual(aep.itemNames(fs.readFileSync(AEP)), ['IMG_1.mov', '']);
    const j2 = await get('/rename/journal?projectPath=' + encodeURIComponent(PROJ));
    assert.strictEqual(j2.batch, null);

    console.log('✅ rename-endpoints: all passed');
    server.close(); process.exit(0);
  } catch (e) {
    console.error('❌', e); server.close(); process.exit(1);
  }
});
