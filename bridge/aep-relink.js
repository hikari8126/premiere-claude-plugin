// bridge/aep-relink.js — relink footage trong file After Effects (.aep) sau khi
// "Đổi tên source hàng loạt" đổi tên file trên đĩa.
//
// .aep là RIFX (RIFF big-endian): chunk = id 4 byte + size 4 byte BE + data (đệm
// về số chẵn); LIST = 'LIST' + size + form 4 byte + các chunk con. Footage là LIST
// form 'Item' có:
//   Utf8                       — tên hiển thị ('' = AE tự lấy theo tên file)
//   LIST 'Pin ' → LIST 'Als2' → alas  — JSON {"fullpath":"/abs/path", ...}
// Folder trong Project panel của AE là Item → LIST 'Sfdr' → Item… lồng nhiều cấp.
// Sau chunk RIFX còn XMP trailer, phải giữ nguyên.
//
// Bài học từ relink_aep.py (skill premiere-media-toolkit): bản đó chỉ xử lý Item
// cấp ngoài nên bỏ sót footage trong folder, và vá đệ quy ngây thơ làm nhân bản
// chunk. Ở đây dựng lại cây trong MỘT lượt đệ quy: nhánh không đổi thì chép
// nguyên slice gốc, nhánh có đổi thì dựng lại header với size mới. Kiểm tra độ dài
// kỳ vọng + đọc lại đường dẫn trước khi trả về.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const fold = p => String(p == null ? '' : p).normalize('NFC').toLowerCase();
const base = p => String(p).split('/').pop();

// pairs [{oldPath, newPath}] → Map(fold(old) → new)
function buildMap(pairs) {
  const m = new Map();
  (pairs || []).forEach(p => { if (p && p.oldPath && p.newPath) m.set(fold(p.oldPath), String(p.newPath)); });
  return m;
}

function header(id, size) {
  const h = Buffer.alloc(8);
  h.write(id, 0, 'latin1');
  h.writeUInt32BE(size, 4);
  return h;
}
function leaf(id, data) {
  return Buffer.concat([header(id, data.length), data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function checkRifx(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFX') throw new Error('Không phải file .aep (thiếu RIFX)');
  const end = 8 + buf.readUInt32BE(4);
  if (end > buf.length) throw new Error('File .aep bị cắt cụt');
  return end;
}

// Có những LIST mà nội dung là dữ liệu thô chứ không phải chunk con (vd 'btdk' —
// text document). Thấy trên .aep thật: đọc như chunk thì vượt biên. Những LIST đó
// coi là khối kín, chép nguyên.
const OPAQUE_FORMS = new Set(['btdk']);
function childrenFit(buf, s, e) {
  let off = s;
  while (off + 8 <= e) {
    const size = buf.readUInt32BE(off + 4);
    if (off + 8 + size > e) return false;
    off += 8 + size + (size & 1);
  }
  return off >= e;
}

// Duyệt chunk trong [start, end): cb(id, dataStart, size, form|null, offset).
// form chỉ có khi là LIST chứa chunk con thật.
function eachChunk(buf, start, end, cb) {
  let off = start;
  while (off + 8 <= end) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32BE(off + 4);
    const d = off + 8;
    if (d + size > end) throw new Error('Chunk ' + JSON.stringify(id) + ' vượt biên tại byte ' + off);
    let form = id === 'LIST' && size >= 4 ? buf.toString('latin1', d, d + 4) : null;
    if (form && (OPAQUE_FORMS.has(form) || !childrenFit(buf, d + 4, d + size))) form = null;
    cb(id, d, size, form, off);
    off = d + size + (size & 1);
  }
}

// Vị trí giá trị "fullpath" thô trong text JSON của alas (giữ nguyên mọi thứ khác).
const FP_RE = /"fullpath"\s*:\s*"((?:[^"\\]|\\.)*)"/;
function readFullpath(text) {
  const m = FP_RE.exec(text);
  if (!m) return null;
  let v;
  try { v = JSON.parse('"' + m[1] + '"'); } catch (e) { return null; }
  return { value: v, index: m.index, match: m[0], raw: m[1] };
}

// Mọi fullpath trong file, theo thứ tự xuất hiện.
function fullpaths(buf) {
  const end = checkRifx(buf), out = [];
  (function walk(s, e) {
    eachChunk(buf, s, e, (id, d, size, form) => {
      if (form) walk(d + 4, d + size);
      else if (id === 'alas') { const fp = readFullpath(buf.toString('utf8', d, d + size)); if (fp) out.push(fp.value); }
    });
  })(12, end);
  return out;
}

