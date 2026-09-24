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

// Đoán bin đích cho một thư mục trên đĩa CHỈ theo tên, không cần model.
// rel: đường dẫn thư mục tương đối ('Sources/Higg'); bins: ['A/B', ...].
//  1. Có bin mà tên LÁ trùng tên thư mục ("Higg")  → dùng luôn.
//  2. Có bin mà tên lá trùng thư mục CHA ("Sources") → dùng, plugin tự tạo bin
//     con "Higg" bên trong (source kiểu "Higg 33" cần bin lá mang tên đó).
// Không chắc thì trả null để model / người dùng quyết.
function guessBin(rel, bins) {
  const n = s => String(s || '').normalize('NFC').toLowerCase().replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = String(rel || '').split(/[\\/]/).filter(Boolean);
  if (!parts.length) return null;
  const leafOf = b => n(String(b).split('/').pop());
  const pick = want => {
    const hits = (bins || []).filter(b => leafOf(b) === want);
    // Nhiều bin cùng tên lá → chọn bin nông nhất (ít cấp nhất) cho dễ đoán.
    return hits.sort((a, b) => a.split('/').length - b.split('/').length)[0] || null;
  };
  const dir = n(parts[parts.length - 1]);
  let hit = pick(dir);
  if (hit) return { binPath: hit, reason: 'Bin "' + hit + '" trùng tên thư mục (ghép theo tên, không cần AI).' };
  if (parts.length > 1) {
    hit = pick(n(parts[parts.length - 2]));
    if (hit) return { binPath: hit, reason: 'Bin "' + hit + '" trùng thư mục cha (ghép theo tên, không cần AI).' };
  }
  return null;
}

module.exports = { productRoot, listDirs, natCmp, guessBin };
