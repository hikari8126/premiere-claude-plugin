// plugin/premiere-tools.js — phần chạm Premiere cho tool / action bin của tab Claude (global PTOOLS).
//
// Bản chụp bin/item gửi kèm mỗi lượt chat — bridge trả lời tool đọc project (project_bins,
// list_bin, find_items) từ đó. Việc CHUYỂN item chỉ chạy sau khi người dùng bấm xác nhận trên
// thẻ (claude-tab.js). Hàm thuần ở bin-core.js (BINC); dùng global của main.js:
// getActiveProject, sacCollectBinItems, ppMoveToBin.
var PTOOLS = (function () {
  var cache = { at: 0, items: null };
  var CACHE_MS = 4000;          // Claude hay gọi liền vài tool — khỏi quét lại cả project mỗi lần

  async function projectItems(fresh) {
    if (!fresh && cache.items && Date.now() - cache.at < CACHE_MS) return cache.items;
    var proj = await getActiveProject();
    if (!proj) throw new Error('Chưa mở project nào trong Premiere.');
    var root = typeof proj.getRootItem === 'function' ? proj.getRootItem() : proj.rootItem;
    if (root && typeof root.then === 'function') root = await root;
    var items = await sacCollectBinItems(root);
    cache = { at: Date.now(), items: items };
    return items;
  }
  function invalidate() { cache = { at: 0, items: null }; }

  // Bản chụp gửi kèm mỗi lượt /chat — bridge trả lời tool đọc project từ đây (bridge/project-tools.js).
  // Chỉ trường cần; lỗi (chưa mở project…) → null, lượt chat vẫn chạy, chỉ là không có tool đọc bin.
  async function snapshot() {
    try {
      var items = await projectItems(true);
      var out = items.map(function (it) { return { name: it.name, path: it.path || '', isFolder: !!it.isFolder, mediaType: it.mediaType || '' }; });
      try { await learnProfile(out); } catch (e2) {}
      return out;
    } catch (e) { return null; }
  }

  // Hồ sơ quy ước của project (proj-profile.js): quét mỗi lần chụp, lưu theo project. Project chưa
  // có gì để học (mới tạo) → dùng hồ sơ đã lưu lần trước, không có thì mặc định.
  var PROFILE_LS = 'clw_proj_profile_v1';
  async function learnProfile(items) {
    if (typeof PPF === 'undefined') return;
    var proj = await getActiveProject(), key = proj && proj.path;
    if (key && typeof key.then === 'function') key = await key;
    key = String(key || '');
    var store = {};
    try { store = JSON.parse(localStorage.getItem(PROFILE_LS) || '{}') || {}; } catch (e) {}
    var p = PPF.scan(items), sig = PPF.signature(items), old = key ? store[key] : null;
    // Claude đã xem cấu trúc này rồi → dùng lại, không hỏi nữa.
    if (old && old.ai && old.v === 3 && old.sig === sig) { PPF.use(old); return; }   // v3: luôn có tóm tắt
    p.sig = sig;
    if (p.learned && key) save(store, key, p);
    else if (old) p = old;
    PPF.use(p);
    // Mỗi project hỏi Claude một lần (tóm tắt quy ước + sửa chỗ luật không chắc); chạy nền, không chặn bản chụp.
    if (key && PPF.hasWork(items) && !aiBusy[key]) {
      aiBusy[key] = 1;
      scanState = { busy: true, name: String(key).split('/').pop().replace(/\.prproj$/i, '') };
      fire();
      askAI(items, p).then(function (np) {
        if (!np) return;
        np.sig = sig;
        var st2 = {};
        try { st2 = JSON.parse(localStorage.getItem(PROFILE_LS) || '{}') || {}; } catch (e) {}
        save(st2, key, np);
        PPF.use(np);
        try { window.dispatchEvent(new Event('ppf-profile')); } catch (e) {}
      }).finally(function () { delete aiBusy[key]; scanState = { busy: false }; fire(); });
    }
  }
  var aiBusy = {}, scanState = { busy: false };
  function fire() { try { window.dispatchEvent(new Event('ppf-scan')); } catch (e) {} }
  function scanning() { return scanState; }
  function save(store, key, p) {
    store[key] = p;
    try { localStorage.setItem(PROFILE_LS, JSON.stringify(store)); } catch (e) {}
  }
  async function askAI(items, p) {
    try {
      var r = await fetch(BRIDGE_URL + '/project/profile-ai', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(PPF.aiRequest(items, p))
      }).then(function (x) { return x.json(); });
      return r && r.ok ? PPF.mergeAI(p, r.profile, items) : null;   // lỗi (offline, hết phiên) → giữ của luật
    } catch (e) { return null; }
  }

  // Đề xuất chuyển → các dòng đã đối chiếu với project (quét mới, không dùng cache).
  async function resolve(moves) {
    var items = await projectItems(true);
    return { items: items, rows: BINC.resolveMoves(items, moves) };
  }
  async function planVoice() {
    var items = await projectItems(true);
    var plan = BINC.planVoiceMoves(items);
    return { items: items, rows: BINC.resolveMoves(items, plan.map(function (p) { return { item: p.ref, to: p.to }; })) };
  }

  // Ref sequence (tab Claude) → { seqs: [Sequence], rows: [{ref, name, error}] }. Danh sách trống
  // → seqs rỗng: tab Resize/RAW tự lấy sequence đang chọn ở Project panel / đang mở.
  async function sequencesFor(refs) {
    if (!refs || !refs.length) return { seqs: [], rows: [] };
    var items = await projectItems(true);
    var rows = BINC.resolveSeqRefs(items, refs), seqs = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.error) continue;
      var sq = null;
      try { sq = await window.ResizeAPI.seqFromItem(items[r.index].item); } catch (e) {}
      if (sq) seqs.push(sq); else r.error = 'không mở được sequence';
    }
    return { seqs: seqs, rows: rows };
  }

  // Chuyển các dòng đã chọn (rows từ resolve/planVoice). onStep(i, total) để cập nhật nút.
  async function move(items, rows, onStep) {
    var proj = await getActiveProject(), done = 0, failed = [];
    for (var i = 0; i < rows.length; i++) {
      if (onStep) onStep(i, rows.length);
      var r = rows[i];
      var res = await ppMoveToBin(items[r.index].item, proj, r.to);   // thứ tự (item, proj, bin)
      if (res && res.ok) done++;
      else failed.push(r.name + ': ' + ((res && res.error) || 'lỗi'));
    }
    invalidate();
    return { done: done, failed: failed };
  }

  return { scanning: scanning, snapshot: snapshot, sequencesFor: sequencesFor, resolve: resolve, planVoice: planVoice, move: move, invalidate: invalidate };
})();
window.PTOOLS = PTOOLS;
