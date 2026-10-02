// plugin/st-script.js — Tạo Sub: ô script hiện tại có còn là bản đã ngắt câu / canh giờ
// không (ST3). Cờ stSplitReady / stOrganized / stTimedCues chỉ đúng với script lúc đặt
// cờ; dán script khác vào mà cờ còn nguyên → cue dài 10-20s (keepLines trên dòng chưa
// ngắt) hoặc timing cũ đặt lên chữ mới. Sửa nhẹ (đổi vài chữ, gộp/tách dòng) vẫn giữ
// cờ — đó là luồng "AI ngắt câu → sửa trong ô → Tạo Sub".
// Non-module script cho UXP; cũng require() được từ Node để test.

function stScriptWords(text) {
  return String(text || '')
    .normalize('NFC')
    .toLowerCase()
    // Dấu câu → khoảng trắng (không dùng \p{L}: tránh phụ thuộc Unicode regex của UXP).
    .replace(/[.,!?;:"'\u201c\u201d\u2018\u2019()\[\]{}\u2026\-\u2013\u2014\/\\*#@&%$^~`|<>=+_]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// true = `current` là bản sửa của `snapshot` (≥ 60% số chữ hai bên khớp nhau).
function stScriptSameSource(snapshot, current) {
  var a = stScriptWords(snapshot), b = stScriptWords(current);
  if (!a.length || !b.length) return false;
  var bag = Object.create(null);
  a.forEach(function (w) { bag[w] = (bag[w] || 0) + 1; });
  var common = 0;
  b.forEach(function (w) { if (bag[w] > 0) { bag[w]--; common++; } });
  return common / b.length >= 0.6 && common / a.length >= 0.6;
}

(function (root) {
  if (root) { root.stScriptSameSource = stScriptSameSource; }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { stScriptSameSource: stScriptSameSource, stScriptWords: stScriptWords };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
