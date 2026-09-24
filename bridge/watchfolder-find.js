// bridge/watchfolder-find.js
// Tìm file trên đĩa cho những source mà Autocut validate báo THIẾU trong project.
//
// Vì sao ở bridge chứ không ở plugin: chỉ bridge mới đọc được đĩa. Plugin chỉ
// biết tên source trong cutsheet và cây bin của project.
//
// Chuẩn hoá tên phải GIỐNG HỆT sacNorm() bên plugin (main.js), nếu không thì
// "khớp" ở đây lại "không khớp" lúc validate lại — người dùng thấy import xong
// mà vẫn báo thiếu.

const path = require('path');
const { scanFolder } = require('./watchfolder-scan.js');
const { PRESETS, IGNORE_DIRS, IGNORE_EXT } = require('./watchfolder-rules.js');

const MEDIA_EXT = [].concat(PRESETS.video, PRESETS.audio, PRESETS.image);

// Bản sao của sacNorm() trong plugin/main.js — NFC trước (macOS lưu tên file
// dạng NFD, cutsheet dán vào thường NFC), bỏ đuôi, gạch/chấm → khoảng trắng.
function norm(s) {
  return String(s || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, '')
    .replace(/[-_.()[\]/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lev(a, b) {
  a = a || ''; b = b || '';
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = [], cur = [];
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur.slice();
  }
  return prev[n];
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

// Lọc thô trước khi so tên: bỏ file ẩn, thư mục Premiere tự sinh, file ghi dở,
// và mọi thứ không phải media. Cùng luật với matchFile() nhưng không cần watch.
function isMedia(rel) {
  const parts = String(rel).split('/');
  const name = parts[parts.length - 1];
  if (name.startsWith('.')) return false;
  for (const d of parts.slice(0, -1)) {
    if (d.startsWith('.')) return false;
    if (IGNORE_DIRS.indexOf(d.toLowerCase()) >= 0) return false;
  }
  const ext = extOf(name);
  if (IGNORE_EXT.indexOf(ext) >= 0) return false;
  return MEDIA_EXT.indexOf(ext) >= 0;
}

// Khớp một source với danh sách file trên đĩa — CHÉP LẠI 4 lượt của
// sacMatchBinItem() (plugin/main.js). Hai bên lệch nhau là hỏng cả tính năng:
// bridge "tìm thấy" mà import xong validate vẫn báo thiếu, hoặc ngược lại bridge
// báo không thấy trong khi validate sẽ nhận file đó.
//
// files: [{ rel, fileName, stem (norm, không đuôi), parent (norm tên thư mục chứa) }]
// Trả về { pass, hits: [{file, dist, hintFolder}] } của lượt ĐẦU TIÊN có kết quả.
function matchOne(target, files) {
  const t = norm(target);
  if (!t) return null;

  // Lượt 1: trùng tên chuẩn hoá.
  let hits = files.filter(f => f.stem === t).map(f => ({ file: f, dist: 0 }));
  if (hits.length) return { pass: 1, hits };

  // Lượt 2: tên file BẮT ĐẦU bằng source, sau đó là ký tự ranh giới.
  // "Higg1" ↔ "Higg1_11-12s.mp4".
  hits = files.filter(f => {
    if (f.stem.indexOf(t) !== 0) return false;
    const next = f.stem.charAt(t.length);
    return next === '' || /[\s._-]/.test(next);
  }).map(f => ({ file: f, dist: 0 }));
  if (hits.length) return { pass: 2, hits };

  // Lượt 3: thư mục + clip. Cutsheet "Higg 33" = clip "33" nằm trong thư mục có
  // tên CHỨA "higg" (Sources/Higg/33.mp4). Đây là quy ước đặt tên phổ biến nhất
  // của team, và chính là thứ bản đầu của find-sources bỏ sót.
  const toks = t.split(' ').filter(Boolean);
  for (let k = 1; k < toks.length; k++) {
    const folderPart = toks.slice(0, k).join(' ');
    const clipPart = toks.slice(k).join(' ');
    hits = files.filter(f => {
      if (!f.parent || f.parent.indexOf(folderPart) === -1) return false;
      const n = f.stem;
      return n === clipPart
        || (n.length > clipPart.length && n.slice(-(clipPart.length + 1)) === ' ' + clipPart)
        || (n.length > clipPart.length && n.indexOf(clipPart) === 0
            && /[\s._\-(]/.test(n.charAt(clipPart.length)));
    }).map(f => ({ file: f, dist: 0, hintFolder: folderPart }));
    if (hits.length) return { pass: 3, hits };
  }

  // Lượt 4: gõ sai. Số trong tên là ĐỊNH DANH nên dãy chữ số phải khớp tuyệt
  // đối; chỉ nhận ứng viên gần nhất DUY NHẤT, lệch ≤ 20% độ dài (tối đa 2).
  const digits = t.replace(/\D/g, '');
  const fuzzMax = Math.min(2, Math.floor(t.length * 0.2));
  if (fuzzMax < 1) return null;
  let best = null, bestD = Infinity, tie = false;
  for (const f of files) {
    if (f.stem.replace(/\D/g, '') !== digits) continue;
    if (Math.abs(f.stem.length - t.length) > fuzzMax) continue;
    const d = lev(t, f.stem);
    if (d < bestD) { bestD = d; best = f; tie = false; }
    else if (d === bestD) tie = true;
  }
  if (best && !tie && bestD <= fuzzMax) return { pass: 4, hits: [{ file: best, dist: bestD }] };
  return null;
}

// roots     — các thư mục gốc để quét (productRoot + thư mục các watch đang có)
// names     — tên source Autocut báo thiếu
// trả về    — { ok, root, roots, scannedFiles, folders: [{folder, rel, matches}], unmatched }
//             matches: { filePath, fileName, name, exact, pass, dist, hintFolder }
function findSources(root, names, opts) {
  const o = opts || {};
  const wanted = (names || []).filter(Boolean);
  if (!root) return { ok: false, error: 'thiếu thư mục gốc' };

  // Thư mục watch nằm TRONG root thì đã được quét rồi — bỏ để khỏi đếm trùng.
  const roots = [root];
  for (const r of (o.extraRoots || [])) {
    if (!r) continue;
    const inside = roots.some(x => r === x || r.indexOf(x + path.sep) === 0);
    if (!inside) roots.push(r);
  }

  const files = [];
  let truncated = false;
  for (const r of roots) {
    const res = scanFolder(r, {
      recursive: true,
      maxDepth: Math.max(1, Number(o.maxDepth) || 6),
      maxFiles: Number(o.maxFiles) || 20000,
    });
    if (!res.ok) {
      if (r === root) return { ok: false, error: res.error, root };
      continue;   // một thư mục watch hỏng (ổ ngoài rút ra) không chặn cả lượt
    }
    if (res.truncated) truncated = true;
    for (const rel of Object.keys(res.files)) {
      if (!isMedia(rel)) continue;
      const parts = rel.split('/');
      const fileName = parts[parts.length - 1];
      const abs = path.join(r, parts.join(path.sep));
      files.push({
        abs, root: r, fileName,
        stem: norm(fileName),
        parent: parts.length > 1 ? norm(parts[parts.length - 2]) : norm(path.basename(r)),
      });
    }
  }

  const byFolder = new Map();
  const hit = new Set();
  for (const name of wanted) {
    const m = matchOne(name, files);
    if (!m) continue;
    hit.add(name);
    for (const h of m.hits) {
      const folder = path.dirname(h.file.abs);
      if (!byFolder.has(folder)) byFolder.set(folder, { root: h.file.root, matches: [] });
      byFolder.get(folder).matches.push({
        filePath: h.file.abs, fileName: h.file.fileName, name,
        // Lượt 1–3 là khớp theo luật, validate sẽ nhận y như vậy; chỉ lượt 4
        // (gõ sai) mới là "gần đúng" cần người dùng tự tick.
        exact: m.pass !== 4, pass: m.pass, dist: h.dist,
        hintFolder: h.hintFolder || null,
      });
    }
  }

  const folders = Array.from(byFolder.keys()).map(folder => {
    const g = byFolder.get(folder);
    return {
      folder,
      dirName: path.basename(folder),
      rel: path.relative(root, folder) || '.',
      exactCount: g.matches.filter(x => x.exact).length,
      // Có clip khớp theo lượt 3 → bin đích phải mang tên thư mục này, nếu không
      // import xong validate vẫn không nhận ra "Higg 33".
      needsFolderBin: g.matches.some(x => x.pass === 3),
      matches: g.matches.sort((a, b) => (a.exact === b.exact ? 0 : (a.exact ? -1 : 1))),
    };
  }).sort((a, b) => b.exactCount - a.exactCount || b.matches.length - a.matches.length);

  return {
    ok: true, root, roots, truncated,
    scannedFiles: files.length,
    folders,
    unmatched: wanted.filter(n => !hit.has(n)),
  };
}

module.exports = { findSources, matchOne, norm, lev };
