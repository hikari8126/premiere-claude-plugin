// plugin/claude-log.js — hàm thuần cho nhật ký lệnh tab Claude (global CLLOG):
// render câu trả lời, lịch sử lưu 20 lệnh, nhãn sequence, đếm giây. Test ở
// bridge/test/claude-log.test.js. Phần DOM ở claude-tab.js.

var CLLOG = (function () {
  var MAX_HISTORY = 20;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Câu trả lời của Claude → HTML gọn: ẩn khối ```actions (plugin tự chạy), giữ
  // code / đậm / xuống dòng. Chỉ còn khối actions → chuỗi rỗng.
  function renderReply(text) {
    var t = String(text || '').replace(/```actions[\s\S]*?(```|$)/g, '').trim();
    return esc(t)
      .replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

  // Thêm một lệnh vào lịch sử, giữ MAX_HISTORY lệnh mới nhất. Không sửa mảng gốc.
  function pushHistory(list, entry, max) {
    var out = (Array.isArray(list) ? list.slice() : []).concat([entry]);
    var cap = max || MAX_HISTORY;
    return out.length > cap ? out.slice(out.length - cap) : out;
  }

  // Ngữ cảnh gửi Claude: 2 lượt (user + assistant) cho mỗi lệnh đã xong trong lịch sử.
  function toMessages(list) {
    var out = [];
    (list || []).forEach(function (e) {
      if (!e || !e.cmd || !e.raw) return;
      out.push({ role: 'user', content: e.cmd });
      out.push({ role: 'assistant', content: e.raw });
    });
    return out;
  }

  function fmtDur(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function seqLabel(name, durSec) {
    if (!name) return 'Chưa mở sequence';
    return name + (durSec > 0 ? ' · ' + fmtDur(durSec) : '');
  }

  // "Clawd đang nghĩ… 12s" — giây hiện từ giây thứ 3 cho đỡ nhấp nháy.
  function thinkingText(sec) {
    sec = Math.round(Number(sec) || 0);
    return 'Clawd đang nghĩ…' + (sec >= 3 ? ' ' + (sec < 60 ? sec + 's' : fmtDur(sec)) : '');
  }

  return { MAX_HISTORY: MAX_HISTORY, esc: esc, renderReply: renderReply, pushHistory: pushHistory,
           toMessages: toMessages, fmtDur: fmtDur, seqLabel: seqLabel, thinkingText: thinkingText };
})();

(function (root) {
  if (root) { root.CLLOG = CLLOG; }
  if (typeof module !== "undefined" && module.exports) { module.exports = CLLOG; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