// Tên (Utf8 con trực tiếp) của mọi Item, theo thứ tự — để test/kiểm tra.
function itemNames(buf) {
  const end = checkRifx(buf), out = [];
  (function walk(s, e, parentForm) {
    eachChunk(buf, s, e, (id, d, size, form) => {
      if (form) walk(d + 4, d + size, form);
      else if (id === 'Utf8' && parentForm === 'Item') out.push(buf.toString('utf8', d, d + size));
    });
  })(12, end, 'Egg!');
  return out;
}

function countAepMatches(buf, map) {
  try { return fullpaths(buf).filter(p => map.has(fold(p))).length; } catch (e) { return 0; }
}

// → { buf, replaced, renamed }. Ném lỗi khi cấu trúc sai hoặc kiểm tra sau ghi sai.
function rewriteAep(buf, map) {
  const end = checkRifx(buf);
  if (!map || !map.size) return { buf, replaced: 0, renamed: 0 };
  let replaced = 0, renamed = 0, delta = 0;

  // Dựng lại [s, e) → { parts: [{id, form, bytes, changes}], changed }
  function build(s, e) {
    const parts = [];
    let changed = false;
    eachChunk(buf, s, e, (id, d, size, form, off) => {
      const orig = buf.subarray(off, d + size + (size & 1));
      if (form) {
        const kids = build(d + 4, d + size);
        if (!kids.changed) { parts.push({ id, form, bytes: orig, changes: [] }); return; }
        changed = true;
        let changes = [];
        kids.parts.forEach(k => { changes = changes.concat(k.changes); });
        if (form === 'Item') {
          // Chỉ đổi tên theo footage của CHÍNH Item này (nhánh 'Pin '), không theo Item con.
          const own = [];
          kids.parts.forEach(k => { if (k.form === 'Pin ') own.push.apply(own, k.changes); });
          if (own.length) {
            const ch = own[0];
            kids.parts.forEach((k, i) => {
              if (k.id !== 'Utf8') return;
              const name = k.bytes.toString('utf8', 8, 8 + k.bytes.readUInt32BE(4));
              if (!name || fold(name) !== fold(base(ch.old))) return;
              const nb = leaf('Utf8', Buffer.from(base(ch.new), 'utf8'));
              delta += nb.length - k.bytes.length;
              kids.parts[i] = { id: 'Utf8', form: null, bytes: nb, changes: [] };
              renamed++;
            });
          }
          changes = [];                        // Item tiêu thụ, không đẩy lên folder cha
        }
        const body = Buffer.concat([Buffer.from(form, 'latin1')].concat(kids.parts.map(k => k.bytes)));
        parts.push({ id, form, bytes: leaf('LIST', body), changes });
        return;
      }
      if (id === 'alas') {
        const text = buf.toString('utf8', d, d + size);
        const fp = readFullpath(text);
        const to = fp && map.get(fold(fp.value));
        if (to != null) {
          const val = JSON.stringify(to);
          const nt = text.slice(0, fp.index) + fp.match.replace('"' + fp.raw + '"', val) + text.slice(fp.index + fp.match.length);
          const nb = leaf('alas', Buffer.from(nt, 'utf8'));
          delta += nb.length - orig.length;
          replaced++;
          changed = true;
          parts.push({ id, form: null, bytes: nb, changes: [{ old: fp.value, new: to }] });
          return;
        }
      }
      parts.push({ id, form: null, bytes: orig, changes: [] });
    });
    return { parts, changed };
  }

  const top = build(12, end);
  if (!replaced) return { buf, replaced: 0, renamed: 0 };
  const body = Buffer.concat([buf.subarray(8, 12)].concat(top.parts.map(p => p.bytes)));
  const out = Buffer.concat([header('RIFX', body.length), body, buf.subarray(end)]);

  // Kiểm tra: độ dài đúng phần chênh; đọc lại thì footage thứ i phải trỏ đúng
  // đích của footage thứ i cũ (so theo vị trí — hoán đổi a↔b cũng bắt được).
  if (out.length !== buf.length + delta) throw new Error('Kiểm tra độ dài sai (' + out.length + ' ≠ ' + (buf.length + delta) + ')');
  const before = fullpaths(buf), after = fullpaths(out);
  if (after.length !== before.length) throw new Error('Số footage đổi sau khi ghi (' + before.length + ' → ' + after.length + ')');
  for (let i = 0; i < before.length; i++) {
    const want = map.has(fold(before[i])) ? map.get(fold(before[i])) : before[i];
    if (after[i] !== want) throw new Error('Đọc lại sai đường dẫn footage #' + (i + 1));
  }
  return { buf: out, replaced, renamed };
}

