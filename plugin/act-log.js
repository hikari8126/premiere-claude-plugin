// plugin/act-log.js — nhật ký việc làm ở mọi tab + tìm chuỗi việc lặp theo bộ (global ACTLOG). Thuần, có test.
//
// Mỗi tab khi một việc XONG gọi window.actLog(tab, act, seqName, params). Ghi {at, proj, tab, act, set, idx, p}
// (set/idx đọc từ "vid36.1" trong tên sequence). Chỉ tham số ngắn — không script, không đường dẫn.
// patterns(): gom theo bộ → chuỗi việc của từng bộ → chuỗi con có thứ tự lặp ở ≥ minSets bộ.
// Claude (bridge /flow/suggest) đọc digest() để viết quy trình bằng khối.

var ACTLOG = (function () {
  var LS = 'act_log_v1', MAX = 600, DAYS = 60;
  // Tên việc dễ đọc (cho người và cho Claude)
  var LABEL = {
    resize: 'Resize', rawcut: 'Xuất RAW', voice_import: 'Import voice', voice_timeline: 'Đặt voice lên timeline',
    autocut: 'Autocut dựng timeline', auto_set: 'Trang Auto dựng cả bộ', subtext: 'Tạo Sub (.srt)', unnest: 'Un-nest',
    watch_import: 'Watch import', rename: 'Đổi tên source', flow: 'Chạy quy trình', bin_move: 'Chuyển vào bin'
  };

  function vid(name) {
    var m = String(name || '').match(/vid\s*(\d+)\s*\.\s*(\d+)(?!\d)/i);
    return m ? { set: String(Number(m[1])), idx: Number(m[2]) } : null;
  }
  function cleanParams(p) {
    var out = {};
    Object.keys(p || {}).slice(0, 8).forEach(function (k) {
      var v = p[k];
      if (v == null || typeof v === 'function') return;
      if (Array.isArray(v)) v = v.slice(0, 6).map(String).join(',');
      else if (typeof v === 'object') return;
      v = String(v);
      if (v.indexOf('/') === 0) return;                      // không ghi đường dẫn
      out[k] = v.slice(0, 40);
    });
    return out;
  }
  function entry(tab, act, seqName, params, proj, now) {
    var v = vid(seqName);
    return { at: now || Date.now(), proj: String(proj || ''), tab: String(tab || ''), act: String(act || tab || ''),
             set: v ? v.set : '', idx: v ? v.idx : null, p: cleanParams(params) };
  }
  function prune(list, now) {
    var cut = (now || Date.now()) - DAYS * 864e5;
    return (list || []).filter(function (e) { return e && e.at >= cut; }).slice(-MAX);
  }

  // ── Mẫu lặp ─────────────────────────────────────────────────────────────────
  // Việc của một bộ, theo thời gian, gộp việc giống nhau liền nhau ("resize GG" ×3 video = 1).
  function sig(e) {
    var p = e.p || {};
    return e.act + (p.platform ? ' ' + p.platform : '') + (p.mode ? ' ' + p.mode : '');
  }
  function bySet(list, proj) {
    var out = {};
    (list || []).filter(function (e) { return e.set && (!proj || e.proj === proj); })
      .sort(function (a, b) { return a.at - b.at; })
      .forEach(function (e) {
        var arr = out[e.set] || (out[e.set] = []), s = sig(e);
        if (arr.indexOf(s) < 0) arr.push(s);                 // lần đầu làm việc đó trong bộ
      });
    return out;
  }
  function isSub(seq, arr) {
    var i = 0;
    for (var j = 0; j < arr.length && i < seq.length; j++) if (arr[j] === seq[i]) i++;
    return i === seq.length;
  }
  // Chuỗi con có thứ tự (độ dài 2..6) xuất hiện ở ≥ minSets bộ. Lấy chuỗi dài nhất, không trùng lặp
  // (chuỗi con của chuỗi đã chọn bị bỏ). → [{steps:[sig], sets:[…], support}]
  function patterns(list, proj, minSets) {
    minSets = minSets || 3;
    var sets = bySet(list, proj), keys = Object.keys(sets);
    if (keys.length < minSets) return [];
    var cand = {};
    keys.forEach(function (k) {
      var a = sets[k].slice(0, 10);
      // mọi chuỗi con liền mạch + bỏ 1 phần tử ở giữa (đủ bắt "A → (B) → C")
      for (var i = 0; i < a.length; i++) {
        for (var j = i + 2; j <= Math.min(a.length, i + 6); j++) {
          cand[JSON.stringify(a.slice(i, j))] = 1;
        }
      }
    });
    var found = Object.keys(cand).map(function (c) {
      var steps = JSON.parse(c);
      var hit = keys.filter(function (k) { return isSub(steps, sets[k]); });
      return { steps: steps, sets: hit.sort(function (a, b) { return Number(a) - Number(b); }), support: hit.length };
    }).filter(function (x) { return x.support >= minSets; });
    found.sort(function (a, b) { return (b.steps.length - a.steps.length) || (b.support - a.support); });
    var picked = [];
    found.forEach(function (f) {
      if (picked.some(function (p) { return isSub(f.steps, p.steps); })) return;
      picked.push(f);
    });
    return picked.slice(0, 3);
  }
  // Tóm tắt gửi Claude: mỗi bộ một dòng + mẫu tìm được.
  function digest(list, proj) {
    var sets = bySet(list, proj), keys = Object.keys(sets).sort(function (a, b) { return Number(a) - Number(b); }).slice(-12);
    var lines = keys.map(function (k) { return 'bộ ' + k + ': ' + sets[k].join(' → '); });
    var pats = patterns(list, proj);
    return { sets: lines, patterns: pats.map(function (p) { return p.steps.join(' → ') + '  (' + p.support + ' bộ: ' + p.sets.join(', ') + ')'; }) };
  }

  // ── Lưu ─────────────────────────────────────────────────────────────────────
  function load() { try { return JSON.parse(localStorage.getItem(LS) || '[]') || []; } catch (e) { return []; } }
  function save(list) { try { localStorage.setItem(LS, JSON.stringify(prune(list))); } catch (e) {} }
  function record(tab, act, seqName, params, proj) {
    var e = entry(tab, act, seqName, params, proj);
    var list = load();
    var last = list[list.length - 1];
    // cùng việc, cùng video trong 20s → coi là một (nút bấm 2 lần, sự kiện bắn trùng)
    if (last && last.act === e.act && last.set === e.set && last.idx === e.idx && last.proj === e.proj && e.at - last.at < 20000) return last;
    list.push(e);
    save(list);
    return e;
  }

  return { LABEL: LABEL, vid: vid, entry: entry, prune: prune, bySet: bySet, patterns: patterns, digest: digest,
           load: load, save: save, record: record, sig: sig };
})();

