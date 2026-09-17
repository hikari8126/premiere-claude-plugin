// bridge/watchfolder-scan.js
// Duyệt thư mục đồng bộ, trả snapshot { relPath: [size, mtimeMs] }.
// Đồng bộ là chủ ý: một lượt quét chạy trong vài ms tới vài trăm ms và
// engine gọi nó ngoài đường request, nên không chặn gì đáng kể — đổi lại
// logic đơn giản hơn hẳn bản async.

const fs   = require('fs');
const path = require('path');

const DEFAULT_MAX_FILES = 20000;

// maxDepth 1 = chỉ file ngay trong folder; 2 = thêm 1 cấp con; ...
function scanFolder(folder, opts) {
  const o = opts || {};
  const maxDepth  = o.recursive === false ? 1 : Math.max(1, Number(o.maxDepth) || 3);
  const maxFiles  = Number(o.maxFiles) || DEFAULT_MAX_FILES;
  const files = {};
  let count = 0;
  let truncated = false;

  function walk(abs, rel, depth) {
    if (truncated) return;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
    catch (e) { if (depth === 1) throw e; return; }   // lỗi ở gốc mới là lỗi thật

    for (const ent of entries) {
      if (truncated) return;
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        if (depth < maxDepth) walk(path.join(abs, ent.name), childRel, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;   // bỏ symlink, socket, fifo
      let st;
      try { st = fs.statSync(path.join(abs, ent.name)); } catch (e) { continue; }
      files[childRel] = [st.size, Math.floor(st.mtimeMs)];
      if (++count >= maxFiles) { truncated = true; return; }
    }
  }

  try { walk(folder, '', 1); }
  catch (e) { return { ok: false, error: e.code || e.message, files: {}, truncated: false }; }

  return { ok: true, files, truncated };
}

module.exports = { scanFolder, DEFAULT_MAX_FILES };
