// bridge/test/watchfolder-engine.test.js
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { createEngine } = require('../watchfolder.js');
const store = require('../watchfolder-store.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-eng-'));
store.setDir(dir);

const PROJ = '/Users/x/Series_A.prproj';
const W = {
  id: 'w_1', enabled: true, label: 'Drone', folder: '/watched', binPath: 'Footage/Drone',
  recursive: true, maxDepth: 3, mirrorSubfolders: true,
  include: ['video'], includeRegex: '', excludeRegex: '',
  intervalMs: 3000, stableChecks: 2,
};

// Filesystem giả: test tự đặt nội dung mỗi lượt quét.
let fake = { ok: true, files: {}, truncated: false };
const scan = () => JSON.parse(JSON.stringify(fake));
let clock = 0;
const now = () => clock;

function newEngine() {
  return createEngine({ scan, now, store });
}

// ── 1. File có sẵn lúc tạo watch KHÔNG được import (Câu 3 = A) ────────────
fake = { ok: true, files: { 'old.mp4': [10, 1] }, truncated: false };
let eng = newEngine();
store.writeConfig(PROJ, [W]);
eng.start(PROJ);
eng.tick(); eng.tick(); eng.tick();
assert.deepStrictEqual(eng.poll(20).items, [], 'file có sẵn bị bỏ qua');

// ── 2. File mới chỉ vào queue sau khi ổn định qua stableChecks lượt ───────
fake.files['new.mp4'] = [100, 5];
eng.tick();
assert.deepStrictEqual(eng.poll(20).items, [], 'lượt đầu mới chỉ ghi nhận, chưa import');
fake.files['new.mp4'] = [200, 6];               // vẫn đang ghi
eng.tick();
assert.deepStrictEqual(eng.poll(20).items, [], 'size còn đổi thì chưa import');
fake.files['new.mp4'] = [200, 6];               // đứng yên
eng.tick();
let got = eng.poll(20).items;
assert.strictEqual(got.length, 1, 'ổn định rồi mới vào queue');
assert.strictEqual(got[0].filePath, path.join('/watched', 'new.mp4'), 'trả path tuyệt đối');
assert.strictEqual(got[0].binPath, 'Footage/Drone', 'kèm bin đích');
assert.strictEqual(got[0].watchId, 'w_1');

// ── 3. File 0 byte không bao giờ được coi là ổn định ──────────────────────
fake.files['empty.mp4'] = [0, 7];
eng.tick(); eng.tick(); eng.tick();
assert.ok(!eng.poll(20).items.some(i => /empty/.test(i.filePath)), 'file 0 byte bị hoãn');

// ── 4. ack done → biến khỏi queue và không quay lại ở lượt sau ────────────
const id = got[0].id;
eng.ack([id], []);
eng.tick();
assert.ok(!eng.poll(20).items.some(i => i.id === id), 'ack rồi thì không lặp lại');

// ── 5. ack failed → retry, quá 3 lần thì dead ────────────────────────────
fake.files['bad.mp4'] = [50, 9];
eng.tick(); eng.tick();
let bad = eng.poll(20).items.find(i => /bad\.mp4/.test(i.filePath));
assert.ok(bad, 'bad.mp4 vào queue');
for (let i = 0; i < 3; i++) {
  const cur = eng.poll(20).items.find(x => /bad\.mp4/.test(x.filePath));
  assert.ok(cur, 'lần thử ' + (i + 1) + ' vẫn còn trong queue');
  eng.ack([], [{ id: cur.id, reason: 'codec lạ' }]);
}
assert.ok(!eng.poll(20).items.some(i => /bad\.mp4/.test(i.filePath)),
  'quá 3 lần thất bại thì rời queue');
assert.ok(eng.stats().dead.some(d => /bad\.mp4/.test(d.filePath)), 'ghi nhận vào danh sách dead');

// ── 6. Thư mục biến mất → unavailable, quay lại KHÔNG import lại file cũ ──
fake = { ok: false, error: 'ENOENT', files: {}, truncated: false };
eng.tick();
assert.strictEqual(eng.stats().watches.find(w => w.id === 'w_1').status, 'unavailable',
  'mất thư mục → unavailable');
fake = { ok: true, files: { 'old.mp4': [10, 1], 'new.mp4': [200, 6] }, truncated: false };
eng.tick(); eng.tick(); eng.tick();
assert.deepStrictEqual(eng.poll(20).items, [],
  'thư mục quay lại không import lại file đã biết');

// ── 7. Quét bù sau khi stop/start: file rơi vào lúc panel đóng vẫn được import ──
eng.stop();
fake.files['while-closed.mp4'] = [77, 20];
const eng2 = newEngine();                       // bridge khởi động lại, đọc state từ đĩa
eng2.start(PROJ);
eng2.tick(); eng2.tick();
const caught = eng2.poll(20).items;
assert.strictEqual(caught.length, 1, 'đúng 1 file rơi lúc đóng');
assert.ok(/while-closed\.mp4/.test(caught[0].filePath), 'đúng file đó');

// ── 8. Interval thích ứng: lâu không có gì thì giãn ra ────────────────────
eng2.ack([caught[0].id], []);
assert.strictEqual(eng2.nextDelay(), 3000, 'vừa có file mới → giữ interval gốc');
clock += 121000;
eng2.tick();
assert.strictEqual(eng2.nextDelay(), 10000, 'hơn 2 phút không có gì → giãn lên 10s');

// ── 9. Thư mục quá lớn → tự hạ tần suất ──────────────────────────────────
fake.truncated = true;
eng2.tick();
assert.strictEqual(eng2.nextDelay(), 15000, 'vượt trần file → 15s');

// ── 10. Watch tắt thì không quét ─────────────────────────────────────────
fake = { ok: true, files: {}, truncated: false };
store.writeConfig(PROJ, [{ ...W, enabled: false }]);
const eng3 = newEngine();
eng3.start(PROJ);
fake.files['x.mp4'] = [10, 30];
eng3.tick(); eng3.tick(); eng3.tick();
assert.deepStrictEqual(eng3.poll(20).items, [], 'watch tắt thì bỏ qua hoàn toàn');

fs.rmSync(dir, { recursive: true, force: true });
console.log('watchfolder-engine: OK');
