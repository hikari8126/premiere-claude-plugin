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
      return items.map(function (it) { return { name: it.name, path: it.path || '', isFolder: !!it.isFolder, mediaType: it.mediaType || '' }; });
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

  return { snapshot: snapshot, sequencesFor: sequencesFor, resolve: resolve, planVoice: planVoice, move: move, invalidate: invalidate };
})();
window.PTOOLS = PTOOLS;
