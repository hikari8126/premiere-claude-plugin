// plugin/bin-core.js — đọc / sắp bin cho tab Claude (global BINC). Hàm thuần trên danh sách
// item dạng sacCollectBinItems(): { name, path, isFolder, mediaType } (path = bin chứa item,
// các cấp nối bằng " / ", rỗng = gốc project). Test ở bridge/test/bin-core.test.js.
//
// Tham chiếu một item: "<bin> ▸ <tên>" (gốc: "▸ <tên>") — Claude đọc từ kết quả tool rồi gửi
// lại trong action move_items; plugin đối chiếu lại với project trước khi chuyển.

var BINC = (function () {
  var SEP = ' ▸ ';
  var MAX_LINES = 200;

  function norm(s) {
    var t = String(s == null ? '' : s);
    if (t.normalize) t = t.normalize('NFC');
    return t.replace(/\s+/g, ' ').trim().toLowerCase();
  }
  function segs(path) { return String(path || '').split(' / ').map(function (x) { return x.trim(); }).filter(Boolean); }
  function joinPath(parts) { return parts.join(' / '); }

  // Bin gốc của voice: "Voice Over" (dự án cũ hay đặt "VO" / "VoiceOver") — cùng quy ước ppGetOrCreateBin.
  function isVoiceRoot(seg) { return /^(voice\s*over|vo)$/i.test(String(seg || '').trim()); }

  // So hai đường dẫn bin, coi "VO" ≡ "Voice Over" ở cấp đầu.
  function samePath(a, b) {
    var x = segs(a), y = segs(b);
    if (x.length !== y.length) return false;
    for (var i = 0; i < x.length; i++) {
      if (i === 0 && isVoiceRoot(x[0]) && isVoiceRoot(y[0])) continue;
      if (norm(x[i]) !== norm(y[i])) return false;
    }
    return true;
  }
  function under(path, parent) {                  // path nằm trong parent (kể cả bằng)
    var x = segs(path), y = segs(parent);
    if (x.length < y.length) return false;
    return samePath(joinPath(x.slice(0, y.length)), parent);
  }

  function refOf(it) { return (it.path ? it.path : '') + SEP + it.name; }
  function parseRef(ref) {
    var s = String(ref || ''), i = s.lastIndexOf(SEP.trim());
    if (i < 0) return { path: '', name: s.trim() };
    return { path: s.slice(0, i).trim(), name: s.slice(i + SEP.trim().length).trim() };
  }

  function cap(lines, total, what) {
    if (lines.length <= MAX_LINES) return lines;
    return lines.slice(0, MAX_LINES).concat(['… còn ' + (total - MAX_LINES) + ' ' + what + ' — thu hẹp bằng list_bin / find_items']);
  }

  // Cây bin: mỗi bin một dòng + số item trực tiếp.
  function binTree(items) {
    var count = Object.create(null), bins = [];
    items.forEach(function (it) {
      if (it.isFolder) bins.push(it.path ? it.path + ' / ' + it.name : it.name);
      else { var k = norm(it.path); count[k] = (count[k] || 0) + 1; }
    });
    bins.sort(function (a, b) { return a.localeCompare(b); });
    var root = count[''] || 0;
    var lines = ['(gốc project) — ' + root + ' item'].concat(bins.map(function (b) {
      return b + ' — ' + (count[norm(b)] || 0) + ' item';
    }));
    return cap(lines, lines.length, 'bin').join('\n');
  }

  function itemLine(it) { return refOf(it) + '  (' + (it.mediaType || 'item') + ')'; }

  function listBin(items, path, recursive) {
    var hit = items.filter(function (it) {
      return !it.isFolder && (recursive ? under(it.path, path) : samePath(it.path, path));
    });
    if (!path && !recursive) hit = items.filter(function (it) { return !it.isFolder && !it.path; });
    if (!hit.length) return 'Bin "' + (path || '(gốc)') + '" không có item' + (recursive ? '' : ' (thử recursive: true)') + '.';
    return cap(hit.map(itemLine), hit.length, 'item').join('\n');
  }

  function findItems(items, text) {
    var q = norm(text);
    if (!q) return 'Thiếu chữ cần tìm.';
    var hit = items.filter(function (it) { return !it.isFolder && norm(it.name).indexOf(q) >= 0; });
    if (!hit.length) return 'Không có item nào tên chứa "' + text + '".';
    return cap(hit.map(itemLine), hit.length, 'item').join('\n');
  }

  // "40.0 - Audrey.mp3" → bộ 40 → bin "Voice Over / 40x". Chỉ file audio.
  function voiceTarget(it) {
    if (!it || it.isFolder || it.mediaType !== 'audio') return null;
    var m = String(it.name).match(/^\s*0*(\d+)\.(\d+)\s*-\s*\S/);
    if (!m) return null;
    return { set: m[1], idx: m[2], bin: 'Voice Over / ' + m[1] + 'x' };
  }

  // Voice có số phiên bản nằm sai bin / ngoài bin chuẩn → danh sách cần chuyển.
  function planVoiceMoves(items) {
    var out = [];
    items.forEach(function (it) {
      var t = voiceTarget(it);
      if (t && !samePath(it.path, t.bin)) out.push({ ref: refOf(it), name: it.name, from: it.path || '(gốc)', to: t.bin });
    });
    return out;
  }

  // Đối chiếu yêu cầu chuyển (từ Claude hoặc planVoiceMoves) với project hiện tại.
  // moves: [{item: "<bin> ▸ <tên>", to: "<bin đích>"}] → [{ref, name, from, to, index, error}]
  function resolveMoves(items, moves) {
    return (moves || []).map(function (mv) {
      var r = parseRef(mv && (mv.item || mv.ref)), to = String((mv && mv.to) || '').trim();
      var row = { ref: refOf({ path: r.path, name: r.name }), name: r.name, from: r.path || '(gốc)', to: to, index: -1, error: '' };
      if (!r.name) { row.error = 'thiếu tên item'; return row; }
      if (!segs(to).length) { row.error = 'thiếu bin đích'; return row; }
      var idx = [];
      items.forEach(function (it, i) { if (!it.isFolder && norm(it.name) === norm(r.name) && samePath(it.path, r.path)) idx.push(i); });
      if (!idx.length) row.error = 'không tìm thấy trong project (đã đổi tên / chuyển?)';
      else if (idx.length > 1) row.error = 'có ' + idx.length + ' item trùng tên trong cùng bin — chuyển tay';
      else if (samePath(r.path, to)) row.error = 'đã ở đúng bin';
      else row.index = idx[0];
      return row;
    });
  }

  // Tham chiếu sequence (từ list_bin / find_items) → dòng đã đối chiếu: [{ref, name, index, error}].
  // Chỉ nhận item loại sequence; không có / trùng tên trong cùng bin → báo lỗi.
  function resolveSeqRefs(items, refs) {
    return (refs || []).map(function (ref) {
      var r = parseRef(ref), row = { ref: refOf({ path: r.path, name: r.name }), name: r.name, index: -1, error: '' };
      if (!r.name) { row.error = 'thiếu tên sequence'; return row; }
      var idx = [];
      items.forEach(function (it, i) { if (!it.isFolder && norm(it.name) === norm(r.name) && samePath(it.path, r.path)) idx.push(i); });
      if (!idx.length) row.error = 'không tìm thấy trong project';
      else if (idx.length > 1) row.error = 'có ' + idx.length + ' item trùng tên trong cùng bin';
      else if (items[idx[0]].mediaType !== 'sequence') row.error = 'không phải sequence';
      else row.index = idx[0];
      return row;
    });
  }

  return { SEP: SEP, norm: norm, resolveSeqRefs: resolveSeqRefs, isVoiceRoot: isVoiceRoot, samePath: samePath, under: under, refOf: refOf, parseRef: parseRef,
           binTree: binTree, listBin: listBin, findItems: findItems, voiceTarget: voiceTarget,
           planVoiceMoves: planVoiceMoves, resolveMoves: resolveMoves };
})();

(function (root) {
  if (root) { root.BINC = BINC; }
  if (typeof module !== "undefined" && module.exports) { module.exports = BINC; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
