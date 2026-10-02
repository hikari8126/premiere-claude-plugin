// bridge/test/rename-ops.test.js — đổi tên file 2 pha + nhật ký cho "Đổi tên source hàng loạt".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RENAME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-dir-'));
const ops = require('../rename-ops.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rn-ops-')); }
function put(d, name, body) { const p = path.join(d, name); fs.writeFileSync(p, body == null ? name : body); return p; }
function list(d) { return fs.readdirSync(d).sort(); }

test('nameError mirrors the plugin rules', () => {
  assert.strictEqual(ops.nameError('Higg_01.mov'), '');
  assert.ok(ops.nameError('.mov'));
  assert.ok(ops.nameError('a/b.mov'));
  assert.ok(ops.nameError('a:b.mov'));
});

test('planRows: missing file, bad name, collision with an existing file', () => {
  const d = tmpDir();
  const a = put(d, 'a.mov'), b = put(d, 'b.mov');
  put(d, 'taken.mov');
  const r = ops.planRows([
    { oldPath: path.join(d, 'nope.mov'), newName: 'x.mov' },
    { oldPath: a, newName: 'a/b.mov' },
    { oldPath: b, newName: 'TAKEN.mov' },
  ]);
  assert.ok(/không còn/i.test(r[0].error), r[0].error);
  assert.ok(r[1].error);
  assert.ok(/trùng/i.test(r[2].error), r[2].error);
});

test('planRows: target freed by another row in the batch is fine; case-only rename is fine', () => {
  const d = tmpDir();
  const a = put(d, 'a.mov'), b = put(d, 'b.mov'), c = put(d, 'c.mov');
  const r = ops.planRows([
    { oldPath: a, newName: 'b.mov' },
    { oldPath: b, newName: 'a.mov' },
    { oldPath: c, newName: 'C.mov' },
  ]);
  assert.deepStrictEqual(r.map(x => x.error), ['', '', '']);
  assert.strictEqual(r[0].newPath, path.join(d, 'b.mov'));
});

test('planRows: duplicates inside the batch and unchanged names', () => {
  const d = tmpDir();
  const a = put(d, 'a.mov'), b = put(d, 'b.mov'), s = put(d, 'same.mov');
  const r = ops.planRows([
    { oldPath: a, newName: 'x.mov' },
    { oldPath: b, newName: 'X.mov' },
    { oldPath: s, newName: 'same.mov' },
  ]);
  assert.ok(r[0].error && r[1].error);
  assert.strictEqual(r[2].same, true);
  assert.strictEqual(r[2].error, '');
});

test('planRows: a row whose target is held by an erroring row collides', () => {
  const d = tmpDir();
  const a = put(d, 'a.mov'), b = put(d, 'b.mov');
  const r = ops.planRows([
    { oldPath: a, newName: 'bad:name.mov' },     // a stays put
    { oldPath: b, newName: 'a.mov' },            // so a.mov is still taken
  ]);
  assert.ok(r[0].error);
  assert.ok(/trùng/i.test(r[1].error), r[1].error);
});

test('applyRenames swaps names without losing content', () => {
  const d = tmpDir();
  const a = put(d, 'a.mov', 'AAA'), b = put(d, 'b.mov', 'BBB');
  const r = ops.applyRenames([{ oldPath: a, newPath: b }, { oldPath: b, newPath: a }]);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(fs.readFileSync(a, 'utf8'), 'BBB');
  assert.strictEqual(fs.readFileSync(b, 'utf8'), 'AAA');
  assert.deepStrictEqual(list(d), ['a.mov', 'b.mov']);
});

test('applyRenames case-only rename', () => {
  const d = tmpDir();
  const a = put(d, 'clip.mov', 'X');
  const r = ops.applyRenames([{ oldPath: a, newPath: path.join(d, 'CLIP.mov') }]);
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(list(d), ['CLIP.mov']);
});

test('applyRenames refuses to clobber a file that appeared after planning, and rolls back', () => {
  const d = tmpDir();
  const a = put(d, 'a.mov', 'A'), b = put(d, 'b.mov', 'B');
  put(d, 'late.mov', 'LATE');
  const r = ops.applyRenames([
    { oldPath: a, newPath: path.join(d, 'a2.mov') },
    { oldPath: b, newPath: path.join(d, 'late.mov') },
  ]);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(list(d), ['a.mov', 'b.mov', 'late.mov']);
  assert.strictEqual(fs.readFileSync(path.join(d, 'late.mov'), 'utf8'), 'LATE');
  assert.strictEqual(fs.readFileSync(a, 'utf8'), 'A');
});

test('applyRenames rolls back when a source vanished', () => {
  const d = tmpDir();
  const a = put(d, 'a.mov', 'A');
  const r = ops.applyRenames([
    { oldPath: a, newPath: path.join(d, 'a2.mov') },
    { oldPath: path.join(d, 'gone.mov'), newPath: path.join(d, 'g2.mov') },
  ]);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(list(d), ['a.mov']);
});

test('journal save / load / clear per project', () => {
  const P = '/x/Proj A.prproj';
  assert.strictEqual(ops.loadJournal(P), null);
  ops.saveJournal(P, { batchId: 'b1', rows: [{ oldPath: '/a', newPath: '/b' }] });
  assert.strictEqual(ops.loadJournal(P).batchId, 'b1');
  assert.strictEqual(ops.loadJournal('/x/other.prproj'), null);
  ops.clearJournal(P);
  assert.strictEqual(ops.loadJournal(P), null);
});

test('cleanupBackups removes batch folders older than the limit', () => {
  const root = ops.backupRoot();
  const old = path.join(root, 'old'), fresh = path.join(root, 'fresh');
  fs.mkdirSync(old, { recursive: true }); fs.mkdirSync(fresh, { recursive: true });
  const t = (Date.now() - 8 * 864e5) / 1000;
  fs.utimesSync(old, t, t);
  ops.cleanupBackups(7 * 864e5);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(fresh));
});
