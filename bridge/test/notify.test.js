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

console.log('OK buildNotifyScript');