// Ghi .aep: backup → file tạm cạnh file gốc → rename đè (không bao giờ ghi dở file gốc).
function relinkAepFile(file, map, backupDir) {
  try {
    const buf = fs.readFileSync(file);
    const r = rewriteAep(buf, map);
    if (!r.replaced) return { ok: true, replaced: 0, renamed: 0 };
    fs.mkdirSync(backupDir, { recursive: true });
    let bk = path.join(backupDir, path.basename(file));
    for (let i = 2; fs.existsSync(bk); i++) bk = path.join(backupDir, path.basename(file, '.aep') + ' (' + i + ').aep');
    fs.writeFileSync(bk, buf);
    const tmp = file + '.rn-tmp';
    fs.writeFileSync(tmp, r.buf);
    try { fs.chmodSync(tmp, fs.statSync(file).mode & 0o777); } catch (e) {}
    fs.renameSync(tmp, file);
    return { ok: true, replaced: r.replaced, renamed: r.renamed, backup: bk };
  } catch (e) {
    try { fs.rmSync(file + '.rn-tmp', { force: true }); } catch (e2) {}
    return { ok: false, replaced: 0, error: e.message };
  }
}

// Tìm *.aep dưới root: bỏ thư mục ẩn, thư mục Auto-Save, quá sâu; có hạn giờ
// (Google Drive đọc thư mục chậm — bài học find-sources).
async function findAepFiles(root, opts) {
  opts = opts || {};
  const maxDepth = opts.maxDepth == null ? 6 : opts.maxDepth;
  const deadline = Date.now() + (opts.timeoutMs || 30000);
  const files = [];
  let timedOut = false;
  let level = [root];
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next = [];
    await Promise.all(level.map(async dir => {
      if (Date.now() > deadline) { timedOut = true; return; }
      let ents = [];
      try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
      ents.forEach(en => {
        if (en.name.charAt(0) === '.') return;
        const p = path.join(dir, en.name);
        if (en.isDirectory()) { if (!/auto-save/i.test(en.name)) next.push(p); }
        else if (en.isFile() && /\.aep$/i.test(en.name)) files.push(p);
      });
    }));
    level = next;
  }
  files.sort();
  return { files, timedOut };
}

// .aep dưới root có tham chiếu tới oldPaths → { files:[{path, name, count}], timedOut }.
// Lọc nhanh bằng tên file (cả NFC lẫn NFD) trước khi parse cả file.
async function scanAep(root, oldPaths, opts) {
  opts = opts || {};
  const deadline = Date.now() + (opts.timeoutMs || 30000);
  const found = await findAepFiles(root, { maxDepth: opts.maxDepth, timeoutMs: opts.timeoutMs });
  const map = buildMap((oldPaths || []).map(p => ({ oldPath: p, newPath: p })));
  const needles = [];
  (oldPaths || []).forEach(p => {
    const b = base(p);
    [b.normalize('NFC'), b.normalize('NFD')].forEach(v => needles.push(Buffer.from(v, 'utf8')));
  });
  const out = [];
  let timedOut = found.timedOut;
  for (const f of found.files) {
    if (Date.now() > deadline) { timedOut = true; break; }
    let buf;
    try { buf = await fs.promises.readFile(f); } catch (e) { continue; }
    if (!needles.some(n => buf.indexOf(n) >= 0)) continue;
    const count = countAepMatches(buf, map);
    if (count) out.push({ path: f, name: path.basename(f), count });
  }
  return { files: out, timedOut };
}

// AE giữ project trong bộ nhớ — đang mở mà sửa file thì bấm Save là ghi đè mất.
function isAeRunning() {
  if (process.env.RENAME_FAKE_AE === '1') return true;
  if (process.env.RENAME_FAKE_AE === '0') return false;
  try {
    const r = spawnSync('pgrep', ['-f', 'Adobe After Effects'], { timeout: 3000 });
    return r.status === 0;
  } catch (e) { return false; }
}

module.exports = {
  buildMap, fullpaths, itemNames, countAepMatches, rewriteAep,
  relinkAepFile, findAepFiles, scanAep, isAeRunning,
};
