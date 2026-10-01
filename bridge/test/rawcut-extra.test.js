// bridge/test/rawcut-extra.test.js — /rawcut/presets, /rawcut/stat
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PORT = '3034';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-extra-'));
process.env.HOME = TMP; // presets.json của engine nằm trong HOME tạm
process.env.RAWCUT_CACHE = path.join(TMP, 'cache');
const { findPython } = require('../rawcut-python.js');
if (!findPython().ok) { console.log('⏭  bỏ qua rawcut-extra (không có python3)'); process.exit(0); }
const { app } = require('../server.js');

const server = app.listen(3034, async () => {
  const base = 'http://127.0.0.1:3034';
  const post = (u, b) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(r => r.json());
  try {
    let r = await post('/rawcut/presets', { action: 'list' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.presets, {});
    r = await post('/rawcut/presets', { action: 'save', name: 'Nhẹ', crf: 18, scale: 50 });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.presets['Nhẹ'].crf, 18);
    r = await post('/rawcut/presets', { action: 'list' });
    assert.ok(r.presets['Nhẹ']);
    r = await post('/rawcut/presets', { action: 'delete', name: 'Nhẹ' });
    assert.deepStrictEqual(r.presets, {});
    assert.strictEqual((await post('/rawcut/presets', { action: 'save' })).ok, false);

    fs.mkdirSync(process.env.RAWCUT_CACHE, { recursive: true });
    const f = path.join(process.env.RAWCUT_CACHE, 'video-1-0-25.mp4');
    assert.deepStrictEqual(await post('/rawcut/stat', { path: f }), { ok: true, exists: false, size: 0 });
    fs.writeFileSync(f, 'abc');
    assert.deepStrictEqual(await post('/rawcut/stat', { path: f }), { ok: true, exists: true, size: 3 });
    assert.strictEqual((await post('/rawcut/stat', { path: '/etc/hosts' })).ok, false);
    console.log('✓ rawcut-extra');
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
