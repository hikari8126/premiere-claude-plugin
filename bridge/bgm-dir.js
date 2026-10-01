// bridge/bgm-dir.js — thư mục lưu nhạc nền gen bằng AI: <thư mục sản phẩm>/BGM/AI.
//
// Voice Gen (mode Music) mở hộp thoại "Lưu audio" với thư mục chọn sẵn ở đây.
// Thư mục sản phẩm = cấp cha của thư mục chứa .prproj (productRoot, giống tab Watch).
// Mỗi sản phẩm đặt tên hơi khác nhau ("BGM", "BGMs", "Music", "Nhạc nền"…) nên tìm
// theo alias, không phân biệt hoa thường / dấu tách. Không tìm thấy thì trả đường
// dẫn BGM/AI mặc định — /tts/move tự tạo thư mục khi lưu, nên ở đây KHÔNG tạo gì
// (bấm Cancel thì không để lại thư mục rỗng).

const fs   = require('fs');
const path = require('path');
const { productRoot } = require('./watchfolder-browse.js');

// So tên thư mục: NFC (macOS lưu tách dấu), thường, gộp - _ . và khoảng trắng.
function normName(s) {
  return String(s || '').normalize('NFC').toLowerCase().replace(/[-_.\s]+/g, ' ').trim();
}

const BGM_ALIASES = ['bgm', 'bgms', 'music', 'musics', 'nhạc', 'nhac', 'nhạc nền', 'nhac nen',
                     'background music', 'bg music'];
const AI_ALIASES  = ['ai', 'ai bgm', 'bgm ai', 'ai music', 'music ai', 'nhạc ai', 'nhac ai'];

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name);
  } catch (e) { return []; }
}

// Thư mục con đầu tiên khớp alias — theo THỨ TỰ alias (BGM trước Music), để
// "BGM" luôn thắng khi một sản phẩm có cả hai.
function findChild(dir, aliases) {
  const kids = subdirs(dir);
  for (const a of aliases) {
    const hit = kids.find(k => normName(k) === a);
    if (hit) return path.join(dir, hit);
  }
  return null;
}

// BGM nằm ngay dưới thư mục sản phẩm; một số sản phẩm lồng một cấp
// (vd "Audio/BGM") nên quét thêm cấp 2 nếu cấp 1 không có.
function findBgm(root) {
  const direct = findChild(root, BGM_ALIASES);
  if (direct) return direct;
  for (const k of subdirs(root)) {
    const nested = findChild(path.join(root, k), BGM_ALIASES);
    if (nested) return nested;
  }
  return null;
}

// → { dir, root, bgmFound, aiFound }. dir luôn có giá trị khi projectPath hợp lệ.
function resolveBgmDir(projectPath) {
  if (!projectPath || !path.isAbsolute(String(projectPath))) {
    throw new Error('projectPath không hợp lệ — lưu project trước');
  }
  const root = productRoot(projectPath);
  const bgm = findBgm(root);
  const ai = bgm ? findChild(bgm, AI_ALIASES) : null;
  return {
    dir: ai || path.join(bgm || path.join(root, 'BGM'), 'AI'),
    root,
    bgmFound: !!bgm,
    aiFound: !!ai,
  };
}

module.exports = { resolveBgmDir, normName, BGM_ALIASES, AI_ALIASES };
