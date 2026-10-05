// plugin/vg-seq.js — Voice Gen chọn sẵn bin + thư mục lưu voice theo sequence đang mở.
// Cùng quy ước với trang Auto của Autocut (bridge/autoset-names.js):
//   sequence  "{sp} vid{set}.{idx} [c.{CO}] [{Editor}]"   vd "AeriSoft vid31.0 [c.trang] [viet]"
//   bin       "Voice Over / {set}x"
//   thư mục   học từ nơi voice của các bộ trước nằm (…/Voice|VO|Voice Over/Nx), bin học theo;
//             chưa có voice → thư mục voice cạnh .prproj, trong <SP>/Source, hoặc <SP>
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
  function findVoiceDirName(names) {
    var list = names || [], i;
    for (i = 0; i < list.length; i++) {
      if (/^(voice\s*over|voiceover|vo)$/i.test(String(list[i]).trim())) return list[i];
    }
    for (i = 0; i < list.length; i++) {
      if (/^voices?$/i.test(String(list[i]).trim())) return list[i];
    }
    return null;
  }
  function pickVoiceOverDir(names) { return findVoiceDirName(names) || 'Voice Over'; }

  var VOICE_DIR_RE = /^(voice\s*over|voiceover|vo|voices?)$/i;
  var OLD_SEG_RE = /^(old|cũ|archive|backup)$/i;

  // Học từ project: entries [{bin: đường dẫn bin, dir: thư mục chứa file audio}] của các clip
  // audio. Mẫu hợp lệ = file nằm trong thư mục "Nx" mà thư mục cha là thư mục voice (Voice
  // Over / VO / Voice…) — ở đâu cũng được (Editing File/Voice/39x, Source/VO/12x…), bin tên
  // gì cũng được; bỏ bin có đoạn OLD/archive. Bộ này đã có voice → đúng thư mục + bin đó;
  // không thì bộ có N lớn nhất, đặt bộ mới cạnh nó. Bin học theo (… / 39x → … / 40x), bin
  // không kết thúc bằng Nx → "Voice Over / {set}x". → {dir, bin, basis: bin mẫu, from: thư mục mẫu} | null.
  function inferVoiceDir(entries, set) {
    var best = null, want = String(set);
    (entries || []).forEach(function (e) {
      var bin = String(e.bin || '').trim();
      if (bin.split('/').some(function (seg) { return OLD_SEG_RE.test(seg.trim()); })) return;
      var dir = String(e.dir || '').replace(/\/+$/, '');
      var parts = dir.split('/');
      var m = /^(\d+)x$/i.exec(parts[parts.length - 1] || '');
      if (!m || !VOICE_DIR_RE.test((parts[parts.length - 2] || '').trim())) return;
      var n = parseInt(m[1], 10);
      var rank = String(n) === want ? Infinity : n;
      if (!best || rank > best.rank) best = { rank: rank, n: n, dir: dir, bin: bin };
    });
    if (!best) return null;
    var bm = /^(.*?)(\d+)x$/i.exec(best.bin);
    var bin = (bm && parseInt(bm[2], 10) === best.n) ? bm[1] + want + 'x' : 'Voice Over / ' + want + 'x';
    var dir = best.rank === Infinity ? best.dir : best.dir.slice(0, best.dir.lastIndexOf('/')) + '/' + want + 'x';
    return { dir: dir, bin: bin, basis: best.bin, from: best.dir };
  }

  // Thư mục bro chọn lúc lưu có phải thư mục bộ plugin gợi ý không. So sau khi chuẩn hoá (NFC — đĩa
  // Mac / Google Drive trả dạng tách dấu, bỏ "/" cuối, không phân biệt hoa thường); hoặc thư mục
  // chọn kết thúc bằng đúng "{bộ}x" của bin gợi ý (vd …/Voice/36x ↔ bin "Voice Over / 36x").
  // Trước đây so nguyên chuỗi → lệch một ký tự là voice rơi về bin chung "Voice Over" (bug 2026-10-05).
  function sameVoiceDir(picked, suggested, bin) {
    function n(p) { var t = String(p || ''); try { t = t.normalize('NFC'); } catch (e) {} return t.replace(/\/+$/, '').toLowerCase(); }
    if (n(picked) && n(picked) === n(suggested)) return true;
    var want = /(\d+)x\s*$/i.exec(String(bin || '')), got = /\/(\d+)x$/i.exec(n(picked));
    return !!(want && got && want[1] === got[1]);
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

  // Ô bin Settings nhận biến {bộ}: "Voice Over / {bộ}x" → "Voice Over / 36x" theo sequence đang mở.
  // Không biết bộ → bỏ đoạn bin chứa {bộ} ("Voice Over"). Không có biến → giữ nguyên.
  var SET_VAR_RE = /\{\s*(?:bộ|bo|set)\s*\}/i;
  function applySetVar(bin, set) {
    var b = String(bin || '');
    if (!SET_VAR_RE.test(b)) return b;
    var segs = b.split('/').map(function (x) { return x.trim(); }).filter(Boolean);
    if (set) return segs.map(function (x) { return x.replace(new RegExp(SET_VAR_RE.source, 'gi'), set); }).join(' / ');
    var keep = segs.filter(function (x) { return !SET_VAR_RE.test(x); });
    return keep.join(' / ') || 'Voice Over';
  }
  // Ô ghi cứng số bộ ("… / 34x") khác bộ đang mở → {stale: '34', fixed: '… / {bộ}x'}; không thì null.
  function staleSetBin(bin, set) {
    var b = String(bin || '');
    if (!set || SET_VAR_RE.test(b)) return null;
    var m = /^(.*?)(\d+)x\s*$/i.exec(b);
    if (!m || m[2].replace(/^0+(?=\d)/, '') === String(set)) return null;
    return { stale: m[2], fixed: m[1] + '{bộ}x' };
  }

  return { applySetVar: applySetVar, staleSetBin: staleSetBin, parseSeqSet: parseSeqSet, inferVoiceDir: inferVoiceDir, sameVoiceDir: sameVoiceDir, findVoiceDirName: findVoiceDirName, pickVoiceOverDir: pickVoiceOverDir, pickSetDir: pickSetDir, buildTarget: buildTarget };
})();

(function (root) {
  if (root) { root.VGSEQ = VGSEQ; }
  if (typeof module !== "undefined" && module.exports) { module.exports = VGSEQ; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
