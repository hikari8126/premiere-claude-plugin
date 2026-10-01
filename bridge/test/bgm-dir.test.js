// bridge/test/bgm-dir.test.js — tìm thư mục <sản phẩm>/BGM/AI cho nhạc gen bằng AI.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveBgmDir } = require('../bgm-dir.js');

function tree(dirs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bgmdir-'));
  ['Project'].concat(dirs).forEach(d => fs.mkdirSync(path.join(root, d), { recursive: true }));
  return { root, prproj: path.join(root, 'Project', 'abc.prproj') };
}
const real = p => fs.realpathSync(p);

// 1. BGM/AI có sẵn
let t = tree(['BGM/AI', 'Footage']);
let r = resolveBgmDir(t.prproj);
assert.strictEqual(real(r.dir), real(path.join(t.root, 'BGM', 'AI')));
assert.ok(r.bgmFound && r.aiFound);

// 2. Alias + hoa thường: "BGMs/ai"
t = tree(['BGMs/ai']);
r = resolveBgmDir(t.prproj);
assert.strictEqual(real(r.dir), real(path.join(t.root, 'BGMs', 'ai')));

// 3. Có BGM nhưng chưa có AI → trỏ BGM/AI (chưa tạo)
t = tree(['bgm/Old']);
r = resolveBgmDir(t.prproj);
assert.strictEqual(r.dir, path.join(t.root, 'bgm', 'AI'));
assert.ok(r.bgmFound && !r.aiFound);
assert.ok(!fs.existsSync(r.dir), 'không được tự tạo thư mục');

// 4. Không có gì → <root>/BGM/AI
t = tree(['Footage', 'Voice Over']);
r = resolveBgmDir(t.prproj);
assert.strictEqual(r.dir, path.join(t.root, 'BGM', 'AI'));
assert.ok(!r.bgmFound && !r.aiFound);

// 5. Tên tiếng Việt tách dấu (NFD như macOS) + alias AI khác
t = tree(['Nhạc nền'.normalize('NFD') + '/AI BGM']);
r = resolveBgmDir(t.prproj);
assert.ok(r.bgmFound && r.aiFound, 'nhận "Nhạc nền/AI BGM"');

// 6. Lồng một cấp: Audio/BGM/AI
t = tree(['Audio/BGM/AI']);
r = resolveBgmDir(t.prproj);
assert.strictEqual(real(r.dir), real(path.join(t.root, 'Audio', 'BGM', 'AI')));

// 7. Có cả BGM và Music → BGM thắng
t = tree(['Music/AI', 'BGM/AI']);
r = resolveBgmDir(t.prproj);
assert.strictEqual(real(r.dir), real(path.join(t.root, 'BGM', 'AI')));

// 8. projectPath rỗng / tương đối → lỗi rõ ràng
assert.throws(() => resolveBgmDir(''), /projectPath/);
assert.throws(() => resolveBgmDir('abc.prproj'), /projectPath/);

console.log('bgm-dir: 8/8 OK');
