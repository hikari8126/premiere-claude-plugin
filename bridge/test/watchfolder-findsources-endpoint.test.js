// bridge/test/watchfolder-findsources-endpoint.test.js
// POST /watch/find-sources: root suy từ projectPath (cấp cha của thư mục .prproj),
// trả về thư mục chứa file khớp + tên source không tìm thấy.
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

process.env.PORT = '3033';
process.env.WATCHFOLDER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-fs-'));

const { app } = require('../server.js');

// SanPham/Project/x.prproj  +  SanPham/Footage/...  → root = SanPham
const SP = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-fs-sp-'));
fs.mkdirSync(path.join(SP, 'Project'), { recursive: true });
fs.mkdirSync(path.join(SP, 'Footage', 'B Roll'), { recursive: true });
const PROJ = path.join(SP, 'Project', 'x.prproj');
fs.writeFileSync(PROJ, 'x');
fs.writeFileSync(path.join(SP, 'Footage', 'B Roll', 'san-pham-cau-1.mp4'), 'x');

const server = app.listen(3033, async () => {
  const post = (u, b) => fetch('http://127.0.0.1:3033' + u, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b || {}),
  }).then(r => r.json());

  try {
    const r = await post('/watch/find-sources', {
      projectPath: PROJ, names: ['San pham cau 1', 'khong ton tai'],
    });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.root, SP, 'root = cấp cha của thư mục chứa .prproj');
    assert.strictEqual(r.folders.length, 1, JSON.stringify(r.folders));
    assert.strictEqual(r.folders[0].rel, path.join('Footage', 'B Roll'));
    assert.strictEqual(r.folders[0].matches[0].exact, true);
    assert.deepStrictEqual(r.unmatched, ['khong ton tai']);

    // Thiếu projectPath lẫn root → 400 có lý do, không ném stack
    const bad = await post('/watch/find-sources', { names: ['a'] });
    assert.strictEqual(bad.ok, false);
    assert.ok(/projectPath/.test(bad.error), bad.error);

    console.log('watchfolder-findsources-endpoint: OK');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(SP, { recursive: true, force: true });
  }
});
