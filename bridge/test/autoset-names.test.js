// bridge/test/autoset-names.test.js
const assert = require('assert');
const { renderTemplate, buildSetNames } = require('../autoset-names.js');

const cfg = {
  product: 'SonaShape',
  co: 'ha.ttdo',
  editor: 'hoang.vietnguyen',
  seqNameTpl: '{sp} vid{set}.{idx} [c.{CO}] [{Editor}]',
  seqBinTpl:  'Sequence / FB / {set}x',
  voiceBinTpl:'voice over / {set}x',
};

// 1. renderTemplate thay đúng biến, giữ nguyên ký tự thật (ngoặc vuông, dấu cách, 'c.')
assert.strictEqual(
  renderTemplate(cfg.seqNameTpl, { sp: cfg.product, set: 31, idx: 0, CO: cfg.co, Editor: cfg.editor }),
  'SonaShape vid31.0 [c.ha.ttdo] [hoang.vietnguyen]',
  'tên sequence đúng từng ký tự'
);

// 2. biến không có giá trị → ném, KHÔNG để lọt '{sp}' vào tên file
assert.throws(
  () => renderTemplate('{sp} vid{set}.{idx}', { set: 1, idx: 0 }),
  /sp/,
  'thiếu biến thì phải ném, không đặt tên sai'
);

// 3. buildSetNames trả đủ 3 job
const out = buildSetNames(cfg, 31, 'mp3', 'Advertising Voice 2');
assert.strictEqual(out.length, 3, 'đúng 3 job');
assert.deepStrictEqual(out.map(j => j.idx), [0, 1, 2], 'idx 0,1,2');
assert.strictEqual(out[0].seqName, 'SonaShape vid31.0 [c.ha.ttdo] [hoang.vietnguyen]');
assert.strictEqual(out[2].seqName, 'SonaShape vid31.2 [c.ha.ttdo] [hoang.vietnguyen]');
assert.strictEqual(out[0].seqBin, 'Sequence / FB / 31x', 'bin sequence lồng cấp');
assert.strictEqual(out[1].voiceBin, 'voice over / 31x', 'bin voice');
assert.strictEqual(out[1].voiceFile, '31.1 - Advertising Voice 2.mp3', 'tên file voice có tên voice');
assert.strictEqual(out[0].voiceSubdir, '31x', 'thư mục con theo bộ');

// 4. số bộ dạng chuỗi vẫn chạy (ô input trả string)
assert.strictEqual(buildSetNames(cfg, '31', 'mp3', 'Evelyn3')[0].voiceFile, '31.0 - Evelyn3.mp3', 'set dạng string');

// 5. số bộ không hợp lệ → ném
assert.throws(() => buildSetNames(cfg, '', 'mp3', 'V'), /số bộ/i, 'set rỗng bị chặn');
assert.throws(() => buildSetNames(cfg, 'abc', 'mp3', 'V'), /số bộ/i, 'set không phải số bị chặn');

// 5b. tên voice có ký tự không hợp lệ cho tên file → làm sạch, không ném
assert.strictEqual(buildSetNames(cfg, 31, 'mp3', 'A/B:C')[0].voiceFile, '31.0 - A-B-C.mp3', 'ký tự / và : bị thay');
assert.throws(() => buildSetNames(cfg, 31, 'mp3', ''), /tên voice/i, 'thiếu tên voice bị chặn');

// 6. đuôi file đổi được
assert.strictEqual(buildSetNames(cfg, 31, 'wav', 'Evelyn3')[0].voiceFile, '31.0 - Evelyn3.wav', 'đuôi wav');

console.log('OK autoset-names');
