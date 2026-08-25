// bridge/test/autoset-names.test.js
const assert = require('assert');
const { renderTemplate, buildSetNames, findVoiceOverDir } = require('../autoset-names.js');

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

// 7. tên voice kết thúc bằng dấu chấm → xóa chấm thừa, không để thành ".."
assert.strictEqual(buildSetNames(cfg, 31, 'mp3', 'Advertising Voice 2.')[0].voiceFile, '31.0 - Advertising Voice 2.mp3', 'xóa dấu chấm ở cuối');

// 8. tên voice kết thúc bằng khoảng trắng → xóa đi, không để thành "Voice  ."
assert.strictEqual(buildSetNames(cfg, 31, 'mp3', 'Advertising Voice 2  ')[0].voiceFile, '31.0 - Advertising Voice 2.mp3', 'xóa khoảng trắng ở cuối');

// 9. tên voice chỉ có khoảng trắng/dấu chấm (". .") → ném thiếu tên voice
assert.throws(() => buildSetNames(cfg, 31, 'mp3', '. .'), /tên voice/i, 'chỉ dấu chấm/khoảng trắng → ném');

// 10. khoảng trắng BÊN TRONG được giữ nguyên ("Advertising Voice 2" vẫn có khoảng trắng)
assert.strictEqual(buildSetNames(cfg, 31, 'mp3', 'Advertising Voice 2')[0].voiceFile, '31.0 - Advertising Voice 2.mp3', 'giữ khoảng trắng bên trong');

// 11. số bộ có leading zeros → bỏ zeros, "031" thành "31"
const out031 = buildSetNames(cfg, '031', 'mp3', 'Evelyn3');
assert.strictEqual(out031[0].seqName, 'SonaShape vid31.0 [c.ha.ttdo] [hoang.vietnguyen]', 'leading zeros loại bỏ trong tên sequence');
assert.strictEqual(out031[0].voiceSubdir, '31x', 'leading zeros loại bỏ trong thư mục');
assert.strictEqual(out031[0].voiceFile, '31.0 - Evelyn3.mp3', 'leading zeros loại bỏ trong tên file');

// 12. số 0 không bị xóa ("0" vẫn là "0", không thành rỗng)
assert.strictEqual(buildSetNames(cfg, '0', 'mp3', 'Evelyn3')[0].voiceSubdir, '0x', 'số 0 được giữ lại');

// 13. biến được dùng 2 lần trong mẫu ({sp}-{sp})
assert.strictEqual(renderTemplate('{sp}-{sp}', { sp: 'X' }), 'X-X', 'biến dùng 2 lần được thay đúng');

// 14. số bộ dài (>16 chữ số) giữ nguyên byte-for-byte, không rơi vào ký hiệu khoa học
const outLong = buildSetNames(cfg, '9999999999999999999999', 'mp3', 'V');
assert.strictEqual(outLong[0].voiceSubdir, '9999999999999999999999x', 'số bộ dài được giữ nguyên');

// 15. tên sequence chứa đầy đủ các chữ số (không rút gọn hay ký hiệu khoa học)
assert.ok(outLong[0].seqName.includes('vid9999999999999999999999.0'), 'seqName chứa số bộ dài đầy đủ');

// 16. voiceSubdir không chứa ký hiệu khoa học "e+"
assert.ok(!outLong[0].voiceSubdir.includes('e+'), 'không rơi vào ký hiệu khoa học');

// 17. regression: "031" vẫn normalize thành "31x"
assert.strictEqual(buildSetNames(cfg, '031', 'mp3', 'V')[0].voiceSubdir, '31x', 'regression 031 → 31x');

// 18. regression: "0" vẫn được giữ lại thành "0x"
assert.strictEqual(buildSetNames(cfg, '0', 'mp3', 'V')[0].voiceSubdir, '0x', 'regression 0 → 0x');

// 19. findVoiceOverDir: khớp chính xác
assert.strictEqual(findVoiceOverDir(['Images', 'Voice Over', 'Videos']), 'Voice Over', 'khớp chính xác Voice Over');

// 20. findVoiceOverDir: chữ thường
assert.strictEqual(findVoiceOverDir(['voice over']), 'voice over', 'khớp chữ thường, trả nguyên tên trên đĩa');

// 21. findVoiceOverDir: không có khoảng trắng
assert.strictEqual(findVoiceOverDir(['VoiceOver']), 'VoiceOver', 'khớp VoiceOver liền');

// 22. findVoiceOverDir: dạng viết tắt "vo"
assert.strictEqual(findVoiceOverDir(['vo']), 'vo', 'khớp dạng viết tắt vo');

// 23. findVoiceOverDir: không khớp trả null
assert.strictEqual(findVoiceOverDir(['Voices']), null, '"Voices" không khớp');
assert.strictEqual(findVoiceOverDir(['Video']), null, '"Video" không khớp');
assert.strictEqual(findVoiceOverDir(['Voice Overs']), null, '"Voice Overs" không được khớp nhầm');

// 24. findVoiceOverDir: input rỗng/thiếu không được ném lỗi
assert.strictEqual(findVoiceOverDir([]), null, 'mảng rỗng trả null');
assert.strictEqual(findVoiceOverDir(), null, 'không truyền tham số trả null, không ném lỗi');

// 25. findVoiceOverDir: khớp đầu tiên thắng
assert.strictEqual(findVoiceOverDir(['vo', 'Voice Over']), 'vo', 'ứng viên đầu tiên thắng');

// 26. findVoiceOverDir: chấp nhận khoảng trắng bao quanh, trả nguyên tên trên đĩa
assert.strictEqual(findVoiceOverDir([' Voice Over ']), ' Voice Over ', 'giữ nguyên tên có khoảng trắng bao quanh');

console.log('OK autoset-names');
