// bridge/watchfolder.js
// Engine watch folder. Không import gì của Premiere — chỉ sinh ra hàng đợi
// đường dẫn file cho plugin xử lý.
//
// Vòng đời: start(projectPath) → tick() lặp theo nextDelay() → stop().
// Quét bù nằm ngay ở tick() đầu tiên sau start, vì snapshot được nạp từ đĩa.

const path = require('path');
const { matchFile, binPathFor, validateWatch } = require('./watchfolder-rules.js');
const { scanFolder } = require('./watchfolder-scan.js');
const defaultStore = require('./watchfolder-store.js');

const IDLE_MS         = 120000;   // không có file mới bao lâu thì giãn interval
const IDLE_INTERVAL   = 10000;
const HUGE_INTERVAL   = 15000;    // khi thư mục vượt trần số file
const MAX_QUEUE       = 500;
const MAX_TRIES       = 3;
const MAX_DEAD        = 200;
const STATE_FLUSH_MS  = 30000;

function createEngine(deps) {
  const d = deps || {};
  const scan  = d.scan  || ((folder, opts) => scanFolder(folder, opts));
  const now   = d.now   || (() => Date.now());
  const store = d.store || defaultStore;

  let projectPath = null;
  let watches = [];
  let state = {};              // watchId → { snapshot, pending, status }
  let queue = [];              // { id, watchId, filePath, binPath, tries }
  let dead  = [];              // { filePath, reason, at }
  let seq = 0;
  let lastNewAt = 0;
  let lastScanAt = 0;
  let lastFlushAt = 0;
  let huge = false;
  let running = false;

  function stateFor(w) {
    if (!state[w.id]) state[w.id] = { snapshot: null, pending: {}, status: 'ok' };
    const s = state[w.id];
    if (!s.pending) s.pending = {};
    return s;
  }

  function flush(force) {
    if (!force && now() - lastFlushAt < STATE_FLUSH_MS) return;
    lastFlushAt = now();
    const out = {};
    for (const id of Object.keys(state)) {
      out[id] = { snapshot: state[id].snapshot, status: state[id].status };
    }
    store.writeState({ byWatch: out, queue, dead, projectPath });
  }

  function start(p) {
    projectPath = p;
    watches = store.readConfig(p).filter(w => validateWatch(w).ok);
    const saved = store.readState() || {};
    const by = saved.byWatch || {};
    state = {};
    for (const w of watches) {
      state[w.id] = {
        snapshot: (by[w.id] && by[w.id].snapshot) || null,   // null = chưa có baseline
        pending: {},
        status: 'ok',
      };
    }
    queue = (saved.projectPath === p && Array.isArray(saved.queue)) ? saved.queue : [];
    dead  = (saved.projectPath === p && Array.isArray(saved.dead))  ? saved.dead  : [];
    running = true;
    lastNewAt = now();
    return { watches, queued: queue.length };
  }

  function stop() {
    if (running) { tick(); }      // quét lượt cuối để snapshot sát thực tế nhất
    running = false;
    flush(true);
  }

  function tickWatch(w) {
    const s = stateFor(w);
    const res = scan(w.folder, {
      recursive: w.recursive, maxDepth: w.maxDepth,
    });

    if (!res.ok) {
      // Thư mục mất (rút ổ, mất NAS). Giữ nguyên snapshot — nếu xoá đi thì lúc
      // ổ quay lại toàn bộ file cũ sẽ bị coi là mới và import lại hàng loạt.
      s.status = 'unavailable';
      s.pending = {};
      return;
    }
    s.status = 'ok';
    if (res.truncated) huge = true;

    // Lần đầu thấy watch này: chỉ chụp baseline, không import gì (Câu 3 = A).
    if (s.snapshot === null) {
      s.snapshot = res.files;
      return;
    }

    const cur = res.files;
    for (const rel of Object.keys(cur)) {
      if (s.snapshot[rel]) continue;          // đã biết từ trước
      if (!matchFile(w, rel)) continue;

      const size = cur[rel][0], mtime = cur[rel][1];
      if (size === 0) { s.pending[rel] = { size, mtime, count: 1 }; continue; }

      const prev = s.pending[rel];
      if (prev && prev.size === size && prev.mtime === mtime) {
        prev.count += 1;
        if (prev.count >= (Number(w.stableChecks) || 2)) {
          enqueue(w, rel);
          delete s.pending[rel];
          s.snapshot[rel] = [size, mtime];
        }
      } else {
        s.pending[rel] = { size, mtime, count: 1 };
      }
    }

    // File biến mất trước khi kịp ổn định thì bỏ khỏi pending.
    for (const rel of Object.keys(s.pending)) if (!cur[rel]) delete s.pending[rel];
  }

  function enqueue(w, rel) {
    if (queue.length >= MAX_QUEUE) return;    // trần chống phình bộ nhớ
    var abs = path.join(w.folder, rel.split('/').join(path.sep));
    if (queue.some(function (it) { return it.filePath === abs; })) return;   // đã chờ rồi
    queue.push({
      id: 'q' + (++seq) + '_' + now(),
      watchId: w.id,
      filePath: abs,
      binPath: binPathFor(w, rel),
      tries: 0,
    });
    lastNewAt = now();
  }

  function tick() {
    if (!running) return;
    huge = false;
    for (const w of watches) {
      if (w.enabled === false) continue;
      tickWatch(w);
    }
    lastScanAt = now();
    flush(false);
  }

  // "Quét ngay" KHÔNG phải là chạy sớm một lượt quét thường: một lượt tick không
  // bao giờ đẩy được file nào (file phải ổn định qua stableChecks lượt), nên nút
  // đó sẽ không làm gì cả.
  //
  // Nó là nút ĐỐI CHIẾU: đẩy vào hàng đợi mọi file đã có trong snapshot — tức đã
  // tồn tại từ lượt quét trước, chắc chắn không phải đang ghi dở — để plugin so
  // với project và import cái nào còn thiếu. Nhờ vậy file có sẵn lúc tạo watch,
  // hoặc clip lỡ bị xoá khỏi project, vẫn kéo lại được mà không cần tạo watch mới.
  //
  // File chưa từng thấy thì KHÔNG đẩy — có thể đang render dở; cứ để nó đi qua
  // đường ổn định như thường.
  function scanNow(watchId) {
    const w = watches.find(x => x.id === watchId);
    if (!w) return { ok: false, error: 'không tìm thấy watch' };
    if (w.enabled === false) return { ok: false, error: 'watch đang tắt' };

    const before = queue.length;
    const s = stateFor(w);
    tickWatch(w);                       // cập nhật snapshot + bắt file mới như thường
    if (s.status === 'unavailable') {
      return { ok: false, error: 'không đọc được thư mục' };
    }

    const known = s.snapshot || {};
    for (const rel of Object.keys(known)) {
      if (!matchFile(w, rel)) continue;
      if (known[rel] && known[rel][0] === 0) continue;   // file rỗng thì không import
      enqueue(w, rel);
    }
    flush(true);
    return { ok: true, queued: queue.length - before, total: queue.length };
  }

  function poll(limit) {
    const n = Math.max(1, Number(limit) || 20);
    return { items: queue.slice(0, n), stats: stats() };
  }

  function ack(done, failed) {
    const doneSet = new Set(done || []);
    queue = queue.filter(it => !doneSet.has(it.id));

    for (const f of (failed || [])) {
      const it = queue.find(x => x.id === f.id);
      if (!it) continue;
      it.tries += 1;
      if (it.tries >= MAX_TRIES) {
        dead.unshift({ filePath: it.filePath, reason: f.reason || 'không rõ', at: now() });
        dead = dead.slice(0, MAX_DEAD);
        queue = queue.filter(x => x.id !== it.id);
      }
    }
    flush(true);
    return { queued: queue.length };
  }

  // Quét thưa dần khi không có gì xảy ra; có file mới là về lại ngay.
  function nextDelay() {
    if (huge) return HUGE_INTERVAL;
    const base = watches.reduce(
      (m, w) => Math.min(m, Number(w.intervalMs) || 3000), 3000);
    if (now() - lastNewAt > IDLE_MS) return Math.max(base, IDLE_INTERVAL);
    return base;
  }

  function stats() {
    return {
      running, projectPath, queued: queue.length, lastScanAt, dead,
      watches: watches.map(w => ({
        id: w.id, label: w.label, enabled: w.enabled !== false,
        status: (state[w.id] && state[w.id].status) || 'ok',
      })),
    };
  }

  return { start, stop, tick, scanNow, poll, ack, nextDelay, stats };
}

module.exports = { createEngine, MAX_QUEUE, MAX_TRIES };
