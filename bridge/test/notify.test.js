// bridge/test/notify.test.js
const assert = require('assert');
const { buildNotifyScript } = require('../server.js');

// 1. dựng đúng lệnh osascript
const s = buildNotifyScript('Xong', 'Bộ 31 đã dựng');
assert.ok(s.includes('display notification'), 'có display notification');
assert.ok(s.includes('"Bộ 31 đã dựng"'), 'có body');
assert.ok(s.includes('with title "Xong"'), 'có title');

// 2. dấu " và \ trong nội dung phải được escape, không làm vỡ script
const s2 = buildNotifyScript('A"B', 'C\\D"E');
assert.ok(s2.includes('A\\"B'), 'escape dấu " trong title');
assert.ok(s2.includes('C\\\\D\\"E'), 'escape \\ và " trong body');

// 3. thiếu title → dùng mặc định, không ném
assert.ok(buildNotifyScript('', 'x').includes('with title "Claude AI"'), 'title mặc định');

// 4. cắt bớt nội dung quá dài (osascript giới hạn thực tế)
const long = 'x'.repeat(1000);
assert.ok(buildNotifyScript('t', long).length < 700, 'body bị cắt');

// 5. cắt đúng ranh giới: dấu \ nằm ngay tại điểm cắt không được để lại
// một dấu \ lẻ (số lẻ) ngay trước dấu " đóng — nếu không osascript vỡ script
const boundaryBackslash = 'a'.repeat(399) + '\\' + 'TAIL';
const s5 = buildNotifyScript('t', boundaryBackslash);
const bodyMatch5 = s5.match(/^display notification "([\s\S]*)" with title "t"$/);
assert.ok(bodyMatch5, 'script khớp mẫu display notification ... with title "t"');
const bodyPart5 = bodyMatch5[1];
const trailingBackslashes5 = (bodyPart5.match(/\\+$/) || [''])[0].length;
assert.ok(trailingBackslashes5 % 2 === 0, 'số dấu \\ ở cuối body phải chẵn (không vỡ script)');

// 6. cắt đúng ranh giới: dấu " nằm ngay tại điểm cắt phải được escape trọn vẹn
// thành \" chứ không bị cắt cụt thành một dấu \ trơ
const boundaryQuote = 'a'.repeat(399) + '"' + 'TAIL';
const s6 = buildNotifyScript('t', boundaryQuote);
const bodyMatch6 = s6.match(/^display notification "([\s\S]*)" with title "t"$/);
assert.ok(bodyMatch6, 'script khớp mẫu display notification ... with title "t"');
assert.ok(bodyMatch6[1].includes('\\"'), 'dấu " ở ranh giới cắt phải được escape nguyên vẹn thành \\"');

console.log('OK buildNotifyScript');
