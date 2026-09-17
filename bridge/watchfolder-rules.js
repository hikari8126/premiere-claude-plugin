// bridge/watchfolder-rules.js
// Thuần hàm, không đụng filesystem — nhờ vậy test được không cần thư mục thật.
// relPath luôn dùng '/', tương đối so với watch.folder.

const PRESETS = {
  video: ['.mp4', '.mov', '.mxf', '.mkv', '.avi', '.r3d', '.braw', '.m4v', '.mts'],
  audio: ['.wav', '.mp3', '.aac', '.aiff', '.aif', '.flac', '.m4a'],
  image: ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.psd', '.exr', '.dng', '.gif'],
};

// Thư mục Premiere tự sinh — import vào là rác project.
const IGNORE_DIRS = [
  'adobe premiere pro auto-save',
  'adobe premiere pro preview files',
  'adobe premiere pro captured video',
  '.proxy',
];

// Đuôi của file đang được ghi dở.
const IGNORE_EXT = ['.tmp', '.part', '.crdownload', '.download', '.pek', '.cfa'];

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

function validateWatch(w) {
  if (!w || typeof w !== 'object') return { ok: false, error: 'watch rỗng' };
  if (!w.folder) return { ok: false, error: 'chưa chọn thư mục theo dõi' };
  if (!w.binPath) return { ok: false, error: 'chưa chọn bin đích' };
  if (!Array.isArray(w.include) || w.include.length === 0) {
    return { ok: false, error: 'chưa chọn loại file nào' };
  }
  if (!(Number(w.intervalMs) >= 1000)) {
    return { ok: false, error: 'intervalMs phải ≥ 1000' };
  }
  for (const field of ['includeRegex', 'excludeRegex']) {
    const src = w[field];
    if (!src) continue;
    try { new RegExp(src); }
    catch (e) { return { ok: false, error: field + ' sai cú pháp: ' + e.message }; }
  }
  return { ok: true };
}

function matchFile(w, relPath) {
  const parts = String(relPath).split('/');
  const name  = parts[parts.length - 1];
  const dirs  = parts.slice(0, -1);

  // 1. Bỏ qua cứng — không tắt được, kể cả preset 'all'.
  if (name.startsWith('.')) return false;
  for (const d of dirs) {
    if (d.startsWith('.')) return false;
    if (IGNORE_DIRS.indexOf(d.toLowerCase()) >= 0) return false;
  }
  const ext = extOf(name);
  if (IGNORE_EXT.indexOf(ext) >= 0) return false;

  // 2. Preset đuôi file.
  if (w.include.indexOf('all') < 0) {
    let hit = false;
    for (const key of w.include) {
      const list = PRESETS[key];
      if (list && list.indexOf(ext) >= 0) { hit = true; break; }
    }
    if (!hit) return false;
  }

  // 3 + 4. Regex soi TÊN FILE KHÔNG KÈM ĐUÔI. Soi cả path thì tên thư mục cha
  // vô tình khớp và lọc sai hàng loạt; soi cả đuôi thì luật quen thuộc nhất
  // ('_proxy$') lại không khớp 'a_proxy.mp4'.
  const stem = ext ? name.slice(0, -ext.length) : name;
  if (w.includeRegex && !new RegExp(w.includeRegex).test(stem)) return false;
  if (w.excludeRegex && new RegExp(w.excludeRegex).test(stem)) return false;

  return true;
}

function binPathFor(w, relPath) {
  if (!w.mirrorSubfolders) return w.binPath;
  const dirs = String(relPath).split('/').slice(0, -1);
  if (dirs.length === 0) return w.binPath;
  return w.binPath + '/' + dirs.join('/');
}

module.exports = { PRESETS, IGNORE_DIRS, IGNORE_EXT, validateWatch, matchFile, binPathFor };
