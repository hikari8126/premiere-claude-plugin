// bridge/watchfolder-find.js
// Tìm file trên đĩa cho những source mà Autocut validate báo THIẾU trong project.
//
// Vì sao ở bridge chứ không ở plugin: chỉ bridge mới đọc được đĩa. Plugin chỉ
// biết tên source trong cutsheet và cây bin của project.
//
// Chuẩn hoá tên phải GIỐNG HỆT sacNorm() bên plugin (main.js), nếu không thì
// "khớp" ở đây lại "không khớp" lúc validate lại — người dùng thấy import xong
// mà vẫn báo thiếu.

const fs   = require('fs');
const path = require('path');
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

// Duyệt thư mục BẤT ĐỒNG BỘ, nhiều thư mục song song, KHÔNG stat từng file.
//
// Vì sao không dùng scanFolder() như watch engine: nó là code đồng bộ
// (readdirSync + statSync từng file). Trên Google Drive, lần liệt kê đầu mỗi thư
// mục phải hỏi server — đo thật: 130 thư mục / 550 file mất 65 giây — và suốt
// lúc đó cả bridge đứng hình (/health, watch poll đều không trả lời được).
// Tìm theo TÊN thì không cần size/mtime, nên bỏ hẳn stat; readdir song song thì
// độ trễ của Drive chồng lên nhau thay vì cộng dồn.
//
// budgetMs: quá hạn thì dừng và trả những gì đã quét (timedOut = true) — thà trả
// một phần kèm lời giải thích còn hơn để plugin chờ vô hạn.
async function walkAsync(root, opts) {
  const o = opts || {};
  // 10: Sources của SAMX sâu tới 7 cấp (legacy/studio/Senyue/approve/<lô>/<Outcome>/file).
  const maxDepth = Math.max(1, Number(o.maxDepth) || 10);
  const maxFiles = Number(o.maxFiles) || 20000;
  const concurrency = Math.max(1, Number(o.concurrency) || 8);
  const deadline = Date.now() + (Number(o.budgetMs) || 45000);

  const files = [];      // rel paths, '/'
  let dirs = 0, truncated = false, timedOut = false, rootError = null;
  const queue = [{ abs: root, rel: '', depth: 1 }];
  let active = 0;

  await new Promise(resolve => {
    function pump() {
      if (Date.now() > deadline && (queue.length || active)) timedOut = true;
      if (timedOut || truncated) queue.length = 0;
      if (!queue.length && !active) return resolve();
      while (active < concurrency && queue.length) {
        const job = queue.shift();
        active++;
        fs.promises.readdir(job.abs, { withFileTypes: true }).then(entries => {
          dirs++;
          for (const ent of entries) {
            if (ent.name.startsWith('.')) continue;
            const rel = job.rel ? job.rel + '/' + ent.name : ent.name;
            if (ent.isDirectory()) {
              if (job.depth < maxDepth
                  && IGNORE_DIRS.indexOf(ent.name.toLowerCase()) < 0) {
                queue.push({ abs: path.join(job.abs, ent.name), rel, depth: job.depth + 1 });
              }
            } else if (ent.isFile()) {
              files.push(rel);
              if (files.length >= maxFiles) { truncated = true; break; }
            }
          }
        }, err => {
          if (job.depth === 1) rootError = err.code || err.message;   // lỗi ở gốc mới là lỗi thật
        }).then(() => { active--; pump(); });
      }
    }
    pump();
  });

  return { ok: !rootError, error: rootError, files, dirs, truncated, timedOut };
}

