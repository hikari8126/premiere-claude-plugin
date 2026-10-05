// plugin/cl-fix.js — Claude tự sửa khối quy trình cho đúng project đang mở (global CLFIX). Thuần, có test.
//
// Bản xem trước (FLE.planFlow) có lỗi → gửi Claude: các khối + lỗi + tên bin/sequence của project.
// Claude trả bản khối đã sửa → chuẩn hoá (FLE.normStep) → xem trước LẠI: ít lỗi hơn mới dùng.
// Bản sửa lưu theo project + quy trình (khối gốc đổi thì hỏi lại); quy trình gốc không bị đụng.

var CLFIX = (function () {
  var F = (typeof FLE !== 'undefined') ? FLE : require('./flow-engine.js');
  var P = (typeof PPF !== 'undefined') ? PPF : require('./proj-profile.js');
  var LS = 'cl_flowfix_v1';

  function isSeq(it) { return it && !it.isFolder && it.mediaType === 'sequence'; }
  function hash(s) {
    var h = 0, t = String(s);
    for (var i = 0; i < t.length; i++) { h = ((h << 5) - h + t.charCodeAt(i)) | 0; }
    return (h >>> 0).toString(36);
  }
  function key(project, flow) { return String(project || '') + '|' + (flow.id || flow.name) + '|' + hash(JSON.stringify(flow.steps)); }

  // Bin cấp 1 của project (để nhận ra khối sắp tạo cả một nhánh bin lạ, vd "Sequence / GG" ở project dùng "Google").
  function roots(items) {
    var r = {};
    (items || []).forEach(function (it) {
      var p = it.isFolder ? (it.path ? it.path + ' / ' : '') + it.name : it.path;
      var h = String(p || '').split('/')[0].trim().toLowerCase();
      if (h) r[h] = 1;
    });
    return r;
  }
  // Vấn đề của bản xem trước → [{step, type, error}] (một vấn đề đầu mỗi khối): lỗi thật, hoặc
  // (khi có items) khối đặt vào bin mà nhánh gốc chưa có trong project.
  function rowIssue(r, rt) {
    if (r.error) return r.error;
    if (!rt || !r.bin || r.virtualOk) return '';
    var h = String(r.bin).split('/')[0].trim().toLowerCase();
    return h && Object.keys(rt).length && !rt[h] ? 'bin "' + r.bin + '" không khớp cấu trúc bin của project (sẽ tạo nhánh "' + String(r.bin).split('/')[0].trim() + '" mới)' : '';
  }
  function errorsOf(preview, items) {
    var out = [], rt = items ? roots(items) : null;
    (preview || []).forEach(function (p) {
      var msg = '';
      (p && p.rows || []).some(function (x) { msg = rowIssue(x, rt); return !!msg; });
      if (msg) out.push({ step: p.step, type: p.type, error: msg });
    });
    return out;
  }
  function errorCount(preview, items) {
    var n = 0, rt = items ? roots(items) : null;
    (preview || []).forEach(function (p) { (p && p.rows || []).forEach(function (r) { if (rowIssue(r, rt)) n++; }); });
    return n;
  }
  function plan(items, steps, targets, frames) {
    try { return F.planFlow(items, steps, targets, null, frames || null); } catch (e) { return null; }
  }

  // Gói gửi bridge /flow/fix
  function request(items, flow, preview) {
    var bins = {};
    (items || []).forEach(function (it) {
      var p = it.isFolder ? (it.path ? it.path + ' / ' : '') + it.name : it.path;
      if (p) bins[p] = 1;
    });
    var seqs = (items || []).filter(function (it) { return isSeq(it) && /vid\s*\d+\s*\.\s*\d+/i.test(it.name); })
      .map(function (it) { return (it.path || '') + ' ▸ ' + it.name; });
    var prof = P.current();
    return {
      name: flow.name, steps: flow.steps, errors: errorsOf(preview, items),
      bins: Object.keys(bins).sort().slice(0, 250), seqs: seqs.slice(-200),
      profile: { alias: prof.alias, bins: prof.bins, note: prof.aiNote || '' }
    };
  }

  // Bản Claude sửa → dùng được? Chuẩn hoá từng khối (khối lạ giữ bản gốc cùng vị trí), xem trước lại.
  // → {steps, preview, errors} nếu ÍT lỗi hơn bản gốc, không thì null.
  function accept(items, flow, aiSteps, targets, frames, before) {
    if (!Array.isArray(aiSteps) || !aiSteps.length || aiSteps.length > 20) return null;
    // Khối chạy được ở bản gốc thì giữ y nguyên (Claude chỉ được sửa khối lỗi), khi số khối không đổi.
    var bad = {};
    errorsOf(plan(items, flow.steps, targets, frames), items).forEach(function (e) { bad[e.step - 1] = 1; });
    var same = aiSteps.length === flow.steps.length;
    var steps = aiSteps.map(function (s, i) {
      if (same && !bad[i] && flow.steps[i] && s && s.type === flow.steps[i].type) return flow.steps[i];
      if (s && F.isType(s.type)) return F.normStep(s);
      if (s && s.type === 'platform') return F.normStep(s);
      var orig = flow.steps[i];
      return orig && orig.type === (s && s.type) ? orig : null;
    }).filter(Boolean);
    if (!steps.length) return null;
    var pv = plan(items, steps, targets, frames);
    if (!pv) return null;
    var nb = before != null ? before : errorCount(plan(items, flow.steps, targets, frames), items);
    var na = errorCount(pv, items);
    if (na >= nb) return null;
    return { steps: steps, preview: pv, errors: na };
  }

  function load() { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { return {}; } }
  function cached(project, flow) { var c = load()[key(project, flow)]; return c && Array.isArray(c.steps) ? c : null; }
  function remember(project, flow, fix) {
    var all = load(), k = key(project, flow);
    all[k] = { steps: fix.steps, note: fix.note || '', at: Date.now() };
    var ks = Object.keys(all).sort(function (a, b) { return (all[b].at || 0) - (all[a].at || 0); });
    ks.slice(60).forEach(function (x) { delete all[x]; });            // giữ 60 bản gần nhất
    try { localStorage.setItem(LS, JSON.stringify(all)); } catch (e) {}
  }
  function forget(project, flow) {
    var all = load(); delete all[key(project, flow)];
    try { localStorage.setItem(LS, JSON.stringify(all)); } catch (e) {}
  }
  // Quy trình đã sửa cho project (giữ id/tên gốc) hoặc chính nó.
  function applied(project, flow) {
    var c = cached(project, flow);
    return c ? Object.assign({}, flow, { steps: c.steps, fixedNote: c.note || 'đã chỉnh theo project' }) : flow;
  }

  return { errorsOf: errorsOf, errorCount: errorCount, plan: plan, request: request, accept: accept,
           cached: cached, remember: remember, forget: forget, applied: applied, key: key };
})();

(function (root) {
  if (root) { root.CLFIX = CLFIX; }
  if (typeof module !== "undefined" && module.exports) { module.exports = CLFIX; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
