// bridge/test/watchfolder-scannow.test.js
// "Quét ngay" = đối chiếu: đẩy vào hàng đợi những file ĐÃ nằm sẵn trong thư mục
// (đã thấy ở lượt quét trước, tức không phải đang ghi dở) để plugin so với
// project và import cái nào còn thiếu.
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { createEngine } = require('../watchfolder.js');
const store = require('../watchfolder-store.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-sn-'));
store.setDir(dir);

const PROJ = '/Users/x/P.prproj';
const W = {
  id: 'w_1', enabled: true, label: 'D', folder: '/watched', binPath: 'Footage',
  recursive: true, maxDepth: 3, mirrorSubfolders: true,
  include: ['video'], includeRegex: '', excludeRegex: '',
  intervalMs: 3000, stableChecks: 2,
};

let fake = { ok: true, files: { 'co-san.mp4': [10, 1], 'nhac.wav': [10, 1] }, truncated: false };
const scan = () => JSON.parse(JSON.stringify(fake));
let clock = 0;
const engine = createEngine({ scan, now: () => clock, store });

store.writeConfig(PROJ, [W]);
engine.start(PROJ);
engine.tick();                       // baseline: co-san.mp4 vào snapshot, không import

assert.deepStrictEqual(engine.poll(20).items, [], 'quét thường bỏ qua file có sẵn');

// 1. Quét ngay → file có sẵn được đẩy vào hàng đợi để plugin đối chiếu
const r = engine.scanNow('w_1');
assert.strictEqual(r.ok, true);
let items = engine.poll(20).items;
assert.strictEqual(items.length, 1, 'chỉ 1 file (wav bị preset loại): ' + JSON.stringify(items));
assert.ok(/co-san\.mp4/.test(items[0].filePath), 'đúng file có sẵn');
assert.strictEqual(r.queued, 1, 'trả về số file vừa đẩy vào hàng đợi');

// 2. Bấm lần nữa không nhân đôi hàng đợi
engine.scanNow('w_1');
assert.strictEqual(engine.poll(20).items.length, 1, 'không đẩy trùng file đang chờ');

// 3. File mới toanh (chưa từng thấy) KHÔNG bị quét ngay tóm ngay lập tức —
//    có thể đang render dở; nó vẫn phải đi qua đường ổn định như thường.
fake.files['dang-ghi.mp4'] = [50, 9];
engine.scanNow('w_1');
assert.ok(!engine.poll(20).items.some(i => /dang-ghi/.test(i.filePath)),
  'file chưa từng thấy không bị quét ngay đẩy vào ngay');

// 4. Sau khi nó ổn định qua các lượt quét thường thì vào hàng đợi như bình thường
engine.tick(); engine.tick();
assert.ok(engine.poll(20).items.some(i => /dang-ghi/.test(i.filePath)),
  'ổn định rồi thì vào hàng đợi');

// 4b. preview: chỉ liệt kê, KHÔNG đụng vào hàng đợi — plugin cần vậy để hỏi
//     người dùng trước khi import.
const before = engine.poll(50).items.length;
const pv = engine.scanNow('w_1', { preview: true });
assert.strictEqual(pv.ok, true);
assert.strictEqual(pv.preview, true, 'đánh dấu là preview để plugin biết bridge đủ mới');
assert.ok(pv.files.length >= 1, 'liệt kê file khớp lọc: ' + JSON.stringify(pv.files));
assert.ok(pv.files.every(f => /\.mp4$/.test(f.filePath)), 'wav bị preset loại');
assert.ok(pv.files.every(f => typeof f.binPath === 'string' && f.binPath),
  'mỗi file kèm bin đích');
assert.strictEqual(engine.poll(50).items.length, before, 'preview không đẩy vào hàng đợi');

// 5. Quét ngay với watch tắt → không làm gì, không ném
store.writeConfig(PROJ, [{ ...W, enabled: false }]);
const e2 = createEngine({ scan, now: () => clock, store });
e2.start(PROJ);
const off = e2.scanNow('w_1');
assert.strictEqual(off.ok, false, 'watch tắt → báo không chạy');

fs.rmSync(dir, { recursive: true, force: true });
console.log('watchfolder-scannow: OK');
