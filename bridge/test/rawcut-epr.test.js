// bridge/test/rawcut-epr.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../rawcut-epr.js');

// block có value ĐỨNG TRƯỚC identifier (kiểu làm hỏng bản tìm xuôi cũ)
const blk = (id, val, max) => '<ExporterParam Index="0" ObjectID="1" ClassID="c" Version="1">\n<ParamValue>' + val + '</ParamValue>\n'
  + (max ? '<ParamMaxValue>' + max + '</ParamMaxValue>\n' : '') + '<ParamIdentifier>' + id + '</ParamIdentifier>\n</ExporterParam>\n';
// block value đứng sau identifier
const blk2 = (id, val) => '<ExporterParam Index="0" ObjectID="2" ClassID="c" Version="1">\n<ParamIdentifier>' + id + '</ParamIdentifier>\n<ParamValue>' + val + '</ParamValue>\n</ExporterParam>\n';
const noVal = id => '<ExporterParam Index="0" ObjectID="3" ClassID="c" Version="1">\n<ParamIdentifier>' + id + '</ParamIdentifier>\n</ExporterParam>\n';
const wrap = s => '<ExporterParamContainer ObjectID="9">\n' + s + '</ExporterParamContainer>';
const XML = wrap(blk('ADBEVideoTargetBitrate', '10.', '50.') + blk('ADBEVideoMaxBitrate', '12.', '50.')
  + blk2('ADBEVideoMinBitrate', '1.') + blk2('ADBEVideoBitrateEncoding', '2'));

assert.strictEqual(E.readEprParam(XML, 'ADBEVideoMaxBitrate'), '12.');
assert.strictEqual(E.readEprParam(XML, 'ADBEVideoMinBitrate'), '1.');
assert.strictEqual(E.eprLimit(XML, 'ADBEVideoTargetBitrate', 'ParamMaxValue'), 50);
assert.strictEqual(E.eprLimit(XML, 'ADBEVideoMinBitrate', 'ParamMaxValue'), 0);
// identifier không có value riêng → null, không với sang block kế bên
assert.strictEqual(E.readEprParam(wrap(noVal('ADBEOnlyId') + blk2('Other', '7')), 'ADBEOnlyId'), null);
assert.strictEqual(E.patchEprParam(XML, 'NoSuch', '1'), null);
assert.strictEqual(E.eprNumber(10), '10.');
assert.strictEqual(E.eprNumber(41.666), '41.7');

assert.deepStrictEqual(E.planBitrate(20, XML), { target: 20, max: 24, min: 2, capped: false });
const cap = E.planBitrate(50, XML);
assert.strictEqual(cap.max, 50);
assert.strictEqual(E.eprNumber(cap.target), '41.7');
assert.strictEqual(cap.capped, true);

// ghi file + đọc lại
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-epr-'));
const base = path.join(tmp, 'base.epr');
fs.writeFileSync(base, XML);
let w = E.writeRenderPreset({ destDir: path.join(tmp, 'out'), mbps: 20, basePath: base });
assert.strictEqual(w.ok, true, w.error);
const back = fs.readFileSync(w.path, 'utf8');
assert.strictEqual(E.readEprParam(back, 'ADBEVideoTargetBitrate'), '20.');
assert.strictEqual(E.readEprParam(back, 'ADBEVideoMaxBitrate'), '24.');
assert.strictEqual(E.readEprParam(back, 'ADBEVideoMinBitrate'), '2.');
assert.strictEqual(E.readEprParam(back, 'ADBEVideoBitrateEncoding'), '2', 'pass mode giữ nguyên');

// preset thiếu tham số → từ chối, nêu tên
fs.writeFileSync(base, wrap(blk('ADBEVideoTargetBitrate', '10.') + blk('ADBEVideoMaxBitrate', '12.')));
w = E.writeRenderPreset({ destDir: tmp, mbps: 20, basePath: base });
assert.strictEqual(w.ok, false);
assert.ok(/ADBEVideoMinBitrate/.test(w.error), w.error);

// tìm preset trong cây /Applications giả: Premiere mới nhất trước
const apps = path.join(tmp, 'Applications');
const sub = (top, app) => path.join(apps, top, app, 'Contents', 'MediaIO', 'systempresets', '4E49434B_48323634');
fs.mkdirSync(sub('Adobe Premiere Pro 2026', 'Adobe Premiere Pro 2026.app'), { recursive: true });
fs.mkdirSync(sub('Adobe Premiere Pro 2025', 'Adobe Premiere Pro 2025.app'), { recursive: true });
fs.writeFileSync(path.join(sub('Adobe Premiere Pro 2026', 'Adobe Premiere Pro 2026.app'), '01 - Match Source - High bitrate.epr'), XML);
fs.writeFileSync(path.join(sub('Adobe Premiere Pro 2025', 'Adobe Premiere Pro 2025.app'), '00 - Match Source - High bitrate.epr'), XML);
const f = E.findStockPreset({ appsDir: apps });
assert.ok(f.found.includes('Premiere Pro 2026') && f.found.endsWith('01 - Match Source - High bitrate.epr'), f.found);
assert.strictEqual(E.findStockPreset({ appsDir: path.join(tmp, 'trong') }).found, '');

// máy thật (nếu có Premiere)
const real = E.findStockPreset();
if (real.found) {
  const rw = E.writeRenderPreset({ destDir: tmp, mbps: 20, basePath: real.found });
  assert.strictEqual(rw.ok, true, rw.error);
  console.log('  preset thật:', real.name, '→ pass', rw.pass);
}
console.log('✓ rawcut-epr');
