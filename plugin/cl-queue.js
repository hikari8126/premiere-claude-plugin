// plugin/cl-queue.js — project đã biết + hàng đợi việc nhiều project cho tab Claude (global CLQ). Thuần, có test.
//
// Premiere UXP không liệt kê được các project đang mở, và guid trả về giống nhau cho mọi project
// (thử 2026-10-05) → nhận diện project theo ĐƯỜNG DẪN file. Mỗi lần một project active, plugin
// ghi lại {path, name, last}. Hàng đợi: mỗi việc = {project, quy trình, bộ, video} — lúc chạy
// plugin Project.open(path) (đang mở thì chuyển gần như tức thì, đang đóng thì mở ra) rồi chạy.

var CLQ = (function () {
  var MAX_PROJECTS = 40, MAX_QUEUE = 60;
  var STATUS = ['wait', 'run', 'ok', 'error', 'skip'];

  function baseName(p) { return String(p || '').split('/').pop().replace(/\.prproj$/i, ''); }

  // Ghi project vừa active (mới nhất lên đầu, bỏ trùng theo đường dẫn). Không đổi mảng gốc.
  function seeProject(list, path, now) {
    path = String(path || '');
    if (!/\.prproj$/i.test(path)) return Array.isArray(list) ? list.slice() : [];
    var out = (Array.isArray(list) ? list : []).filter(function (p) { return p && p.path !== path; });
    out.unshift({ path: path, name: baseName(path), last: now || Date.now() });
    return out.slice(0, MAX_PROJECTS);
  }

  function uid() { return 'q' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

  // Việc: {id, path, name, flowId, flowName, set, idxs:[số] (trống = cả bộ), platform, status, msg, at}
  // Bộ frame (NAV): {số video: '9-16' | '4-5'}; không có → null
  function normFrames(f) {
    if (!f || typeof f !== 'object') return null;
    var out = {}, n = 0;
    Object.keys(f).forEach(function (k) { if (/^\d+$/.test(k) && (f[k] === '9-16' || f[k] === '4-5')) { out[k] = f[k]; n++; } });
    return n ? out : null;
  }
  function normItem(it) {
    if (!it || typeof it !== 'object' || !/\.prproj$/i.test(String(it.path || '')) || !it.flowId) return null;
    var set = String(it.set || '').trim();
    if (!/^\d+$/.test(set)) return null;
    return {
      id: String(it.id || uid()), path: String(it.path), name: String(it.name || baseName(it.path)),
      flowId: String(it.flowId), flowName: String(it.flowName || ''), set: set,
      idxs: (Array.isArray(it.idxs) ? it.idxs : []).map(Number).filter(function (n, i, a) { return n >= 0 && n < 100 && a.indexOf(n) === i; }).sort(function (a, b) { return a - b; }),
      platform: String(it.platform || ''), frames: normFrames(it.frames), status: STATUS.indexOf(it.status) >= 0 ? it.status : 'wait',
      msg: String(it.msg || '').slice(0, 300), at: Number(it.at) || Date.now()
    };
  }
  function normQueue(q) { return (Array.isArray(q) ? q : []).map(normItem).filter(Boolean).slice(-MAX_QUEUE); }

  // Thêm việc; trùng (cùng project + quy trình + bộ + video, còn chờ) thì bỏ qua. → {queue, added}
  function add(q, it) {
    var n = normItem(it), cur = normQueue(q);
    if (!n) return { queue: cur, added: false };
    var key = function (x) { return [x.path, x.flowId, x.set, x.idxs.join(','), x.platform, JSON.stringify(x.frames)].join('|'); };
    if (cur.some(function (x) { return x.status === 'wait' && key(x) === key(n); })) return { queue: cur, added: false };
    n.status = 'wait'; n.msg = '';
    return { queue: cur.concat([n]).slice(-MAX_QUEUE), added: true };
  }
  function next(q) { return normQueue(q).filter(function (x) { return x.status === 'wait'; })[0] || null; }
  function mark(q, id, status, msg) {
    return normQueue(q).map(function (x) {
      if (x.id !== id) return x;
      x.status = STATUS.indexOf(status) >= 0 ? status : x.status;
      if (msg != null) x.msg = String(msg).slice(0, 300);
      return x;
    });
  }
  function remove(q, id) { return normQueue(q).filter(function (x) { return x.id !== id; }); }
  function clearDone(q) { return normQueue(q).filter(function (x) { return x.status === 'wait' || x.status === 'run'; }); }
  // Lượt trước bị đóng panel giữa chừng → việc "run" quay về "wait" để chạy lại.
  function recover(q) { return normQueue(q).map(function (x) { if (x.status === 'run') { x.status = 'wait'; x.msg = 'chạy lại (lượt trước bị ngắt)'; } return x; }); }

  // Nhóm việc chờ theo project, giữ thứ tự xuất hiện → ít lần chuyển project nhất.
  function plan(q) {
    var wait = normQueue(q).filter(function (x) { return x.status === 'wait'; }), order = [], by = {};
    wait.forEach(function (x) { if (!by[x.path]) { by[x.path] = []; order.push(x.path); } by[x.path].push(x); });
    return order.reduce(function (acc, p) { return acc.concat(by[p]); }, []);
  }

  // "vid35.0, 35.2" / "35" / "35.0 35.1" → {set, idxs} | {error}. Một bộ mỗi việc.
  function parseTargets(text) {
    var t = String(text || '').toLowerCase().replace(/vid/g, ' ').trim();
    if (!t) return { error: 'gõ số bộ, vd 35 hoặc 35.0, 35.2' };
    var parts = t.split(/[\s,;]+/).filter(Boolean), set = '', idxs = [];
    for (var i = 0; i < parts.length; i++) {
      var m = parts[i].match(/^(\d+)(?:\.(\d+))?x?$/);
      if (!m) return { error: '"' + parts[i] + '" không phải số bộ / video' };
      if (set && m[1] !== set) return { error: 'mỗi việc chỉ một bộ — thêm từng bộ một' };
      set = m[1];
      if (m[2] != null && idxs.indexOf(Number(m[2])) < 0) idxs.push(Number(m[2]));
    }
    return { set: set, idxs: idxs.sort(function (a, b) { return a - b; }) };
  }
  function targetText(it) {
    if (it.frames) return 'bộ ' + it.set + ' · ' + Object.keys(it.frames).map(function (k) { return it.frames[k] === '4-5' ? '4:5' : '9:16'; }).join(' · ');
    return it.idxs.length ? it.idxs.map(function (n) { return 'vid' + it.set + '.' + n; }).join(', ') : 'cả bộ ' + it.set; }

  return { seeProject: seeProject, baseName: baseName, normQueue: normQueue, add: add, next: next, mark: mark,
           remove: remove, clearDone: clearDone, recover: recover, plan: plan, parseTargets: parseTargets,
           targetText: targetText, uid: uid };
})();

(function (root) {
  if (root) { root.CLQ = CLQ; }
  if (typeof module !== "undefined" && module.exports) { module.exports = CLQ; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
