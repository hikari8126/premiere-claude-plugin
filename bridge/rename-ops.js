// bridge/rename-ops.js — thao tác đĩa của "Đổi tên source hàng loạt" (tab Watch):
// kiểm tra tên + trùng, đổi tên 2 pha (hoán đổi tên trong lượt không đè nhau),
// tự đổi về khi lỗi giữa chừng, nhật ký lượt gần nhất theo project để hoàn tác.
// Spec: docs/superpowers/specs/2026-10-02-batch-rename-relink-design.md

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function baseDir() {
  return process.env.RENAME_DIR
    || path.join(os.homedir(), 'Library', 'Application Support', 'ClaudeBridge', 'rename');
}
function backupRoot() { return path.join(baseDir(), 'aep-backup'); }

const nfc = s => String(s == null ? '' : s).normalize('NFC');
// APFS/HFS+ mặc định không phân biệt hoa/thường (và chuẩn hoá Unicode khi so).
const fold = p => nfc(p).toLowerCase();

// Cùng luật với plugin/rename-core.js nameError.
function nameError(name) {
  name = String(name || '');
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  if (!base.trim() || name.charAt(0) === '.') return 'Tên trống hoặc bắt đầu bằng dấu chấm';
  if (/[\/:]/.test(name)) return 'Tên không được chứa / hoặc :';
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'Tên chứa ký tự điều khiển';
  if (Buffer.byteLength(name, 'utf8') > 255) return 'Tên dài quá 255 byte';
  return '';
}

function statOrNull(p) { try { return fs.statSync(p); } catch (e) { return null; } }

// Thư mục chỉ đọc (vd Shared drive Google Drive mà tài khoản chỉ có quyền xem: dr-x)
// → đổi tên chắc chắn EACCES. Báo ngay ở bước xem trước thay vì lúc bấm chạy.
const RO_MSG = 'Thư mục chỉ đọc — không có quyền sửa (Google Drive chỉ xem?)';
function dirWritable(dir, cache) {
  if (cache && dir in cache) return cache[dir];
  let ok = true;
  try { fs.accessSync(dir, fs.constants.W_OK); } catch (e) { ok = false; }
  if (cache) cache[dir] = ok;
  return ok;
}
function sameFile(a, b) {
  const x = statOrNull(a), y = statOrNull(b);
  return !!(x && y && x.dev === y.dev && x.ino === y.ino);
}

// rows [{oldPath, newName}] → [{oldPath, newPath, newName, error, same}].
// Dòng lỗi giữ nguyên chỗ, nên đích trùng file của dòng lỗi vẫn tính là trùng —
// lặp tới khi ổn định (mỗi vòng chỉ thêm lỗi, nên dừng sau ≤ rows.length vòng).
function planRows(rows) {
  const wcache = {};
  const out = (rows || []).map(r => {
    const oldPath = String(r.oldPath || '');
    const newName = nfc(r.newName).trim();
    const o = { oldPath, newName, newPath: '', error: '', same: false };
    if (!path.isAbsolute(oldPath)) { o.error = 'Đường dẫn không hợp lệ'; return o; }
    const st = statOrNull(oldPath);
    if (!st || !st.isFile()) { o.error = 'File gốc không còn trên đĩa'; return o; }
    o.error = nameError(newName);
    o.newPath = path.join(path.dirname(oldPath), newName);
    o.same = !o.error && o.newPath === oldPath;
    if (!o.error && !o.same && !dirWritable(path.dirname(oldPath), wcache)) o.error = RO_MSG;
    return o;
  });

  // Trùng trong lượt.
  const byTarget = {};
  out.forEach((o, i) => { if (!o.error && !o.same) (byTarget[fold(o.newPath)] = byTarget[fold(o.newPath)] || []).push(i); });
  Object.values(byTarget).forEach(ix => {
    if (ix.length > 1) ix.forEach(i => { out[i].error = 'Trùng tên với dòng khác trong lượt'; });
  });

  // Trùng file đã có trên đĩa (trừ khi file đó cũng được đổi đi trong lượt).
  for (let round = 0; round <= out.length; round++) {
    const leaving = new Set(out.filter(o => !o.error && !o.same).map(o => fold(o.oldPath)));
    let changed = false;
    out.forEach(o => {
      if (o.error || o.same) return;
      if (!statOrNull(o.newPath)) return;
      if (sameFile(o.newPath, o.oldPath)) return;          // chỉ đổi hoa/thường
      if (leaving.has(fold(o.newPath))) return;
      o.error = 'Đã có file trùng tên trong thư mục';
      changed = true;
    });
    if (!changed) break;
  }
  return out;
}

function exists(p) { return !!statOrNull(p); }

