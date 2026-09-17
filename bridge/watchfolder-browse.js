// bridge/watchfolder-browse.js
// Duyệt thư mục cho bảng chọn "Thư mục" của tab Watch.
//
// Vì sao cần: UXP getFolder() chỉ nhận initialDomain (Documents/Desktop…), KHÔNG
// nhận đường dẫn cụ thể — không ép được hộp thoại hệ thống mở sẵn ở thư mục
// project. Mà plugin cũng không cần tự đọc thư mục: chỉ bridge mới quét file.
// Nên bridge liệt kê thư mục, plugin vẽ cây.

const fs   = require('fs');
const path = require('path');

// Root sản phẩm = CẤP CHA của thư mục chứa .prproj, hợp với bố cục quen thuộc:
//   SanPham/Project/abc.prproj   +   SanPham/Footage   +   SanPham/Voice Over
function productRoot(projectPath) {
  const dir = path.dirname(String(projectPath || ''));
  const up  = path.dirname(dir);
  // .prproj nằm ngay ổ gốc thì dirname trả về chính nó — đừng leo lên nữa.
  return (up && up !== dir) ? up : dir;
}

// So sánh tự nhiên: "2x" trước "10x". Thư mục bộ số của user luôn kiểu này.
function natCmp(a, b) {
  const re = /(\d+)|(\D+)/g;
  const as = String(a).toLowerCase().match(re) || [];
  const bs = String(b).toLowerCase().match(re) || [];
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i], y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d/.test(x), ny = /^\d/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d < 0 ? -1 : 1; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function hasSubdir(abs) {
  try {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.')) return true;
    }
  } catch (e) { /* không đọc được thì coi như không có con */ }
  return false;
}

function listDirs(dirPath) {
  const p = String(dirPath || '');
  if (!p) return { ok: false, error: 'thiếu đường dẫn', dirs: [] };
  let entries;
  try { entries = fs.readdirSync(p, { withFileTypes: true }); }
  catch (e) { return { ok: false, error: e.code || e.message, dirs: [] }; }

  const dirs = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => {
      const abs = path.join(p, e.name);
      return { name: e.name, path: abs, hasChildren: hasSubdir(abs) };
    })
    .sort((a, b) => natCmp(a.name, b.name));

  return { ok: true, path: p, parent: path.dirname(p), dirs };
}

module.exports = { productRoot, listDirs, natCmp };
