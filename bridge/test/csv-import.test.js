// bridge/test/csv-import.test.js
const assert = require('assert');
const { csvParse, csvRowsToSac } = require('../../plugin/csv-parse.js');

// CSV mẫu: ô có dấu phẩy trong ngoặc (scene2), xuống dòng trong ngoặc (scene1),
// "" -> " (scene4), và 1 dòng trắng cuối.
const csv = [
  'scene,content,text_overlay,effects,voice_over,visual,notes,shot_name,footage_name,shot_start,shot_end,footage_s3_uri',
  '1,,"Mom, look what I\'ve got!\nOh wow… Let me see",note,,,,Full length,K18-1 [mudsnhw5].mp4,0:00,0:04,s3://a',
  '2,,"Just grabbed 3 of these at 68% off... But they are not for me",,,,,Full length,K18-2 [mudsolno].mp4,0:00,0:06,s3://b',
  '4,,"It is ZoeShape \nThe only ""instant-snatch"" solution",,,,,Full length,K18-4 [mudsq04c].mp4,0:00,0:06,s3://c',
  ''
].join('\n');

const rows = csvParse(csv);
assert.strictEqual(rows.length, 4, 'header + 3 data (dòng trắng cuối bị bỏ)');
// dấu phẩy trong ngoặc không tách ô: scene2 vẫn đủ 12 cột
assert.strictEqual(rows[2].length, 12, 'scene2 đủ 12 cột (phẩy trong ngoặc)');

const map = csvRowsToSac(rows);
assert.strictEqual(map.error, null, 'không lỗi');
assert.strictEqual(map.rows.length, 3, '3 scene');
assert.strictEqual(map.rows[0].text, 'Mom, look what I\'ve got! Oh wow… Let me see', 'text gộp 1 dòng');
assert.strictEqual(map.rows[0].time, '0:00-0:04', 'time ghép start-end');
assert.strictEqual(map.rows[0].src, 'K18-1 [mudsnhw5]', 'source bỏ đuôi .mp4, giữ [id]');
assert.ok(map.rows[2].text.indexOf('"instant-snatch"') !== -1, '"" -> " literal');

// thiếu cột bắt buộc footage_name -> lỗi
const bad = csvRowsToSac(csvParse('text_overlay,shot_start\nhi,0:00'));
assert.ok(bad.error && bad.error.indexOf('footage_name') !== -1, 'thiếu footage_name -> lỗi');
assert.strictEqual(bad.rows.length, 0, 'lỗi thì không nạp dòng nào');

// thiếu shot_end -> time chỉ start
const noEnd = csvRowsToSac(csvParse('text_overlay,footage_name,shot_start\nhi,a.mp4,0:03'));
assert.strictEqual(noEnd.error, null);
assert.strictEqual(noEnd.rows[0].time, '0:03', 'không có shot_end -> chỉ start');

// bỏ đuôi video phổ biến, giữ [id]; tên không có đuôi thì giữ nguyên
const ext = csvRowsToSac(csvParse(
  'text_overlay,footage_name,shot_start\n' +
  'a,K18 [x].mov,0:00\n' +
  'b,ZoeShape V21.0 [muex9xq5].mp4,0:01\n' +
  'c,NoExt Clip [y],0:02'
));
assert.strictEqual(ext.rows[0].src, 'K18 [x]', 'bỏ .mov');
assert.strictEqual(ext.rows[1].src, 'ZoeShape V21.0 [muex9xq5]', 'giữ "V21.0" giữa tên, chỉ bỏ .mp4 cuối');
assert.strictEqual(ext.rows[2].src, 'NoExt Clip [y]', 'không có đuôi -> giữ nguyên');

console.log('csv-import tests passed');
