// bridge/test/watchfolder-find.test.js
// Tìm file cho source Autocut báo thiếu: khớp chuẩn hoá chính xác trước, gõ sai
// vài ký tự vẫn bắt được, gom theo thư mục để còn đề xuất watch.
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { findSources } = require('../watchfolder-find.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-find-'));
const mk = (rel, body) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body || 'x');
};

mk('Footage/A Roll/canh-quay-mo-dau.mp4');
mk('Footage/A Roll/ghi chu.txt');                 // không phải media
mk('Footage/B Roll/close_up_san_pham.mov');
mk('Footage/B Roll/.DS_Store');
mk('Voice Over/1x/vo-01.wav');
mk('Footage/Adobe Premiere Pro Auto-Save/canh-quay-mo-dau.mp4');   // rác Premiere
// Quy ước thật của team: "Higg 33" = clip 33 trong thư mục Higg.
mk('Sources/Higg/33.mp4');
mk('Sources/Higg/Higg1_11-12s.mp4');
mk('Sources/Borrow/b33.MOV');

// 1. Khớp chuẩn hoá: dấu gạch/chấm và đuôi file không cản.
let r = findSources(root, ['Canh quay mo dau', 'Close Up San Pham', 'khong-co-that']);
assert.strictEqual(r.ok, true);
assert.deepStrictEqual(r.unmatched, ['khong-co-that'], 'báo đúng tên không tìm thấy');

const folders = r.folders.map(f => f.rel).sort();
assert.deepStrictEqual(folders, ['Footage/A Roll', 'Footage/B Roll'].sort(),
  'gom theo thư mục thật: ' + JSON.stringify(folders));

const aRoll = r.folders.find(f => f.rel === 'Footage/A Roll');
assert.strictEqual(aRoll.matches.length, 1, 'file .txt không lọt vào');
assert.strictEqual(aRoll.matches[0].exact, true);
assert.strictEqual(aRoll.matches[0].name, 'Canh quay mo dau', 'giữ tên source gốc');

// 2. Thư mục auto-save của Premiere bị bỏ, dù tên file khớp y hệt.
assert.ok(!r.folders.some(f => /Auto-Save/i.test(f.rel)), 'bỏ thư mục Premiere tự sinh');

// 3. Gõ sai 1 ký tự trên tên đủ dài → vẫn bắt, nhưng đánh dấu không exact.
r = findSources(root, ['canh quay mo dao']);
assert.strictEqual(r.folders.length, 1, 'bắt được tên gõ sai');
assert.strictEqual(r.folders[0].matches[0].exact, false);
assert.strictEqual(r.folders[0].matches[0].dist, 1);

// 4. Số là định danh — "vo 01" vs "vo 02" là hai file khác nhau, không fuzzy.
r = findSources(root, ['vo-02']);
assert.deepStrictEqual(r.unmatched, ['vo-02'], 'không khớp bừa file tên gần giống');

// 5. Tên khớp chính xác vẫn chạy bình thường với tên ngắn.
r = findSources(root, ['vo-01']);
assert.strictEqual(r.folders.length, 1);
assert.ok(/Voice Over\/1x/.test(r.folders[0].rel));

// 6. Thư mục + clip (lượt 3): "Higg 33" → Sources/Higg/33.mp4, KHÔNG phải b33.
r = findSources(root, ['Higg 33']);
assert.deepStrictEqual(r.unmatched, [], 'bắt được kiểu tên thư mục + clip');
assert.strictEqual(r.folders.length, 1, JSON.stringify(r.folders));
assert.strictEqual(r.folders[0].matches[0].fileName, '33.mp4');
assert.strictEqual(r.folders[0].matches[0].pass, 3);
assert.strictEqual(r.folders[0].matches[0].exact, true, 'khớp theo luật → tick sẵn');
assert.strictEqual(r.folders[0].needsFolderBin, true,
  'bin đích phải mang tên thư mục, không thì validate không nhận');

// 7. Tiền tố + ranh giới (lượt 2): "Higg1" → Higg1_11-12s.mp4
r = findSources(root, ['Higg1']);
assert.strictEqual(r.folders[0].matches[0].fileName, 'Higg1_11-12s.mp4');
assert.strictEqual(r.folders[0].matches[0].pass, 2);

// 8. Báo số file đã quét — để người dùng thấy là có quét thật.
assert.ok(r.scannedFiles >= 6, 'scannedFiles: ' + r.scannedFiles);

fs.rmSync(root, { recursive: true, force: true });
console.log('watchfolder-find: OK');
