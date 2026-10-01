// bridge/test/rawcut-engine.test.js — engine vendored chạy được với python máy này
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { findPython } = require('../rawcut-python.js');

const ENGINE = path.join(__dirname, '..', 'rawcut-engine', 'xmlcut.py');
assert.ok(fs.existsSync(ENGINE), 'thiếu ' + ENGINE);
assert.ok(/^VERSION = "3\.93"$/m.test(fs.readFileSync(ENGINE, 'utf8').slice(0, 20000)), 'engine phải là 3.93');

const py = findPython();
if (!py.ok) { console.log('⏭  bỏ qua chạy engine (không có python3 ≥3.8)'); process.exit(0); }
const r = spawnSync(py.bin, [ENGINE, '--help'], { encoding: 'utf8', timeout: 20000 });
assert.strictEqual(r.status, 0, r.stderr);
for (const flag of ['--panel', '--render-dir', '--render-planned', '--pick', '--manifest-only', '--video-track'])
  assert.ok(r.stdout.includes(flag), '--help thiếu ' + flag);
console.log('✓ rawcut-engine (' + py.bin + ' ' + py.version + ')');
