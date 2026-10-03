// plugin/claude-log.js — hàm thuần cho nhật ký lệnh tab Claude (global CLLOG):
// render câu trả lời, lịch sử lưu 20 lệnh, nhãn sequence, đếm giây. Test ở
// bridge/test/claude-log.test.js. Phần DOM ở claude-tab.js.

var CLLOG = (function () {
  var MAX_HISTORY = 20;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Link: chỉ http/https; hiện tên miền + đường dẫn rút gọn khi là link trần.
  function linkHtml(url, label) {
    var u = String(url).replace(/[).,;:!?]+$/, '');
    var text = label || u.replace(/^https?:\/\/(www\.)?/i, '');
    if (!label && text.length > 42) text = text.slice(0, 40) + '…';
    return '<span class="cl-link" role="link" data-href="' + u.replace(/"/g, '&quot;') + '">' + text + '</span>';
  }

  // Định dạng trong dòng (chuỗi ĐÃ escape): `code`, **đậm**, *nghiêng*, [tên](url), link trần.
  function inline(s) {
    var keep = [];
    function hold(html) { keep.push(html); return '\u0001' + (keep.length - 1) + '\u0001'; }
    s = s.replace(/`([^`\n]+)`/g, function (_m, c) { return hold('<code>' + c + '</code>'); });
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, function (_m, t, u) { return hold(linkHtml(u, t)); });
    s = s.replace(/https?:\/\/[^\s<]+/g, function (u) {                 // dấu câu cuối không thuộc link
      var tail = (u.match(/[).,;:!?]+$/) || [''])[0];
      return hold(linkHtml(u.slice(0, u.length - tail.length))) + tail;
    });
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, '$1<em>$2</em>');      // *nghiêng*
    return s.replace(/\u0001(\d+)\u0001/g, function (_m, i) { return keep[+i]; });
  }

  // Câu trả lời của Claude → HTML: ẩn khối ```actions (plugin tự chạy), giữ khối code,
  // tiêu đề (#..###), gạch đầu dòng, danh sách số, đậm, `code`, link (bấm mở trình duyệt).
  // Chỉ còn khối actions → chuỗi rỗng.
  function renderReply(text) {
    var t = String(text || '').replace(/```(actions|remember)[\s\S]*?(```|$)/g, '').trim();
    if (!t) return '';
    var blocks = [];
    t = t.replace(/```\w*\n?([\s\S]*?)```/g, function (m, code, at, all) {
      blocks.push('<pre><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>');
      // khối code đứng một dòng riêng — chỉ thêm xuống dòng khi chưa có (khỏi đẻ dòng trống)
      var pre = (at === 0 || all.charAt(at - 1) === '\n') ? '' : '\n';
      var post = (at + m.length >= all.length || all.charAt(at + m.length) === '\n') ? '' : '\n';
      return pre + '\u0002' + (blocks.length - 1) + '\u0002' + post;
    });
    var out = [], blank = false;
    t.split('\n').forEach(function (raw) {
      var line = raw.replace(/\s+$/, ''), m;
      if (!line.trim()) { if (out.length && !blank) out.push('<div class="cl-gap"></div>'); blank = true; return; }
      blank = false;
      if ((m = line.match(/^\u0002(\d+)\u0002$/))) out.push(blocks[+m[1]]);
      else if ((m = line.match(/^#{1,4}\s+(.*)$/))) out.push('<div class="cl-h">' + inline(esc(m[1].replace(/\*\*/g, ''))) + '</div>');
      else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) out.push('<div class="cl-li"><span class="cl-bul">•</span><span class="cl-liText">' + inline(esc(m[1])) + '</span></div>');
      else if ((m = line.match(/^\s*(\d+)[.)]\s+(.*)$/))) out.push('<div class="cl-li"><span class="cl-bul">' + m[1] + '.</span><span class="cl-liText">' + inline(esc(m[2])) + '</span></div>');
      else out.push('<div>' + inline(esc(line)) + '</div>');
    });
    while (out.length && out[out.length - 1] === '<div class="cl-gap"></div>') out.pop();
    return out.join('');
  }

  // Thêm một lệnh vào lịch sử, giữ MAX_HISTORY lệnh mới nhất. Không sửa mảng gốc.
  function pushHistory(list, entry, max) {
    var out = (Array.isArray(list) ? list.slice() : []).concat([entry]);
    var cap = max || MAX_HISTORY;
    return out.length > cap ? out.slice(out.length - cap) : out;
  }

  // Ngữ cảnh gửi Claude: 2 lượt (user + assistant) cho mỗi lệnh đã xong, tối đa `max` lệnh
  // gần nhất (mặc định 8 — câu trả lời research dài, gửi cả 20 lệnh thì chậm).
  function toMessages(list, max) {
    var out = [], src = (list || []).filter(function (e) { return e && e.cmd && e.raw; });
    src = src.slice(Math.max(0, src.length - (max || 8)));
    src.forEach(function (e) {
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
