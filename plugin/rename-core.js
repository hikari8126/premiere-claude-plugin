// plugin/rename-core.js — logic thuần của "Đổi tên source hàng loạt" (tab Watch):
// dựng tên mới theo mẫu, đánh số, kiểm tra trùng trong lượt. Không đụng Premiere
// nên test được bằng Node (bridge/test/rename-core.test.js). Bridge kiểm tra lại
// phía đĩa (bridge/rename-ops.js) — ở đây chỉ để bảng xem trước báo lỗi ngay.
//
// Giữ ES5 (không let/const/arrow) cho khớp phần còn lại của plugin.

var RNC = (function () {
  // Tên file → { base, ext }. Đuôi giữ nguyên hoa/thường; dotfile không có đuôi.
  function splitExt(name) {
    name = String(name || '');
    var i = name.lastIndexOf('.');
    if (i <= 0) return { base: name, ext: '' };
    return { base: name.slice(0, i), ext: name.slice(i) };
  }

  function baseName(p) { return String(p || '').split('/').pop(); }
  function dirName(p) { var s = String(p || ''); var i = s.lastIndexOf('/'); return i < 0 ? '' : s.slice(0, i); }

  // So sánh tự nhiên: "IMG_2" trước "IMG_10" (cùng kiểu natCmp ở watchfolder-browse.js).
  function natCmp(a, b) {
    var re = /(\d+)|(\D+)/g;
    var as = String(a).toLowerCase().match(re) || [];
    var bs = String(b).toLowerCase().match(re) || [];
    for (var i = 0; i < Math.max(as.length, bs.length); i++) {
      var x = as[i], y = bs[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      var nx = /^\d/.test(x), ny = /^\d/.test(y);
      if (nx && ny) { var d = Number(x) - Number(y); if (d) return d < 0 ? -1 : 1; }
      else if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  // Số chữ số cho {n}: theo số lớn nhất của lượt, tối thiểu 2 (01…09).
  function padWidth(start, count) {
    var last = (parseInt(start, 10) || 1) + Math.max(0, (count || 0) - 1);
    return Math.max(2, String(last).length);
  }

  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }

  // Token: {bin} {n} {name}. Token lạ để nguyên cho người dùng thấy mình gõ sai.
  function renderName(tpl, ctx, width) {
    var out = String(tpl || '').replace(/\{(bin|n|name)\}/g, function (m, k) {
      if (k === 'n') return pad(ctx.n, width || 2);
      return String(ctx[k] == null ? '' : ctx[k]);
    });
    return out.trim();
  }

  function utf8Len(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  // Lý do tên file không dùng được, '' nếu ổn. Cùng luật với bridge/rename-ops.js.
  function nameError(name) {
    name = String(name || '');
    if (!splitExt(name).base.trim() || name.charAt(0) === '.') return 'Tên trống hoặc bắt đầu bằng dấu chấm';
    if (/[\/:]/.test(name)) return 'Tên không được chứa / hoặc :';
    if (/[\u0000-\u001f\u007f]/.test(name)) return 'Tên chứa ký tự điều khiển';
    if (utf8Len(name) > 255) return 'Tên dài quá 255 byte';
    return '';
  }

  // entries [{path, bin, item, name}] → rows [{path, oldName, bin, items}]; nhiều item
  // cùng trỏ một file gộp thành 1 dòng (file đổi tên 1 lần), giữ thứ tự gặp đầu.
  function groupByPath(entries) {
    var rows = [], byKey = {};
    (entries || []).forEach(function (e) {
      var k = String(e.path);
      if (byKey[k]) { byKey[k].items.push(e.item); return; }
      var r = { path: k, oldName: baseName(k), bin: e.bin || '', items: [e.item] };
      byKey[k] = r;
      rows.push(r);
    });
    return rows;
  }

  function sortRows(rows) {
    return (rows || []).slice().sort(function (a, b) { return natCmp(a.oldName, b.oldName); });
  }

  function moveRow(rows, i, dir) {
    var out = (rows || []).slice(), j = i + dir;
    if (i < 0 || i >= out.length || j < 0 || j >= out.length) return out;
    var t = out[i]; out[i] = out[j]; out[j] = t;
    return out;
  }

  function key(dir, name) {
    var s = dir + '/' + name;
    if (typeof s.normalize === 'function') s = s.normalize('NFC');
    return s.toLowerCase();
  }

  // rows (đã theo thứ tự) → [{path, oldName, newName, error, same}]. Trùng tên trong
  // CÙNG thư mục (không phân biệt hoa/thường — APFS mặc định vậy) báo lỗi mọi dòng dính.
  function buildPreview(rows, tpl, start) {
    rows = rows || [];
    var s = parseInt(start, 10);
    if (isNaN(s) || s < 0) s = 1;
    var w = padWidth(s, rows.length);
    var out = rows.map(function (r, i) {
      var p = splitExt(r.oldName);
      var base = renderName(tpl, { bin: r.bin, n: s + i, name: p.base }, w);
      var nn = base + p.ext;
      return { path: r.path, oldName: r.oldName, newName: nn, error: nameError(nn), same: nn === r.oldName };
    });
    var seen = {};
    out.forEach(function (r, i) {
      if (r.error) return;
      var k = key(dirName(r.path), r.newName);
      (seen[k] = seen[k] || []).push(i);
    });
    Object.keys(seen).forEach(function (k) {
      if (seen[k].length < 2) return;
      seen[k].forEach(function (i) { out[i].error = 'Trùng tên với dòng khác trong lượt'; });
    });
    return out;
  }

  return {
    splitExt: splitExt,
    natCmp: natCmp,
    padWidth: padWidth,
    renderName: renderName,
    nameError: nameError,
    groupByPath: groupByPath,
    sortRows: sortRows,
    moveRow: moveRow,
    buildPreview: buildPreview
  };
})();

(function (root) {
  if (root) { root.RNC = RNC; }
  if (typeof module !== "undefined" && module.exports) { module.exports = RNC; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
