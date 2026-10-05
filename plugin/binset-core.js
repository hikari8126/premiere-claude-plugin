// plugin/binset-core.js — lập kế hoạch khối "Dựng bin GG / PIN" (global BSC). Thuần, có test.
//
// Chuẩn của một video, vd vid40.1, nền tảng GG (ảnh bin của user 2026-10-05):
//   bin  Sequence / GG / 40x / 40.1
//     40.1                                   ← nhân bản sequence FB gốc, đổi tên {bộ}.{số}
//     40.1 4x5 FB                            ← resize 40.1 sang ratio còn lại (đặt tên như tab Resize)
//     AeriSoft GG dọc vid40.1 [..] [..]      ← bản đích: template (sau này) › bản cùng loại của bộ
//     AeriSoft GG ngang vid40.1 [..] [..]       gần nhất trước đó › chưa có thì báo
//     AeriSoft GG vuông vid40.1 [..] [..]
// Chỉ tạo bin + sequence theo mẫu — KHÔNG đụng nội dung bên trong (bro tự đặt video vào khung).
// Phần chạm Premiere ở binset.js.

var BSC = (function () {
  var PLATFORMS = ['GG', 'PIN'];
  var DEFAULT_TARGETS = { GG: ['dọc', 'ngang', 'vuông'], PIN: [] };   // PIN: lấy theo bộ trước

  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function ref(it) { return (it.path || '') + ' ▸ ' + it.name; }
  function isSeq(it) { return it && !it.isFolder && it.mediaType === 'sequence'; }
  function samePath(a, b) { return norm(a).replace(/\s*\/\s*/g, '/') === norm(b).replace(/\s*\/\s*/g, '/'); }

  function binPath(platform, set, idx) { return 'Sequence / ' + platform + ' / ' + set + 'x / ' + set + '.' + idx; }

  // Sequence FB gốc của video set.idx: tên có vid{set}.{idx}, không có đuôi ratio (4x5…),
  // không phải bản đích GG/PIN. Nhiều cái → ưu tiên cái nằm trong bin có "FB".
  function fbSources(items, set) {
    var re = new RegExp('vid\\s*' + set + '\\s*\\.\\s*(\\d+)(?!\\d)', 'i');
    var out = {};
    (items || []).forEach(function (it) {
      if (!isSeq(it)) return;
      var m = String(it.name).match(re);
      if (!m || /\b\d+x\d+\b/i.test(it.name) || /(^|\s)(GG|PIN)(\s|$)/.test(it.name)) return;
      var idx = Number(m[1]), cur = out[idx];
      var score = /(^|\/)\s*FB\s*(\/|$)/i.test(it.path || '') ? 2 : 1;
      if (!cur || score > cur.score) out[idx] = { idx: idx, ref: ref(it), name: it.name, score: score };
    });
    return out;
  }

  // "AeriSoft vid40.1 [a] [b]" + GG + dọc → "AeriSoft GG dọc vid40.1 [a] [b]"
  function targetName(srcName, platform, label) {
    var s = String(srcName || '');
    if (!/(^|\s)vid\s*\d/i.test(s)) return '';
    return s.replace(/(^|\s)(vid\s*\d)/i, '$1' + platform + ' ' + label + ' $2');
  }

  // Bản đích của các bộ trước: {label: {set, ref, name}} — bộ gần nhất (< set) cho từng loại.
  function prevTargets(items, platform, set, idx) {
    var re = new RegExp('(^|\\s)' + esc(platform) + '\\s+(\\S+)\\s+vid\\s*(\\d+)\\s*\\.\\s*' + idx + '(?!\\d)', 'i');
    var out = {};
    (items || []).forEach(function (it) {
      if (!isSeq(it)) return;
      var m = String(it.name).match(re);
      if (!m) return;
      var s = Number(m[3]), label = m[2].toLowerCase();
      if (s >= Number(set)) return;
      // text: giữ cách viết của bộ trước ("Dọc" / "dọc") để tên bản mới khớp các bộ cũ
      if (!out[label] || s > out[label].set) out[label] = { set: s, ref: ref(it), name: it.name, text: m[2] };
    });
    return out;
  }

  // Bản resize tài nguyên làm theo bộ gần nhất trong cùng nền tảng: "35.0 4x5 GG" + "35.0 1x1 GG"
  // → {platform:'GG', ratios:['4-5','1-1']}. Chưa có bộ nào → mặc định "4x5 FB" kiểu tab Resize FB
  // (FB tự chọn ratio còn lại 9:16 ⇄ 4:5). → {platform, ratios, from?}
  function res2Spec(items, platform, set, idx) {
    var re = new RegExp('^(\\d+)\\.' + idx + '\\s+(\\d+)x(\\d+)\\s+(FB|GG|PIN)$', 'i'), best = null;
    (items || []).forEach(function (it) {
      if (!isSeq(it)) return;
      var m = String(it.name).trim().match(re);
      if (!m || Number(m[1]) >= Number(set) || String(it.path).indexOf('/ ' + platform + ' /') < 0) return;
      var s = Number(m[1]);
      if (!best || s > best.set) best = { set: s, platform: m[4].toUpperCase(), ratios: [] };
      if (s === best.set) { var r = m[2] + '-' + m[3]; if (best.ratios.indexOf(r) < 0) best.ratios.push(r); }
    });
    return best ? { platform: best.platform, ratios: best.ratios, from: best.set } : { platform: 'FB', ratios: [] };
  }

  function existsIn(items, path, name) {
    return (items || []).some(function (it) { return isSeq(it) && norm(it.name) === norm(name) && samePath(it.path, path); });
  }

  // opts = {platform, set, idxs?:[số], templates?:{label: ref}}
  // → {ok, error?, rows:[{idx, bin, src, res1:{name, exists}, res2:{exists, name?}, targets:[{label, name, from, exists}], error?}]}
  function plan(items, opts) {
    opts = opts || {};
    var platform = String(opts.platform || '').toUpperCase(), set = String(opts.set || '').trim();
    if (PLATFORMS.indexOf(platform) < 0) return { ok: false, error: 'nền tảng phải là GG hoặc PIN' };
    if (!/^\d+$/.test(set)) return { ok: false, error: 'chưa biết bộ nào (mở một sequence vid{bộ}.N trước)' };
    var src = fbSources(items, set);
    var idxs = (opts.idxs && opts.idxs.length ? opts.idxs : Object.keys(src)).map(Number)
      .filter(function (n, i, a) { return n >= 0 && a.indexOf(n) === i; }).sort(function (a, b) { return a - b; });
    if (!idxs.length) return { ok: false, error: 'không thấy sequence FB gốc nào của bộ ' + set };
    var templates = opts.templates || {};
    var rows = idxs.map(function (idx) {
      var bin = binPath(platform, set, idx), s = src[idx] || null;
      var row = { idx: idx, bin: bin, src: s };
      if (!s) { row.error = 'không thấy sequence FB gốc vid' + set + '.' + idx; return row; }
      var r1 = set + '.' + idx;
      row.res1 = { name: r1, exists: existsIn(items, bin, r1) };
      // Bản resize tài nguyên: "40.1 4x5 FB" (AeriSoft) hay "35.0 4x5 GG" + "35.0 1x1 GG" (SonaShape) — có
      // bất kỳ bản "{bộ}.{số} AxB …" nào trong bin là coi như đã có.
      var r2 = (items || []).filter(function (it) {
        return isSeq(it) && samePath(it.path, bin) && new RegExp('^' + esc(r1) + '\\s+\\d+x\\d+(\\s+\\S+)?$', 'i').test(String(it.name).trim());
      });
      row.res2 = r2.length ? { exists: true, name: r2.map(function (x) { return x.name; }).join(', ') }
                           : { exists: false, spec: res2Spec(items, platform, set, idx) };
      var prev = prevTargets(items, platform, set, idx);
      var labels = DEFAULT_TARGETS[platform].slice();
      Object.keys(prev).concat(Object.keys(templates)).forEach(function (l) { l = l.toLowerCase(); if (labels.indexOf(l) < 0) labels.push(l); });
      row.targets = labels.map(function (label) {
        var name = targetName(s.name, platform, prev[label] ? prev[label].text : label);
        var from = templates[label] ? { kind: 'template', ref: templates[label] }
                 : prev[label] ? { kind: 'prev', ref: prev[label].ref, name: prev[label].name, set: prev[label].set } : null;
        return { label: label, name: name, from: from, exists: existsIn(items, bin, name) };
      });
      return row;
    });
    return { ok: true, platform: platform, set: set, rows: rows };
  }

  // Đếm việc sẽ làm (cho dòng tóm tắt thẻ xem trước).
  function summary(p) {
    var make = 0, have = 0, missing = 0, bad = 0;
    (p.rows || []).forEach(function (r) {
      if (r.error) { bad++; return; }
      [r.res1, r.res2].forEach(function (x) { if (x.exists) have++; else make++; });
      r.targets.forEach(function (t) { if (t.exists) have++; else if (t.from) make++; else missing++; });
    });
    return { make: make, have: have, missing: missing, bad: bad };
  }

  return { PLATFORMS: PLATFORMS, DEFAULT_TARGETS: DEFAULT_TARGETS, binPath: binPath, fbSources: fbSources,
           targetName: targetName, prevTargets: prevTargets, res2Spec: res2Spec, plan: plan, summary: summary };
})();

(function (root) {
  if (root) { root.BSC = BSC; }
  if (typeof module !== "undefined" && module.exports) { module.exports = BSC; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
