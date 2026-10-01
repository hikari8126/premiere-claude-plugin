// bridge/test/rawcut-runner.test.js
const assert = require('assert');
const path = require('path');
const { runEngine } = require('../rawcut-runner.js');
const FAKE = path.join(__dirname, 'fixtures', 'rawcut-fake-engine.js');

(async () => {
  // 1. chạy hết: đủ event, mã 0
  const evs = [];
  const r1 = await runEngine({ bin: process.execPath, args: [FAKE, 'quick'], cwd: __dirname, onEvent: e => evs.push(e) }).done;
  assert.strictEqual(r1.code, 0, r1.stderr);
  assert.strictEqual(r1.cancelled, false);
  assert.deepStrictEqual(evs.map(e => e.type), ['encoding', 'start', 'done', 'done', 'reason']);

  // 2. cancel giết cả process group, kể cả "ffmpeg" con
  let kid = 0;
  const j2 = runEngine({
    bin: process.execPath, args: [FAKE], cwd: __dirname,
    onLine: l => { const m = /^KID (\d+)/.exec(l); if (m) { kid = Number(m[1]); j2.cancel(); } },
  });
  const r2 = await j2.done;
  assert.strictEqual(r2.cancelled, true);
  assert.strictEqual(r2.code, null);
  assert.strictEqual(r2.signal, 'SIGTERM');
  assert.ok(kid > 0, 'phải đọc được pid con');
  await new Promise(r => setTimeout(r, 300));
  assert.throws(() => process.kill(kid, 0), /ESRCH/, 'tiến trình con phải chết theo');

  // 3. bin không có → không treo, có spawnError
  const r3 = await runEngine({ bin: '/khong/co/python3', args: [], cwd: __dirname }).done;
  assert.ok(r3.spawnError, 'phải báo spawnError');

  console.log('✓ rawcut-runner');
})().catch(e => { console.error(e); process.exit(1); });
