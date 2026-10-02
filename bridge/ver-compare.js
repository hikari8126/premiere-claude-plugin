// bridge/ver-compare.js — BẢN SAO của plugin/ver-compare.js (bundle Bridge app chỉ có bridge/*.js).
// Sửa thì sửa cả hai; test/ver-compare.test.js kiểm hai bản cho kết quả giống nhau.
// "1.22.1-beta.1".split('.').map(Number) cũ ra NaN → so sai (bridge beta bị coi là cũ).
// Bản pre-release nhỏ hơn bản chính cùng số: 1.22.1-beta.1 < 1.22.1, nhưng > 1.22.0.
// Non-module script cho UXP; require() được từ Node để test.

function verParse(v) {
  var m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.\-]+))?/);
  if (!m) return { core: [0], pre: null };
  return { core: m[1].split('.').map(Number), pre: m[2] || null };
}

// -1 / 0 / 1
function compareVersions(a, b) {
  var pa = verParse(a), pb = verParse(b);
  for (var i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    var d = (pa.core[i] || 0) - (pb.core[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;      // bản chính > pre-release
  if (pb.pre === null) return -1;
  var xa = pa.pre.split('.'), xb = pb.pre.split('.');
  for (var j = 0; j < Math.max(xa.length, xb.length); j++) {
    if (xa[j] === undefined) return -1;
    if (xb[j] === undefined) return 1;
    var na = /^\d+$/.test(xa[j]), nb = /^\d+$/.test(xb[j]);
    if (na && nb) { var dn = Number(xa[j]) - Number(xb[j]); if (dn) return dn > 0 ? 1 : -1; }
    else if (xa[j] !== xb[j]) return xa[j] > xb[j] ? 1 : -1;
  }
  return 0;
}

(function (root) {
  if (root) { root.compareVersions = compareVersions; }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { compareVersions: compareVersions };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
