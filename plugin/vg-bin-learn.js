// plugin/vg-bin-learn.js — Voice Gen tự chọn bin import theo project (global VGBIN).
// Hàm thuần trên danh sách item dạng sacCollectBinItems(): { name, path, isFolder, mediaType }
// (path = bin chứa item, các cấp nối bằng " / ", rỗng = gốc project).
// Test ở bridge/test/vg-bin-learn.test.js.
//
//   Giọng : bin "<gốc> / {N}x" đang chứa audio của các bộ trước → "<gốc> / {bộ}x".
//           Gốc lấy theo nơi xuất hiện nhiều nhất (Voice Over, Audio / VO, …).
//   SFX   : bin chứa nhiều audio nhất trong nhánh có tên kiểu SFX / Sound FX.
//   Nhạc  : bin chứa nhiều audio nhất trong nhánh có tên kiểu BGM / Music / Nhạc.
//   Không học được → mặc định (Voice Over / {bộ}x, SFX, BGM).

var VGBIN = (function () {
  var DEFAULTS = { tts: 'Voice Over', sfx: 'SFX', music: 'BGM' };
  var RE_SET_BIN = /^(\d{1,4})\s*x$/i;                                    // "39x"
  var RE_SFX = /(^|[^a-z])(sfx|sound\s*(fx|effects?)|hiệu\s*ứng)([^a-z]|$)/i;
  var RE_MUSIC = /(^|[^a-z])(bgms?|music|nhạc|songs?)([^a-z]|$)/i;

  function segs(path) { return String(path || '').split(' / ').map(function (x) { return x.trim(); }).filter(Boolean); }
  function isAudio(it) { return it && !it.isFolder && it.mediaType === 'audio'; }

  // Đếm theo khoá, trả khoá nhiều nhất (hoà → khoá xuất hiện trước).
  function topKey(counts, order) {
    var best = '', n = 0;
    order.forEach(function (k) { if (counts[k] > n) { n = counts[k]; best = k; } });
    return best;
  }

  function learnVoice(items, set) {
    var counts = {}, order = [];
    (items || []).forEach(function (it) {
      if (!isAudio(it)) return;
      var p = segs(it.path);
      for (var i = p.length - 1; i >= 0; i--) {
        if (!RE_SET_BIN.test(p[i])) continue;
        var root = p.slice(0, i).join(' / ');
        if (!(root in counts)) { counts[root] = 0; order.push(root); }
        counts[root]++;
        break;
      }
    });
    if (!order.length) return null;
    var root = topKey(counts, order);
    var tail = set ? set + 'x' : '{bộ}x';
    return root ? root + ' / ' + tail : tail;
  }

  // Bin (đường dẫn đầy đủ) chứa nhiều audio nhất mà có một cấp khớp re.
  function learnByName(items, re) {
    var counts = {}, order = [];
    (items || []).forEach(function (it) {
      if (!isAudio(it)) return;
      var p = segs(it.path);
      var hit = -1;
      for (var i = 0; i < p.length; i++) if (re.test(p[i])) { hit = i; break; }
      if (hit < 0) return;
      var key = p.join(' / ');
      if (!(key in counts)) { counts[key] = 0; order.push(key); }
      counts[key]++;
    });
    if (order.length) return topKey(counts, order);
    // Chưa có audio nào → bin rỗng có tên khớp cũng được (lấy cái nông nhất).
    var best = null;
    (items || []).forEach(function (it) {
      if (!it || !it.isFolder || !re.test(it.name)) return;
      var full = segs(it.path).concat([it.name]);
      if (!best || full.length < best.length) best = full;
    });
    return best ? best.join(' / ') : null;
  }

  // → { tts, sfx, music, learned: { tts: bool, … } }
  function learn(items, set) {
    var v = learnVoice(items, set);
    var s = learnByName(items, RE_SFX);
    var m = learnByName(items, RE_MUSIC);
    return {
      tts: v || (set ? DEFAULTS.tts + ' / ' + set + 'x' : DEFAULTS.tts),
      sfx: s || DEFAULTS.sfx,
      music: m || DEFAULTS.music,
      learned: { tts: !!v, sfx: !!s, music: !!m },
    };
  }

  return { learn: learn, learnVoice: learnVoice, learnByName: learnByName, DEFAULTS: DEFAULTS, RE_SFX: RE_SFX, RE_MUSIC: RE_MUSIC };
})();

if (typeof module !== "undefined" && module.exports) { module.exports = VGBIN; }
