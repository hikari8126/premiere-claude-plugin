// bridge/test/st-script.test.js — cờ Tạo Sub gắn với nội dung script (ST3).
const assert = require('assert');
const { stScriptSameSource } = require('../../plugin/st-script.js');

const orig = 'Mình đã thử rất nhiều loại kem\nnhưng chỉ có loại này\nlà thật sự hiệu quả với da mình';
// Sửa nhẹ: đổi 1 chữ, tách dòng → vẫn cùng script
assert.ok(stScriptSameSource(orig, 'Mình đã thử rất nhiều loại kem\nnhưng chỉ có\nloại này\nlà thật sự hiệu quả với da tôi'));
// Chỉ khác dấu câu / hoa thường
assert.ok(stScriptSameSource(orig, orig.toUpperCase() + '!!!'));
// Dán script khác hẳn → không còn là bản cũ
assert.ok(!stScriptSameSource(orig, 'Hôm nay trời đẹp quá\nđi chơi công viên thôi'));
// Xoá gần hết → không coi là cùng
assert.ok(!stScriptSameSource(orig, 'Mình đã thử'));
// Rỗng
assert.ok(!stScriptSameSource('', 'abc'));
assert.ok(!stScriptSameSource('abc', ''));
// NFD (macOS) vs NFC
assert.ok(stScriptSameSource('diễn tả cảm xúc'.normalize('NFD'), 'diễn tả cảm xúc'));

console.log('st-script: OK');
