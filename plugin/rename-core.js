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

  function nfc(s) { s = String(s == null ? '' : s); return typeof s.normalize === 'function' ? s.normalize('NFC') : s; }

  // Số "có nghĩa" trong tên gốc (đã bỏ đuôi): tên chỉ toàn số ("41") hoặc tên bin + số
  // ("Senyue 41", "senyue_041"). Tên kiểu máy quay (IMG_4821, DSC_0012…) → null.
  function keptNumber(base, bin) {
    var b = nfc(base).trim(), m = /^(\d+)$/.exec(b);
    if (m) return m[1];
    var bn = nfc(bin).trim();
    if (!bn) return null;
    var esc = bn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    m = new RegExp('^' + esc + '[\\s_\\-]*(\\d+)$', 'i').exec(b);
    return m ? m[1] : null;
  }

  // Token: {bin} {n} {name} {num}. Token lạ để nguyên cho người dùng thấy mình gõ sai.
  function renderName(tpl, ctx, width) {
    var out = String(tpl || '').replace(/\{(bin|n|name|num)\}/g, function (m, k) {
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
  // Bỏ phần "bản copy" Finder/Premiere hay thêm: "Copy of X", "X copy", "X copy 2", "X (2)".
  var COPY_RES = [/^copy of\s+(.+)$/i, /^(.+?)\s+copy(?:\s+\d+)?$/i, /^(.+?)\s*\(\d+\)$/];
  function stripCopy(base) {
    var b = nfc(base).trim(), copy = false;
    for (var guard = 0; guard < 5; guard++) {
      var hit = false;
      for (var i = 0; i < COPY_RES.length; i++) {
        var m = COPY_RES[i].exec(b);
        if (m) { b = m[1].trim(); copy = hit = true; break; }
      }
      if (!hit) break;
    }
    return { base: b, copy: copy };
  }

  // → {num: chuỗi số gốc | null, copy: là bản copy?}
  function numberInfo(base, bin) {
    var c = stripCopy(base);
    return { num: keptNumber(c.base, bin), copy: c.copy };
  }

  // {num} theo từng bin. Thứ tự giành số: (1) tên "thật" có số (41, Senyue 41) — trùng số
  // thì dòng đầu giữ; (2) bản copy (Copy of 1…) giữ số nếu chưa ai giữ. Còn lại lấy số
  // mới nối tiếp sau số lớn nhất đã giữ của bin (không có thì từ ô "Bắt đầu từ", và
  // không thấp hơn ô đó).
  // → [{num, kind:'keep'|'new', copyOf, dupOf}]
  // occupied: {bin (thường) → [số]} — số đã có file khác dùng trong thư mục trên đĩa
  // (file không nằm trong lượt / bị bỏ tick). Không ai được lấy lại số đó, và số mới nối
  // tiếp sau cả những số này.
  function assignNums(rows, start, occupied) {
    var groups = {}, order = [];
    function group(g) {
      if (!groups[g]) {
        groups[g] = { taken: {}, max: -1, idx: [] }; order.push(g);
        ((occupied && occupied[g]) || []).forEach(function (v) {
          groups[g].taken[v] = true; groups[g].max = Math.max(groups[g].max, v);
        });
      }
      return groups[g];
    }
    var info = rows.map(function (r, i) {
      var g = nfc(r.bin).toLowerCase();
      group(g);
      groups[g].idx.push(i);
      var ni = numberInfo(splitExt(r.oldName).base, r.bin);
      return { g: g, raw: ni.num, copy: ni.copy, value: null, kind: 'new', copyOf: ni.copy && ni.num !== null ? ni.num : '', dupOf: '' };
    });
    function claim(x) {
      var G = groups[x.g], v = parseInt(x.raw, 10);
      if (G.taken[v]) return false;
      G.taken[v] = true;
      G.max = Math.max(G.max, v);
      x.value = v; x.kind = 'keep';
      return true;
    }
    info.forEach(function (x) { if (x.raw !== null && !x.copy && !claim(x)) x.dupOf = x.raw; });
    info.forEach(function (x) { if (x.raw !== null && x.copy) claim(x); });
    // Mỗi số tự giữ độ dài (tối thiểu 2; số gốc "033" giữ 3 chữ số) — KHÔNG đệm cả bin
    // theo số dài nhất: thêm file làm số mới vượt 99 thì file đã đổi (Senyue_09) vẫn y nguyên.
    order.forEach(function (g) {
      var G = groups[g], next = Math.max(G.max + 1, start);
      G.idx.forEach(function (i) {
        var x = info[i];
        if (x.value === null) { while (G.taken[next]) next++; x.value = next++; }
        x.num = pad(x.value, Math.max(2, x.kind === 'keep' ? x.raw.length : 0));
      });
    });
    return info;
  }

  // opts.occupied — xem assignNums.
  function buildPreview(rows, tpl, start, opts) {
    rows = rows || [];
    var s = parseInt(start, 10);
    if (isNaN(s) || s < 0) s = 1;
    var w = padWidth(s, rows.length);
    var useNum = /\{num\}/.test(String(tpl || ''));
    var nums = useNum ? assignNums(rows, s, opts && opts.occupied) : null;
    var out = rows.map(function (r, i) {
      var p = splitExt(r.oldName);
      var base = renderName(tpl, { bin: r.bin, n: s + i, name: p.base, num: nums ? nums[i].num : '' }, w);
      var nn = base + p.ext;
      return { path: r.path, oldName: r.oldName, newName: nn, error: nameError(nn), same: nn === r.oldName,
        numKind: nums ? nums[i].kind : '', numCopyOf: nums ? nums[i].copyOf : '', numDupOf: nums ? nums[i].dupOf : '' };
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
    keptNumber: keptNumber,
    numberInfo: numberInfo,
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
