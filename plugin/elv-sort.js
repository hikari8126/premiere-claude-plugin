// plugin/elv-sort.js — hàm so sánh thuần cho sort list voice clone (Settings ▸ Voice Gen).
// Classic script nạp TRƯỚC main.js (expose global elvSortComparator); export cho node để test.
// KHÔNG đụng DOM. Thiết kế: docs/superpowers/specs/2026-09-24-voicegen-sort-voices-design.md

function elvSortComparator(mode) {
  function byName(a, b) {
    return String(a && a.name || '').localeCompare(String(b && b.name || ''), undefined, { sensitivity: 'base' });
  }
  function created(v) { return (v && typeof v.created === 'number') ? v.created : null; }

  if (mode === 'name_az') return byName;
  if (mode === 'name_za') return function (a, b) { return -byName(a, b); };

  // newest (mặc định) hoặc oldest — theo created, null luôn cuối, tie-break theo name.
  var dir = (mode === 'oldest') ? 1 : -1;
  return function (a, b) {
    var ca = created(a), cb = created(b);
    if (ca == null && cb == null) return byName(a, b);
    if (ca == null) return 1;   // a không có created -> xuống cuối
    if (cb == null) return -1;  // b không có created -> xuống cuối
    if (ca === cb) return byName(a, b);
    return (ca < cb ? -1 : 1) * dir;
  };
}

(function (root) {
  if (root) { root.elvSortComparator = elvSortComparator; }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { elvSortComparator: elvSortComparator };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