// Plugin: window.actLog(tab, act, seqName, params) — gọi khi một việc XONG. Bỏ qua việc do quy trình tab
// Claude chạy hộ (đã ghi một dòng 'flow'), trừ chính dòng đó. Báo 'act-log' để tab Claude xem có mẫu mới.
if (typeof window !== 'undefined') {
  window.actLog = function (tab, act, seqName, params) {
    try {
      var running = window.CL_FLOW_RUNNING && Date.now() - window.CL_FLOW_RUNNING < 30 * 60000;
      if (running && tab !== 'claude') return;
      var go = function (proj) {
        ACTLOG.record(tab, act, seqName, params, proj);
        try { window.dispatchEvent(new Event('act-log')); } catch (e) {}
      };
      // tên sequence / đường dẫn project có thể là Promise (API Premiere async)
      Promise.resolve(seqName).then(function (n) { seqName = n; }, function () { seqName = ''; }).then(function () {
        if (typeof getActiveProject !== 'function') return go('');
        return Promise.resolve(getActiveProject()).then(function (p) { return p && p.path; })
          .then(function (pp) { go(typeof pp === 'string' ? pp : ''); }, function () { go(''); });
      });
    } catch (e) {}
  };
}

(function (root) {
  if (root) { root.ACTLOG = ACTLOG; }
  if (typeof module !== "undefined" && module.exports) { module.exports = ACTLOG; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
