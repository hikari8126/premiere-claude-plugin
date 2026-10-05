// plugin/cl-suggest.js — Claude GỢI Ý quy trình mới (global CLSUG). Thuần, có test.
//
// Ba nguồn: (1) quét project (việc lặp theo bộ mà chưa có quy trình), (2) nhật ký việc làm tay ở mọi tab
// (ACTLOG.patterns), (3) member gõ "ráp quy trình …". Claude (bridge /flow/suggest) trả tối đa 3 gợi ý,
// được thêm / bớt / đổi thứ tự khối. Plugin chuẩn hoá (CLC.normButton) + xem trước (FLE.planFlow) trên
// bộ gần nhất: còn lỗi thì không hiện. KHÔNG BAO GIỜ tự lưu / tự chạy — member bấm Dùng / Thay / Bỏ qua.

var CLSUG = (function () {
  var C = (typeof CLC !== 'undefined') ? CLC : require('./cl-custom.js');
  var F = (typeof FLE !== 'undefined') ? FLE : require('./flow-engine.js');
  var B = (typeof BSC !== 'undefined') ? BSC : require('./binset-core.js');
  var LS = 'cl_suggest_v1';                     // {proj: {items:[sug], no:[hash], askedSig}}

  function isSeq(it) { return it && !it.isFolder && it.mediaType === 'sequence'; }
  function hash(s) {
    var h = 0, t = String(s);
    for (var i = 0; i < t.length; i++) { h = ((h << 5) - h + t.charCodeAt(i)) | 0; }
    return (h >>> 0).toString(36);
  }
  function stepsHash(steps) { return hash(JSON.stringify(steps)); }

  // Bộ gần nhất có FB gốc → video đích để xem trước gợi ý.
  function previewTargets(items) {
    var sets = {};
    (items || []).forEach(function (it) {
      var m = isSeq(it) && String(it.name).match(/vid\s*(\d+)\s*\.\s*\d+/i);
      if (m) sets[Number(m[1])] = 1;
    });
    var ks = Object.keys(sets).map(Number).sort(function (a, b) { return b - a; });
    for (var i = 0; i < ks.length; i++) {
      var src = B.fbSources(items, String(ks[i])), idx = Object.keys(src).map(Number).sort();
      if (idx.length) return idx.map(function (n) { return { set: String(ks[i]), idx: n }; });
    }
    return [];
  }

  // Gói gửi bridge
  function request(items, o) {
    o = o || {};
    var bins = {};
    (items || []).forEach(function (it) {
      var p = it.isFolder ? (it.path ? it.path + ' / ' : '') + it.name : it.path;
      if (p) bins[p] = 1;
    });
    var seqs = (items || []).filter(function (it) { return isSeq(it) && /vid\s*\d+\s*\.\s*\d+/i.test(it.name); })
      .map(function (it) { return (it.path || '') + ' ▸ ' + it.name; });
    return {
      mode: o.mode || 'scan', text: String(o.text || '').slice(0, 1000),
      flows: (o.flows || []).map(function (b) { return { name: b.name, steps: b.steps }; }).slice(0, 20),
      log: o.log || null, profile: o.profile || null,
      bins: Object.keys(bins).sort().slice(0, 250), seqs: seqs.slice(-200)
    };
  }

  // Một gợi ý của Claude → {name, why, steps, replaces, preview, hash} hoặc {error}
  function check(items, s, flows) {
    if (!s || typeof s !== 'object') return { error: 'gợi ý rỗng' };
    var nb = C.normButton({ name: String(s.name || '').slice(0, 24) || 'Quy trình mới', kind: 'flow', steps: s.steps });
    if (!nb) return { error: 'khối thiếu tham số' };
    // Giống hệt một quy trình đang có → không gợi ý
    var h = stepsHash(nb.steps);
    if ((flows || []).some(function (b) { return stepsHash(b.steps) === h; })) return { error: 'đã có quy trình này' };
    var tg = previewTargets(items), pv = null, nErr = 0, firstErr = '';
    if (tg.length && nb.steps.some(function (x) { return F.isType(x.type); })) {
      try { pv = F.planFlow(items, nb.steps, tg, null, null); } catch (e) { return { error: e.message }; }
      pv.forEach(function (p) { (p.rows || []).forEach(function (r) { if (r.error) { nErr++; firstErr = firstErr || r.error; } }); });
    }
    if (nErr) return { error: 'xem trước lỗi: ' + firstErr };
    var rep = String(s.replaces || '').trim();
    if (rep && !(flows || []).some(function (b) { return b.name === rep; })) rep = '';
    return { name: nb.name, why: String(s.why || '').trim().slice(0, 1500), steps: nb.steps, replaces: rep,
             preview: pv, set: tg.length ? tg[0].set : '', hash: h };
  }

  // ── Lưu theo project ────────────────────────────────────────────────────────
  function load() { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { return {}; } }
  function saveAll(all) { try { localStorage.setItem(LS, JSON.stringify(all)); } catch (e) {} }
  function slot(all, proj) { return all[proj] || (all[proj] = { items: [], no: [], askedSig: '' }); }
  function pending(proj) { return (load()[proj] || {}).items || []; }
  // Thêm gợi ý mới (bỏ cái đã bị Bỏ qua / trùng), giữ tối đa 4.
  function add(proj, list, askedSig) {
    var all = load(), s = slot(all, proj);
    (list || []).forEach(function (g) {
      if (!g || g.error || s.no.indexOf(g.hash) >= 0) return;
      if (s.items.some(function (x) { return x.hash === g.hash; })) return;
      s.items.unshift({ name: g.name, why: g.why, steps: g.steps, replaces: g.replaces, hash: g.hash, src: g.src || '', at: Date.now() });
    });
    s.items = s.items.slice(0, 4);
    if (askedSig != null) s.askedSig = askedSig;
    saveAll(all);
    return s.items;
  }
  function drop(proj, h, never) {
    var all = load(), s = slot(all, proj);
    s.items = s.items.filter(function (x) { return x.hash !== h; });
    if (never && s.no.indexOf(h) < 0) s.no = s.no.concat([h]).slice(-80);
    saveAll(all);
  }
  function askedSig(proj) { return (load()[proj] || {}).askedSig || ''; }

  // Áp dụng vào kho nút: 'new' → thêm; 'replace' → thay bước quy trình cùng tên, giữ bản cũ để hoàn tác.
  function apply(data, g, how) {
    var d = JSON.parse(JSON.stringify(data));
    if (how === 'replace' && g.replaces) {
      var cur = d.buttons.filter(function (b) { return b.kind === 'flow' && b.name === g.replaces; })[0];
      if (cur) { var old = cur.steps; cur.steps = g.steps; return { data: d, undo: { id: cur.id, steps: old } }; }
    }
    var name = g.name, n = 2;
    while (d.buttons.some(function (b) { return b.name === name; })) name = (g.name.slice(0, 20) + ' ' + n++);
    d.buttons.push({ name: name, kind: 'flow', steps: g.steps });
    return { data: d, added: name };
  }

  return { previewTargets: previewTargets, request: request, check: check, pending: pending, add: add, drop: drop,
           askedSig: askedSig, apply: apply, stepsHash: stepsHash };
})();

(function (root) {
  if (root) { root.CLSUG = CLSUG; }
  if (typeof module !== "undefined" && module.exports) { module.exports = CLSUG; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
