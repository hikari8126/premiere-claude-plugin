// bridge/test/watchfolder-scan.test.js
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { scanFolder } = require('../watchfolder-scan.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-scan-'));
function put(rel, body) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

put('a.mp4', 'aaa');
put('sub/b.mp4', 'bb');
put('sub/deep/c.mp4', 'c');
put('sub/deep/deeper/d.mp4', 'd');

// 1. Không đệ quy → chỉ file ở cấp gốc
const flat = scanFolder(root, { recursive: false, maxDepth: 3 });
assert.strictEqual(flat.ok, true);
assert.deepStrictEqual(Object.keys(flat.files).sort(), ['a.mp4'], 'không đệ quy chỉ lấy cấp gốc');

// 2. Đệ quy maxDepth 2 → cắt ở sub/deep/c.mp4, không lấy deeper
const d2 = scanFolder(root, { recursive: true, maxDepth: 2 });
assert.deepStrictEqual(Object.keys(d2.files).sort(), ['a.mp4', 'sub/b.mp4'],
  'maxDepth 2 = tối đa 1 cấp thư mục con');

// 3. Đệ quy maxDepth 3
const d3 = scanFolder(root, { recursive: true, maxDepth: 3 });
assert.deepStrictEqual(Object.keys(d3.files).sort(),
  ['a.mp4', 'sub/b.mp4', 'sub/deep/c.mp4'], 'maxDepth 3');

// 4. Giá trị là [size, mtimeMs], relPath luôn dùng '/'
const st = fs.statSync(path.join(root, 'sub', 'b.mp4'));
assert.strictEqual(d3.files['sub/b.mp4'][0], st.size, 'lưu size');
assert.strictEqual(d3.files['sub/b.mp4'][1], Math.floor(st.mtimeMs), 'lưu mtime đã làm tròn');

// 5. Thư mục không tồn tại → ok:false, KHÔNG ném
const gone = scanFolder(path.join(root, 'khong-co'), { recursive: true, maxDepth: 3 });
assert.strictEqual(gone.ok, false, 'thư mục mất thì trả ok:false');
assert.ok(gone.error, 'có mô tả lỗi');

// 6. Vượt trần thì cắt và báo truncated, không phình bộ nhớ
const many = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-many-'));
for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(many, 'f' + i + '.mp4'), 'x');
const cap = scanFolder(many, { recursive: true, maxDepth: 3, maxFiles: 10 });
assert.strictEqual(Object.keys(cap.files).length, 10, 'cắt đúng trần');
assert.strictEqual(cap.truncated, true, 'báo truncated');

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(many, { recursive: true, force: true });
console.log('watchfolder-scan: OK');
