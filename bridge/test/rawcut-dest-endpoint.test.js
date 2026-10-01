// bridge/test/rawcut-dest-endpoint.test.js — POST /rawcut/dest: ok, từ chối (200), thiếu input (400)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PORT = '3033';
const { app } = require('../server.js');

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-dest-ep-')));
const SAMX = path.join(T, 'SAMX_WORKSPACE');
fs.mkdirSync(path.join(SAMX, 'Brand A', 'Output', 'ACT'), { recursive: true });
fs.mkdirSync(path.join(SAMX, 'Brand A', 'Asset'), { recursive: true });
const proj = path.join(SAMX, 'Brand A', 'Asset', 'a.prproj');
fs.writeFileSync(proj, '');

const server = app.listen(3033, async () => {
  const post = async (b) => {
    const r = await fetch('http://127.0.0.1:3033/rawcut/dest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json() };
  };
  try {
    let r = await post({ projectPath: proj, sequenceName: 'Brand A v1.2 [a.b]', sequenceId: 's1', mode: 'both' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true, r.body.why);
    assert.strictEqual(r.body.route, 'samx');
    assert.strictEqual(r.body.dirs.raw, path.join(SAMX, 'Brand A', 'Output', 'ACT', 'v1.2', 'raw'));
    assert.strictEqual(r.body.dirs.edited, path.join(SAMX, 'Brand A', 'Output', 'ACT', 'v1.2', 'edited'));

    r = await post({ projectPath: proj, sequenceName: 'S17' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, false);
    assert.ok(/S17/.test(r.body.why), r.body.why);

    r = await post({ sequenceName: 'X v1' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.ok, false);
    assert.ok(r.body.error);
    console.log('✓ rawcut-dest-endpoint');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    fs.rmSync(T, { recursive: true, force: true });
    server.close();
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  }
});