// pairs [{oldPath, newPath}] → {ok, error?}. Pha 1: cũ → tên tạm; pha 2: tạm → mới.
// fs.renameSync ĐÈ file đích không báo, nên kiểm tra tồn tại trước mỗi bước.
// Lỗi bất kỳ → đưa mọi file về tên cũ.
function applyRenames(pairs) {
  pairs = (pairs || []).filter(p => p && p.oldPath && p.newPath && p.oldPath !== p.newPath);
  const id = crypto.randomBytes(4).toString('hex');
  const st = pairs.map((p, i) => ({
    oldPath: p.oldPath, newPath: p.newPath,
    tmp: path.join(path.dirname(p.oldPath), '.rn-tmp-' + id + '-' + i),
    at: 'old',
  }));
  function rollback() {
    const errs = [];
    st.forEach(s => {
      try {
        if (s.at === 'new') { fs.renameSync(s.newPath, s.oldPath); s.at = 'old'; }
        else if (s.at === 'tmp') { fs.renameSync(s.tmp, s.oldPath); s.at = 'old'; }
      } catch (e) { errs.push(path.basename(s.oldPath) + ': ' + e.message); }
    });
    return errs;
  }
  function fail(msg) {
    const errs = rollback();
    return { ok: false, error: msg + (errs.length ? ' — KHÔNG đổi về được: ' + errs.join('; ') : '') };
  }
  for (const s of st) {
    try {
      if (!exists(s.oldPath)) return fail('File gốc không còn: ' + path.basename(s.oldPath));
      if (exists(s.tmp)) return fail('Tên tạm đã tồn tại: ' + s.tmp);
      fs.renameSync(s.oldPath, s.tmp); s.at = 'tmp';
    } catch (e) { return fail('Không đổi tên được ' + path.basename(s.oldPath) + ': ' + (e.code === 'EACCES' || e.code === 'EPERM' ? RO_MSG : e.message)); }
  }
  for (const s of st) {
    try {
      if (exists(s.newPath)) return fail('Đã có file trùng tên: ' + path.basename(s.newPath));
      fs.renameSync(s.tmp, s.newPath); s.at = 'new';
    } catch (e) { return fail('Không đổi tên được ' + path.basename(s.oldPath) + ': ' + e.message); }
  }
  return { ok: true };
}

// ── Nhật ký: chỉ giữ lượt gần nhất của mỗi project ─────────────────────────
function journalPath(projectPath) {
  const h = crypto.createHash('sha1').update(nfc(projectPath)).digest('hex').slice(0, 16);
  return path.join(baseDir(), h + '.json');
}
function loadJournal(projectPath) {
  try { return JSON.parse(fs.readFileSync(journalPath(projectPath), 'utf8')); } catch (e) { return null; }
}
function saveJournal(projectPath, batch) {
  fs.mkdirSync(baseDir(), { recursive: true });
  const f = journalPath(projectPath), tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(batch, null, 2));
  fs.renameSync(tmp, f);
}
function clearJournal(projectPath) { try { fs.rmSync(journalPath(projectPath), { force: true }); } catch (e) {} }

function newBatchId() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex');
}

// Bản gốc .aep của các lượt cũ hơn maxAgeMs.
function cleanupBackups(maxAgeMs) {
  const root = backupRoot();
  let names = [];
  try { names = fs.readdirSync(root); } catch (e) { return; }
  const cutoff = Date.now() - maxAgeMs;
  names.forEach(n => {
    const p = path.join(root, n);
    const s = statOrNull(p);
    if (s && s.isDirectory() && s.mtimeMs < cutoff) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }
  });
}

// File media (video/audio/ảnh) nằm ngay trong các thư mục `dirs` mà project chưa có
// (`known`: đường dẫn đã có, so không phân biệt hoa/thường) — để đổi tên luôn cho đủ bộ.
// Không đệ quy: chỉ "thư mục chứa source". Trả thêm names: {dir → mọi tên file}.
const MEDIA_EXT = (() => {
  const P = require('./watchfolder-rules.js').PRESETS;
  return new Set([].concat(P.video, P.audio, P.image));
})();
function siblings(dirs, known) {
  const have = new Set((known || []).map(fold));
  const natCmp = require('./watchfolder-browse.js').natCmp;
  const files = [], names = {};
  Array.from(new Set((dirs || []).map(String))).forEach(dir => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    // Mọi tên file đang có — plugin dùng để không cấp lại số đã có file giữ.
    names[dir] = ents.filter(en => en.isFile() && en.name.charAt(0) !== '.').map(en => en.name);
    ents.filter(en => en.isFile() && en.name.charAt(0) !== '.' && MEDIA_EXT.has(path.extname(en.name).toLowerCase()))
      .map(en => path.join(dir, en.name))
      .filter(p => !have.has(fold(p)))
      .sort((a, b) => natCmp(path.basename(a), path.basename(b)))
      .forEach(p => files.push({ path: p, dir }));
  });
  return { files, names };
}

module.exports = {
  siblings,
  nameError, planRows, applyRenames,
  loadJournal, saveJournal, clearJournal, newBatchId,
  backupRoot, cleanupBackups, fold,
};
