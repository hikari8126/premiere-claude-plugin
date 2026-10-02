// plugin/vg-seq.js — Voice Gen chọn sẵn bin + thư mục lưu voice theo sequence đang mở.
// Cùng quy ước với trang Auto của Autocut (bridge/autoset-names.js):
//   sequence  "{sp} vid{set}.{idx} [c.{CO}] [{Editor}]"   vd "AeriSoft vid31.0 [c.trang] [viet]"
//   bin       "Voice Over / {set}x"
//   thư mục   học từ bin "Voice Over / Nx" đã có voice (cạnh thư mục của bộ gần nhất);
//             không có thì "<thư mục chứa .prproj>/Voice Over|VO|Voice/{set}x"
//   tên file  "{set}.{idx} - {voice}"
// Logic thuần, không đụng Premiere → test bằng Node (bridge/test/vg-seq.test.js). ES5.

var VGSEQ = (function () {
  // "vid31.0" → {set:'31', idx:'0', label:'31.0'}; bỏ số 0 đầu của bộ như autoset-names.
  function parseSeqSet(name) {
    var m = /(?:^|[^a-z0-9])vid\s*(\d+)\.(\d+)(?![\d.])/i.exec(String(name || ''));
    if (!m) return null;
    var set = m[1].replace(/^0+(?=\d)/, '');
    return { set: set, idx: m[2], label: set + '.' + m[2] };
  }

  // Thư mục voice cạnh .prproj: ưu tiên "Voice Over"/"VoiceOver"/"VO" (như autoset-names),
  // rồi tới "Voice" (project thật hay dùng "Editing File/Voice/39x"). Giữ đúng tên trên đĩa.
  function pickVoiceOverDir(names) {
    var list = names || [], i;
    for (i = 0; i < list.length; i++) {
      if (/^(voice\s*over|voiceover|vo)$/i.test(String(list[i]).trim())) return list[i];
    }
    for (i = 0; i < list.length; i++) {
      if (/^voices?$/i.test(String(list[i]).trim())) return list[i];
    }
    return 'Voice Over';
  }

  // Học từ project: entries [{bin: "Voice Over / 39x", dir: thư mục chứa file voice}].
  // Bin đúng bộ này đã có voice → dùng thư mục đó; không thì lấy bin "Voice Over / Nx"
  // có N lớn nhất (bộ gần nhất) mà file nằm trong thư mục "Nx", đặt bộ mới cạnh nó.
  // Bin "Voice Over / OLD / …" hay thư mục không theo kiểu Nx (Downloads…) bị bỏ qua.
  // → {dir, basis: tên bin dựa vào} | null.
  function inferVoiceDir(entries, set) {
    var best = null, want = String(set);
    (entries || []).forEach(function (e) {
      var m = /^voice\s*over\s*\/\s*(\d+)x$/i.exec(String(e.bin || '').trim());
      if (!m) return;
      var dir = String(e.dir || '').replace(/\/+$/, '');
      var leaf = dir.slice(dir.lastIndexOf('/') + 1);
      if (!new RegExp('^' + m[1] + 'x$', 'i').test(leaf)) return;
      var n = parseInt(m[1], 10);
      if (String(n) === want) { best = { n: Infinity, dir: dir, basis: String(e.bin).trim() }; return; }
      if (!best || n > best.n) best = { n: n, dir: dir, basis: String(e.bin).trim() };
    });
    if (!best) return null;
    if (best.n === Infinity) return { dir: best.dir, basis: best.basis };
    return { dir: best.dir.slice(0, best.dir.lastIndexOf('/')) + '/' + want + 'x', basis: best.basis };
  }

  function pickSetDir(names, set) {
    var want = String(set) + 'x', list = names || [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i]).toLowerCase() === want.toLowerCase()) return list[i];
    }
    return want;
  }

  // projDirs: tên thư mục con cạnh .prproj; setDirs: tên thư mục con trong Voice Over.
  function buildTarget(projectPath, parsed, projDirs, setDirs) {
    var pp = String(projectPath || '');
    if (!pp || pp.charAt(0) !== '/' || !parsed) return null;
    var projDir = pp.slice(0, pp.lastIndexOf('/'));
    var vo = pickVoiceOverDir(projDirs);
    var sd = pickSetDir(setDirs, parsed.set);
    return {
      dir: projDir + '/' + vo + '/' + sd,
      bin: 'Voice Over / ' + parsed.set + 'x',
      namePart: parsed.label,
      voDir: vo,
      setDir: sd
    };
  }

  return { parseSeqSet: parseSeqSet, inferVoiceDir: inferVoiceDir, pickVoiceOverDir: pickVoiceOverDir, pickSetDir: pickSetDir, buildTarget: buildTarget };
})();

(function (root) {
  if (root) { root.VGSEQ = VGSEQ; }
  if (typeof module !== "undefined" && module.exports) { module.exports = VGSEQ; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
