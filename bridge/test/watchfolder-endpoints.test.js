// bridge/test/watchfolder-endpoints.test.js
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

process.env.PORT = '3031';
process.env.WATCHFOLDER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ep-'));

const { app, watchEngine } = require('../server.js');
const PROJ = path.join(process.env.WATCHFOLDER_DIR, 'Series_A.prproj');
const WATCHED = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ep-watched-'));

const server = app.listen(3031, async () => {
  const base = 'http://127.0.0.1:3031';
  const post = (u, b) => fetch(base + u, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b || {}),
  }).then(r => r.json());
  const get = u => fetch(base + u).then(r => r.json());

  try {
    // 1. Ghi config — regex sai phải bị từ chối kèm lý do
    const bad = await post('/watch/config', {
      projectPath: PROJ,
      watches: [{ id: 'w_1', folder: WATCHED, binPath: 'F', include: ['video'],
                  intervalMs: 3000, excludeRegex: '[' }],
    });
    assert.strictEqual(bad.ok, false, 'regex sai → từ chối');
    assert.ok(/excludeRegex/.test(bad.error), 'lỗi nêu đúng trường: ' + bad.error);

    // 2. Ghi config hợp lệ
    const ok = await post('/watch/config', {
      projectPath: PROJ,
      watches: [{ id: 'w_1', enabled: true, label: 'T', folder: WATCHED, binPath: 'Footage',
                  recursive: true, maxDepth: 3, mirrorSubfolders: true, include: ['video'],
                  includeRegex: '', excludeRegex: '', intervalMs: 3000, stableChecks: 2 }],
    });
    assert.strictEqual(ok.ok, true, 'config hợp lệ được ghi');

    // 3. Đọc lại
    const cfg = await get('/watch/config?projectPath=' + encodeURIComponent(PROJ));
    assert.strictEqual(cfg.watches.length, 1, 'đọc lại đúng 1 watch');

    // 4. start → baseline, file có sẵn không vào queue
    fs.writeFileSync(path.join(WATCHED, 'old.mp4'), 'xxx');
    const started = await post('/watch/session/start', { projectPath: PROJ });
    assert.strictEqual(started.ok, true);
    watchEngine.tick(); watchEngine.tick();
    let p = await get('/watch/poll');
    assert.deepStrictEqual(p.items, [], 'file có sẵn không vào queue');

    // 5. File mới → vào queue sau khi ổn định
    fs.writeFileSync(path.join(WATCHED, 'new.mp4'), 'yyyy');
    watchEngine.tick(); watchEngine.tick();
    p = await get('/watch/poll');
    assert.strictEqual(p.items.length, 1, 'file mới vào queue');
    assert.ok(p.stats, 'poll trả kèm stats');

    // 6. ack
    const acked = await post('/watch/ack', { done: [p.items[0].id], failed: [] });
    assert.strictEqual(acked.ok, true);
    p = await get('/watch/poll');
    assert.deepStrictEqual(p.items, [], 'ack rồi queue rỗng');

    // 7. scan-now không ném với watchId lạ
    const sn = await post('/watch/scan-now', { watchId: 'khong-co' });
    assert.strictEqual(sn.ok, false, 'watchId lạ → ok:false, không sập');

    // 7b. browse: mở ở root sản phẩm (cấp cha của thư mục chứa .prproj)
    // Dựng cây riêng trong thư mục tạm, KHÔNG dùng PROJ — cha của nó là thư mục
    // temp hệ thống, tạo thư mục ở đó là xả rác ra ngoài phạm vi test.
    const fsx = require('fs'), pathx = require('path');
    const SP = pathx.join(process.env.WATCHFOLDER_DIR, 'SanPham');
    fsx.mkdirSync(pathx.join(SP, 'Project'), { recursive: true });
    fsx.mkdirSync(pathx.join(SP, 'Footage'), { recursive: true });
    const PROJ2 = pathx.join(SP, 'Project', 'b.prproj');
    fsx.writeFileSync(PROJ2, 'x');
    const br = await get('/watch/browse?projectPath=' + encodeURIComponent(PROJ2));
    assert.strictEqual(br.ok, true, 'browse chạy: ' + JSON.stringify(br));
    assert.strictEqual(br.path, SP, 'mở ở cấp cha của thư mục chứa .prproj');
    assert.ok(br.dirs.some(d => d.name === 'Footage'), 'liệt kê được thư mục con');

    const br2 = await get('/watch/browse');
    assert.strictEqual(br2.ok, false, 'thiếu cả path lẫn projectPath → từ chối');

    // 8. stop
    assert.strictEqual((await post('/watch/session/stop', {})).ok, true);

    console.log('watchfolder-endpoints: OK');
    server.close(); process.exit(0);
  } catch (e) {
    console.error(e); server.close(); process.exit(1);
  }
});
