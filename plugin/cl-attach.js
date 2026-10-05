// plugin/cl-attach.js — đính ảnh vào ô lệnh tab Claude + map sản phẩm → project (global CLATT). Thuần, có test.
//
// UXP không cho kéo thả / dán ảnh: dán (Cmd+V) ảnh chụp hoặc file ảnh từ Finder vào ô lệnh ra ĐƯỜNG DẪN file
// (thử 2026-10-05). extract() tách các đường dẫn ảnh khỏi lời lệnh → chip 📎; bridge đọc file khi gửi.

var CLATT = (function () {
  var EXT = 'png|jpe?g|webp|gif|heic';
  // "/Users/x/a b.png", "file:///Users/x/a%20b.png", "/Users/x/a\ b.png", có ngoặc kép / đơn quanh.
  var RE = new RegExp('(?:file://)?(/[^\\n"\']*?\\.(?:' + EXT + '))(?=$|[\\s"\'),;])', 'gi');

  function clean(p) {
    var t = String(p).replace(/\\ /g, ' ');
    if (/%[0-9a-f]{2}/i.test(t)) { try { t = decodeURIComponent(t); } catch (e) {} }
    return t;
  }
  // → {text: lời lệnh còn lại, paths: [đường dẫn ảnh]} (bỏ trùng, giữ thứ tự)
  function extract(text) {
    var paths = [];
    var rest = String(text || '').replace(RE, function (m, p) {
      var c = clean(p);
      if (paths.indexOf(c) < 0) paths.push(c);
      return ' ';
    }).replace(/["']\s*["']/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
    return { text: rest, paths: paths };
  }
  function isImage(p) { return new RegExp('\\.(?:' + EXT + ')$', 'i').test(String(p || '')); }
  function baseName(p) { return String(p || '').split('/').pop(); }

  // Sản phẩm (cột "Product code" của bảng NAV, vd "AeriSoft") → project đã biết [{path, name}].
  // So chữ+số không dấu: tên project trùng / mở đầu bằng sản phẩm, hoặc đường dẫn có thư mục mở đầu bằng sản phẩm.
  function key(s) {
    var t = String(s || '').toLowerCase();
    try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
    return t.replace(/đ/g, 'd').replace(/[^a-z0-9]/g, '');
  }
  function matchProject(projects, product) {
    var k = key(product);
    if (k.length < 3) return null;
    var list = Array.isArray(projects) ? projects : [];
    var score = function (p) {
      var n = key(p.name);
      if (n === k) return 3;
      if (n.indexOf(k) === 0) return 2;
      return String(p.path || '').split('/').some(function (seg) { return key(seg).indexOf(k) === 0; }) ? 1 : 0;
    };
    var best = null;
    list.forEach(function (p) {
      var s = score(p);
      if (s && (!best || s > best.s || (s === best.s && (p.last || 0) > (best.p.last || 0)))) best = { s: s, p: p };
    });
    return best ? best.p : null;
  }

  return { extract: extract, isImage: isImage, baseName: baseName, matchProject: matchProject, key: key };
})();

(function (root) {
  if (root) { root.CLATT = CLATT; }
  if (typeof module !== "undefined" && module.exports) { module.exports = CLATT; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