// Khớp một source với danh sách file trên đĩa — CHÉP LẠI 4 lượt của
// sacMatchBinItem() (plugin/main.js). Hai bên lệch nhau là hỏng cả tính năng:
// bridge "tìm thấy" mà import xong validate vẫn báo thiếu, hoặc ngược lại bridge
// báo không thấy trong khi validate sẽ nhận file đó.
//
// files: [{ rel, fileName, stem (norm, không đuôi), dirs: [{n (norm), raw}] thư mục tổ tiên, gần nhất trước }]
// Trả về { pass, hits: [{file, dist, hintFolder, hintDir}] } của lượt ĐẦU TIÊN có kết quả.
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
  // Xét MỌI thư mục tổ tiên chứ không chỉ cha trực tiếp: ở SAMX "Senyue 33" là
  // Sources/legacy/studio/Senyue/approve/33.mp4 — cha trực tiếp luôn là "approve".
  // hintDir = thư mục GẦN NHẤT khớp → tên bin con để validate nhận ra sau import
  // (lượt 3 của plugin chỉ nhìn bin cha trực tiếp của clip).
  const toks = t.split(' ').filter(Boolean);
  const clipOk = (n, clipPart) => n === clipPart
    || (n.length > clipPart.length && n.slice(-(clipPart.length + 1)) === ' ' + clipPart)
    || (n.length > clipPart.length && n.indexOf(clipPart) === 0
        && /[\s._\-(]/.test(n.charAt(clipPart.length)));
  for (let k = 1; k < toks.length; k++) {
    const folderPart = toks.slice(0, k).join(' ');
    const clipPart = toks.slice(k).join(' ');
    hits = [];
    for (const f of files) {
      if (!clipOk(f.stem, clipPart)) continue;
      const d = (f.dirs || []).find(x => x.n.indexOf(folderPart) !== -1);
      if (d) hits.push({ file: f, dist: 0, hintFolder: folderPart, hintDir: d.raw });
    }
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

// Footage bị loại: Sources/…/reject/, Asset/Clips/DISQUALIFIED VIDEO SOURCE/.
// Vẫn trả về (bro muốn thấy) nhưng plugin không tick sẵn.
const REJECT_RE = /\b(reject|rejected|disqualified)\b/;

// root      — gốc HIỂN THỊ (rel trong bảng duyệt tính từ đây)
// names     — tên source Autocut báo thiếu
// opts.roots      — các gốc để quét, theo thứ tự ưu tiên (mặc định [root]);
//                   source-roots.js dựng ra từ sản phẩm SAMX của project
// opts.extraRoots — thư mục các watch đang có (có thể nằm ngoài, ổ ngoài/NAS)
// trả về    — { ok, root, roots, skippedRoots, scannedFiles, folders: [{folder, rel, matches}], unmatched }
//             matches: { filePath, fileName, name, exact, pass, dist, hintFolder, hintDir, rejected, alt }
async function findSources(root, names, opts) {
  const o = opts || {};
  const wanted = (names || []).filter(Boolean);
  if (!root) return { ok: false, error: 'thiếu thư mục gốc' };

  // Gốc nằm TRONG gốc khác thì đã được quét rồi — bỏ để khỏi đếm trùng.
  const roots = [];
  const base = (Array.isArray(o.roots) && o.roots.length ? o.roots : [root]).concat(o.extraRoots || []);
  for (const r of base) {
    if (!r) continue;
    const dup = roots.some(x => r === x || r.indexOf(x + path.sep) === 0);
    if (!dup) roots.push(r);
  }

  const files = [];
  const skippedRoots = [];
  let truncated = false, timedOut = false, dirs = 0, firstError = null, okRoots = 0;
  const t0 = Date.now();
  // Quét các gốc song song, chung một hạn thời gian.
  const results = await Promise.all(roots.map(r => walkAsync(r, {
    maxDepth: o.maxDepth, maxFiles: o.maxFiles,
    concurrency: o.concurrency, budgetMs: o.budgetMs,
  }).then(res => ({ r, res }))));
  results.forEach(({ r, res }, ri) => {
    if (!res.ok) {
      // Một gốc hỏng (Drive chưa tải, ổ ngoài rút ra) không chặn cả lượt.
      skippedRoots.push({ path: r, error: res.error });
      if (!firstError) firstError = res.error;
      return;
    }
    okRoots++;
    if (res.truncated) truncated = true;
    if (res.timedOut) timedOut = true;
    dirs += res.dirs;
    for (const rel of res.files) {
      if (!isMedia(rel)) continue;
      const parts = rel.split('/');
      const fileName = parts[parts.length - 1];
      const abs = path.join(r, parts.join(path.sep));
      // Thư mục tổ tiên, gần nhất trước; file nằm ngay ở gốc thì tổ tiên là tên gốc.
      const anc = parts.slice(0, -1).reverse();
      if (!anc.length) anc.push(path.basename(r));
      files.push({
        abs, root: r, rootIdx: ri, fileName, depth: parts.length,
        stem: norm(fileName),
        dirs: anc.map(x => ({ n: norm(x), raw: x })),
        rejected: parts.slice(0, -1).some(x => REJECT_RE.test(norm(x))),
      });
    }
  });
  if (!okRoots) return { ok: false, error: firstError || 'không đọc được thư mục nào', root, roots, skippedRoots };

  const byFolder = new Map();
  const hit = new Set();
  for (const name of wanted) {
    const m = matchOne(name, files);
    if (!m) continue;
    hit.add(name);
    // Nhiều file cùng khớp một source (cùng clip ở Sources lẫn Asset/Clips, hay
    // approve lẫn reject): chỉ tick sẵn MỘT bản — import cả hai thì bin có 2 clip
    // trùng tên và validate lại báo ⚠ trùng. Ưu tiên: không reject → gốc đứng
    // trước (Sources) → nông hơn.
    const order = m.hits.slice().sort((a, b) =>
      (a.file.rejected - b.file.rejected) || (a.file.rootIdx - b.file.rootIdx)
      || (a.file.depth - b.file.depth) || (a.file.abs < b.file.abs ? -1 : 1));
    const primary = order[0];
    for (const h of m.hits) {
      const folder = path.dirname(h.file.abs);
      if (!byFolder.has(folder)) byFolder.set(folder, { root: h.file.root, rootIdx: h.file.rootIdx, matches: [] });
      byFolder.get(folder).matches.push({
        filePath: h.file.abs, fileName: h.file.fileName, name,
        // Lượt 1–3 là khớp theo luật, validate sẽ nhận y như vậy; chỉ lượt 4
        // (gõ sai) mới là "gần đúng" cần người dùng tự tick.
        exact: m.pass !== 4, pass: m.pass, dist: h.dist,
        hintFolder: h.hintFolder || null,
        hintDir: h.hintDir || null,
        rejected: !!h.file.rejected,
        alt: h !== primary,
      });
    }
  }

  const folders = Array.from(byFolder.keys()).map(folder => {
    const g = byFolder.get(folder);
    const p3 = g.matches.find(x => x.pass === 3 && x.hintDir);
    return {
      folder,
      dirName: path.basename(folder),
      rel: path.relative(root, folder) || '.',
      exactCount: g.matches.filter(x => x.exact && !x.rejected).length,
      rootIdx: g.rootIdx,
      rejected: g.matches.every(x => x.rejected),
      // Có clip khớp theo lượt 3 → bin đích phải mang tên thư mục khớp (hintDir,
      // vd "Senyue" chứ không phải "approve"), nếu không import xong validate vẫn
      // không nhận ra "Senyue 33".
      needsFolderBin: g.matches.some(x => x.pass === 3),
      binDirName: p3 ? p3.hintDir : path.basename(folder),
      matches: g.matches.sort((a, b) => (a.exact === b.exact ? 0 : (a.exact ? -1 : 1))),
    };
  }).sort((a, b) => (a.rejected - b.rejected) || b.exactCount - a.exactCount
    || b.matches.length - a.matches.length || a.rootIdx - b.rootIdx);

  return {
    ok: true, root, roots, skippedRoots, truncated, timedOut,
    scannedFiles: files.length, scannedDirs: dirs,
    elapsedMs: Date.now() - t0,
    folders,
    unmatched: wanted.filter(n => !hit.has(n)),
  };
}

module.exports = { findSources, walkAsync, matchOne, norm, lev };
