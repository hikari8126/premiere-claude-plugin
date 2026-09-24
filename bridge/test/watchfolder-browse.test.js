// bridge/test/watchfolder-browse.test.js
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { productRoot, listDirs } = require('../watchfolder-browse.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-br-'));
// SanPham/Project/abc.prproj  +  SanPham/Footage/Day1  +  SanPham/Voice Over
const SP = path.join(base, 'SanPham');
fs.mkdirSync(path.join(SP, 'Project'), { recursive: true });
fs.mkdirSync(path.join(SP, 'Footage', 'Day1'), { recursive: true });
fs.mkdirSync(path.join(SP, 'Voice Over'), { recursive: true });
fs.mkdirSync(path.join(SP, '.hidden'), { recursive: true });
fs.writeFileSync(path.join(SP, 'Project', 'abc.prproj'), 'x');
fs.writeFileSync(path.join(SP, 'doc.txt'), 'x');

// 1. Root sản phẩm = cấp CHA của thư mục chứa .prproj
assert.strictEqual(productRoot(path.join(SP, 'Project', 'abc.prproj')), SP,
  'root = cha của thư mục chứa .prproj');

// 2. .prproj nằm ngay ổ gốc thì không leo lên quá đà
assert.ok(productRoot('/abc.prproj'), 'không ném khi .prproj ở gốc');

// 3. listDirs chỉ trả THƯ MỤC, bỏ file và thư mục ẩn
const r = listDirs(SP);
assert.strictEqual(r.ok, true);
const names = r.dirs.map(d => d.name).sort();
assert.deepStrictEqual(names, ['Footage', 'Project', 'Voice Over'],
  'chỉ thư mục, không có doc.txt và .hidden: ' + JSON.stringify(names));

// 4. Mỗi mục kèm path tuyệt đối + có thư mục con hay không (để vẽ mũi tên gập)
const footage = r.dirs.find(d => d.name === 'Footage');
assert.strictEqual(footage.path, path.join(SP, 'Footage'), 'path tuyệt đối');
assert.strictEqual(footage.hasChildren, true, 'Footage có Day1 bên trong');
assert.strictEqual(r.dirs.find(d => d.name === 'Voice Over').hasChildren, false,
  'thư mục rỗng thì không có mũi tên');

// 5. Sắp xếp tự nhiên: 2x trước 10x
const NAT = path.join(base, 'nat');
['1x', '2x', '10x', '11x'].forEach(n => fs.mkdirSync(path.join(NAT, n), { recursive: true }));
assert.deepStrictEqual(listDirs(NAT).dirs.map(d => d.name), ['1x', '2x', '10x', '11x'],
  'sort tự nhiên chứ không theo chữ cái');

// 6. Thư mục không tồn tại → ok:false, không ném
assert.strictEqual(listDirs(path.join(base, 'khong-co')).ok, false, 'thư mục mất → ok:false');

// 7. Đường dẫn rỗng → ok:false chứ không liệt kê ổ đĩa
assert.strictEqual(listDirs('').ok, false, 'path rỗng bị từ chối');

fs.rmSync(base, { recursive: true, force: true });
console.log('watchfolder-browse: OK');

// guessBin: ghép thư mục ↔ bin theo tên, không cần model.
{
  const { guessBin } = require('../watchfolder-browse.js');
  const bins = ['Sources', 'Sources/Borrow', 'Voice Over/1x', 'Old/Higg', 'Footage/Higg'];
  // 1. Trùng tên lá → bin nông nhất trong số trùng tên
  assert.strictEqual(guessBin('Sources/Higg', bins).binPath, 'Old/Higg');
  // 2. Không có bin tên "Higg" → rơi về bin trùng thư mục cha
  assert.strictEqual(guessBin('Sources/Higg', ['Sources', 'Voice Over']).binPath, 'Sources');
  // 3. Không chắc → null, để model / người dùng quyết
  assert.strictEqual(guessBin('Random/Stuff', ['Sources', 'Voice Over']), null);
  // 4. Không phân biệt hoa thường / gạch dưới
  assert.strictEqual(guessBin('Voice_Over', ['voice over']).binPath, 'voice over');
  console.log('watchfolder-browse guessBin: OK');
}
