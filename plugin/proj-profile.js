// plugin/proj-profile.js — hồ sơ quy ước của project đang mở (global PPF). Thuần, có test.
//
// Mỗi người đặt bin khác nhau: "Sequence / GG / 35x" vs "Google / v1 / 35x", "FB" vs "Facebook".
// scan() đọc bin + sequence của project, rút ra:
//   alias  {FB:'Facebook', GG:'Google', PIN:'PIN', APP:'AppLovin'} — chữ người đó dùng cho từng nền tảng
//   bins   {GG:'Google / v1 / {bộ}x / {bộ}.{số}', FB:…} — mẫu bin học từ các bộ đã có
//   warns  ['…'] — chỗ đoán không chắc (hiện cảnh báo, không chặn)
// use(profile) đặt hồ sơ cho flow-engine / binset-core dùng thay chữ ghi cứng.

var PPF = (function () {
  // Từ đồng nghĩa (so chữ thường, bỏ khoảng trắng/gạch) → nền tảng.
  var WORDS = {
    FB:  ['fb', 'facebook', 'meta', 'face', 'fbads', 'facebookads', 'metaads'],
    GG:  ['gg', 'google', 'ggads', 'googleads', 'gads', 'youtube', 'yt'],
    PIN: ['pin', 'pinterest', 'pins'],
    APP: ['app', 'applovin', 'apl', 'al']
  };
  var DEFAULT = { alias: { FB: 'FB', GG: 'GG', PIN: 'PIN', APP: 'AppLovin' }, bins: {}, warns: [], learned: false };
  var cur = DEFAULT;

  function key(s) { return String(s || '').toLowerCase().replace(/[\s_\-.]+/g, ''); }
  function platOf(word) {
    var k = key(word);
    for (var P in WORDS) if (WORDS[P].indexOf(k) >= 0) return P;
    return '';
  }
  function segs(p) { return String(p || '').split('/').map(function (x) { return x.trim(); }).filter(Boolean); }
  function isSeq(it) { return it && !it.isFolder && it.mediaType === 'sequence'; }
  function vidOf(name) { var m = String(name).match(/vid\s*(\d+)\s*\.\s*(\d+)(?!\d)/i); return m ? { set: m[1], idx: m[2] } : null; }

  // Đường dẫn bin của một sequence → mẫu: "35x" → "{bộ}x", "35.1" → "{bộ}.{số}" (chỉ khi đúng bộ/số của nó).
  function generalize(path, v) {
    var hit = false;
    var out = segs(path).map(function (s) {
      if (v && new RegExp('^0*' + v.set + 'x$', 'i').test(s)) { hit = true; return '{bộ}x'; }
      if (v && new RegExp('^0*' + v.set + '\\.' + v.idx + '$').test(s)) { hit = true; return '{bộ}.{số}'; }
      return s;
    });
    return hit ? out.join(' / ') : '';
  }

  function top(counts) {
    var best = '', n = 0;
    Object.keys(counts).forEach(function (k) { if (counts[k] > n) { n = counts[k]; best = k; } });
    return best;
  }

  // items = bản chụp project [{name, path, isFolder, mediaType}]
  function scan(items) {
    var aliasCount = { FB: {}, GG: {}, PIN: {}, APP: {} }, segCount = { FB: {}, GG: {}, PIN: {}, APP: {} };
    var binCount = { FB: {}, GG: {}, PIN: {}, APP: {} };
    (items || []).forEach(function (it) {
      // Chữ nền tảng trong đường dẫn bin (tính cả tên bin)
      var p = it.isFolder ? (it.path ? it.path + ' / ' : '') + it.name : it.path;
      var plats = {};
      segs(p).forEach(function (s) { var P = platOf(s); if (P) { aliasCount[P][s] = (aliasCount[P][s] || 0) + 1; segCount[P][s] = (segCount[P][s] || 0) + 1; plats[P] = 1; } });
      if (!isSeq(it)) return;
      // Chữ nền tảng trong tên sequence ("Google dọc vid36.1", "AppLovin vid36.0")
      String(it.name).split(/\s+/).forEach(function (w) {
        var P = platOf(w);
        if (P && P !== 'APP' && w.length >= 2) aliasCount[P][w] = (aliasCount[P][w] || 0) + 1;
        if (P === 'APP' && key(w) === 'applovin') aliasCount.APP[w] = (aliasCount.APP[w] || 0) + 1;
      });
      var cm = /^(\d+)\.(\d+)\b/.exec(String(it.name).trim());
      var v = vidOf(it.name) || (cm ? { set: cm[1], idx: cm[2] } : null);
      var tpl = v ? generalize(it.path, v) : '';
      if (!tpl) return;
      Object.keys(plats).forEach(function (P) { binCount[P][tpl] = (binCount[P][tpl] || 0) + 1; });
    });
    var prof = { alias: {}, bins: {}, warns: [], learned: false };
    Object.keys(WORDS).forEach(function (P) {
      var a = top(aliasCount[P]);
      prof.alias[P] = a || DEFAULT.alias[P];
      if (a) prof.learned = true;
      // Cảnh báo chỉ khi chính các BIN dùng hai chữ khác nhau (tên sequence "AppLovin" cạnh bin "APP" là bình thường).
      var sa = top(segCount[P]);
      var others = Object.keys(segCount[P]).filter(function (k) { return key(k) !== key(sa); });
      if (sa && others.length && segCount[P][others[0]] * 2 >= segCount[P][sa]) {
        prof.warns.push('Bin của project dùng cả "' + sa + '" lẫn "' + others[0] + '" cho ' + P + ' — plugin theo "' + a + '".');
      }
      var b = top(binCount[P]);
      if (b) prof.bins[P] = b;
    });
    ['FB', 'GG'].forEach(function (P) {
      if (!prof.bins[P] && prof.alias[P] === DEFAULT.alias[P] && !Object.keys(aliasCount[P]).length) {
        prof.warns.push('Chưa thấy bin ' + P + ' nào — quy trình ' + P + ' sẽ tạo bin mặc định "Sequence / ' + P + ' / {bộ}x".');
      }
    });
    return prof;
  }

  function use(p) { cur = p && p.alias ? p : DEFAULT; return cur; }
  function current() { return cur; }
  function alias(P) { return (cur.alias && cur.alias[P]) || DEFAULT.alias[P] || P; }
  // Regex alternation khớp mã + chữ project dùng cho P: "GG|Google"
  function alt(P) {
    var a = [P, alias(P)];
    if (P === 'APP') a.push('AppLovin');
    return a.filter(function (x, i) { return x && a.indexOf(x) === i; })
      .map(function (x) { return String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|');
  }
  function binTpl(P) { return (cur.bins && cur.bins[P]) || ''; }
  // Ngắn gọn cho UI: "FB = Facebook · GG = Google"
  function summary(p) {
    p = p || cur;
    return ['FB', 'GG', 'PIN'].filter(function (P) { return p.alias[P] && p.alias[P] !== P; })
      .map(function (P) { return P + ' = ' + p.alias[P]; }).join(' · ');
  }

  // ── AI giúp khi luật không chắc ───────────────────────────────────────────
  var GENERIC = /^(sequences?|seq|timelines?|edit(ing)?|final|old|archive|backup|nest(ed)?|draft|wip)$/i;
  function binsOf(items) {
    var out = {};
    (items || []).forEach(function (it) {
      var p = it.isFolder ? (it.path ? it.path + ' / ' : '') + it.name : it.path;
      if (p) out[segs(p).join(' / ')] = 1;
    });
    return Object.keys(out).sort();
  }
  // Chữ ký cấu trúc: bin cấp 1-2 đã chuẩn hoá số → đổi nhiều mới hỏi lại Claude.
  function signature(items) {
    var keys = {};
    binsOf((items || []).filter(isSeq)).forEach(function (b) { keys[segs(b).slice(0, 2).map(function (x) { return x.replace(/\d+/g, '#'); }).join('/').toLowerCase()] = 1; });
    return Object.keys(keys).sort().join('|');
  }
  // Bin chứa sequence vid… mà không mang chữ nền tảng nào → luật không hiểu.
  function unknownBins(items) {
    var out = {};
    (items || []).forEach(function (it) {
      if (!isSeq(it) || !vidOf(it.name) || !it.path) return;
      var ss = segs(it.path);
      if (ss.some(function (x) { return platOf(x); })) return;
      var head = ss.filter(function (x) { return !GENERIC.test(x) && !/^\d+(x|\.\d+)?$/i.test(x); })[0];
      if (head) out[head] = 1;
    });
    return Object.keys(out);
  }
  // Ghi chú cho người đọc: tối đa ~240 ký tự, cắt ở cuối câu (không cắt giữa chữ).
  function shortNote(t) {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    if (t.length <= 240) return t;
    var cut = t.slice(0, 240), dot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.'));
    if (dot > 80) return cut.slice(0, dot + 1);
    return cut.slice(0, cut.lastIndexOf(' ')) + '…';
  }
  function hasWork(items) { return (items || []).some(function (it) { return isSeq(it) && vidOf(it.name); }); }
  function needsAI(prof, items) {
    var hasSeq = (items || []).some(function (it) { return isSeq(it) && vidOf(it.name); });
    if (!hasSeq) return false;                              // project trống: không có gì để hỏi
    return (prof.warns || []).length > 0 || unknownBins(items).length > 0;
  }
  // Gói gửi bridge: chỉ tên bin + "bin ▸ tên sequence".
  function aiRequest(items, prof) {
    var seqs = (items || []).filter(function (it) { return isSeq(it) && vidOf(it.name); })
      .map(function (it) { return (it.path || '') + ' ▸ ' + it.name; });
    return { bins: binsOf(items).slice(0, 250), seqs: seqs.slice(-250), rule: { alias: prof.alias, bins: prof.bins } };
  }
  // Kiểm kết quả Claude với project thật: alias phải xuất hiện (bin hoặc tên sequence), mẫu bin phải
  // khớp ít nhất một bin có thật. Sai thì giữ của luật. → hồ sơ mới (ai:true, note).
  function mergeAI(prof, ai, items) {
    var out = JSON.parse(JSON.stringify(prof)); out.ai = true; out.aiNote = '';
    if (!ai) return out;
    var words = {};
    (items || []).forEach(function (it) {
      segs(it.isFolder ? (it.path ? it.path + ' / ' : '') + it.name : it.path).forEach(function (x) { words[x.toLowerCase()] = 1; });
      if (isSeq(it)) String(it.name).split(/\s+/).forEach(function (w) { words[w.toLowerCase()] = 1; });
    });
    var names = (items || []).filter(isSeq).map(function (it) { return ' ' + String(it.name).toLowerCase() + ' '; });
    Object.keys(WORDS).forEach(function (P) {
      var a = String((ai.alias || {})[P] || '').trim();
      if (!a || a.length > 40) return;
      var ok = words[a.toLowerCase()] || names.some(function (n) { return n.indexOf(' ' + a.toLowerCase() + ' ') >= 0; });
      if (ok) out.alias[P] = a;
    });
    var all = binsOf(items).map(function (b) { return b.toLowerCase(); });
    Object.keys(ai.bins || {}).forEach(function (P) {
      var t = String(ai.bins[P] || '').trim();
      if (!t || !/\{bộ\}/.test(t) || !WORDS[P]) return;
      var re = new RegExp('^' + segs(t).map(function (x) {
        return x.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(bộ|số)\}/g, '\\d+');
      }).join(' / ').toLowerCase() + '$');
      if (all.some(function (b) { return re.test(b); })) out.bins[P] = segs(t).join(' / ');
    });
    out.aiNote = String(ai.note || '').replace(/\s+/g, ' ').trim().slice(0, 2000); out.v = 3;
    out.warns = [];                                          // Claude đã xem — chỉ giữ cảnh báo "chưa có bin"
    (prof.warns || []).forEach(function (w) { if (/^Chưa thấy bin/.test(w) && !out.bins[w.split(' ')[3]]) out.warns.push(w); });
    out.learned = true;
    return out;
  }

  return { hasWork: hasWork, shortNote: shortNote, needsAI: needsAI, aiRequest: aiRequest, mergeAI: mergeAI, signature: signature, unknownBins: unknownBins,
           WORDS: WORDS, scan: scan, use: use, current: current, alias: alias, alt: alt, binTpl: binTpl,
           summary: summary, platOf: platOf, generalize: generalize };
})();

(function (root) {
  if (root) { root.PPF = PPF; }
  if (typeof module !== "undefined" && module.exports) { module.exports = PPF; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
