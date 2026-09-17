// plugin/watch.js — tab Watch Folder: theo dõi thư mục, tự import file mới vào bin.
//
// Classic script, nạp SAU main.js nên dùng chung global scope của main.js:
//   BRIDGE_URL, claimKeyboard/releaseKeyboard, getActiveProject,
//   ppGetOrCreateBin, ppMoveToBin, sacCollectBinItems, ppro.
//
// Bridge quét thư mục và giữ hàng đợi; file này chỉ poll hàng đợi rồi import.
// Thiết kế: docs/superpowers/specs/2026-09-17-watch-folder-auto-import-design.md

(function () {
  'use strict';

  var POLL_MS = 2000;
  var PROJECT_CHECK_MS = 5000;

  var wfState = {
    projectPath: null,
    watches: [],
    paused: false,
    pollTimer: null,
    importing: false,
    sessionImported: 0,
    log: [],
    started: false,
  };

  // ── HTTP ────────────────────────────────────────────────────────────────
  // Bọc fetch để bridge tắt giữa chừng không ném ra ngoài vòng poll.
  function api(method, url, body) {
    return fetch(BRIDGE_URL + url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json(); })
      .catch(function (e) { return { ok: false, error: e.message, offline: true }; });
  }

  function baseName(p) { return String(p).split('/').pop().split('\\').pop(); }

  // binPath lưu bằng '/', nhưng ppGetOrCreateBin/ppMoveToBin tách theo ' / '.
  function toBinName(binPath) {
    return String(binPath).split('/').map(function (s) { return s.trim(); })
      .filter(Boolean).join(' / ');
  }

  // ── Nhật ký ─────────────────────────────────────────────────────────────
  function wfLog(text, isErr) {
    var t = new Date();
    function p2(n) { return String(n).padStart(2, '0'); }
    wfState.log.unshift({
      time: p2(t.getHours()) + ':' + p2(t.getMinutes()) + ':' + p2(t.getSeconds()),
      text: text, err: !!isErr,
    });
    if (wfState.log.length > 200) wfState.log.length = 200;
    renderLog();
  }

  function renderLog() {
    var box = document.getElementById('wfLog');
    var cnt = document.getElementById('wfLogCount');
    if (cnt) cnt.textContent = '(' + wfState.log.length + ')';
    if (!box || box.hidden) return;
    box.innerHTML = '';
    wfState.log.forEach(function (l) {
      var d = document.createElement('div');
      d.className = 'wf-log-line' + (l.err ? ' err' : '');
      d.textContent = l.time + '  ' + l.text;
      box.appendChild(d);
    });
  }

  // ── Project đang mở ─────────────────────────────────────────────────────
  // proj.path là string đồng bộ trên Premiere 25.6.5, nhưng build khác có thể
  // trả Promise — String(Promise) ra '[object Promise]' chứ không rỗng, nên
  // phải await trước khi kiểm tra (đúng bài học ở main.js autoProjectPath).
  async function currentProjectPath() {
    try {
      var proj = await getActiveProject();
      if (!proj) return null;
      var raw = proj.path;
      if (raw && typeof raw.then === 'function') raw = await raw;
      if (!raw || typeof raw !== 'string' || raw.charAt(0) !== '/') return null;
      return raw;
    } catch (e) { return null; }
  }

  // ── Session ─────────────────────────────────────────────────────────────
  async function startSession() {
    var p = await currentProjectPath();
    if (!p) {
      setStatusUI('err', 'Project chưa lưu — lưu .prproj trước khi tạo watch');
      return false;
    }
    wfState.projectPath = p;

    var cfg = await api('GET', '/watch/config?projectPath=' + encodeURIComponent(p));
    wfState.watches = (cfg && cfg.watches) || [];

    var r = await api('POST', '/watch/session/start', { projectPath: p });
    if (!r.ok) {
      setStatusUI('err', r.offline ? 'Bridge offline' : ('Lỗi: ' + r.error));
      return false;
    }

    renderWatches();
    setStatusUI('ok', 'Đang theo dõi');
    startPolling();
    return true;
  }

  async function stopSession() {
    stopPolling();
    await api('POST', '/watch/session/stop', {});
  }

  function startPolling() {
    stopPolling();
    wfState.pollTimer = setInterval(pollOnce, POLL_MS);
    pollOnce();
  }

  function stopPolling() {
    if (wfState.pollTimer) clearInterval(wfState.pollTimer);
    wfState.pollTimer = null;
  }

  // ── Poll + import ───────────────────────────────────────────────────────
  async function pollOnce() {
    if (wfState.paused || wfState.importing) return;
    var r = await api('GET', '/watch/poll');
    if (!r.ok) {
      setStatusUI('err', r.offline ? 'Bridge offline' : ('Lỗi: ' + r.error));
      return;
    }
    setStatusUI(wfState.paused ? 'pause' : 'ok', wfState.paused ? 'Tạm dừng' : 'Đang theo dõi');
    updateStatsUI(r.stats);
    if (!r.items || r.items.length === 0) return;

    wfState.importing = true;
    var done = [], failed = [];
    try {
      for (var i = 0; i < r.items.length; i++) {
        var it = r.items[i];
        try {
          await importOne(it);
          done.push(it.id);
          wfState.sessionImported += 1;
          wfLog('✓ ' + baseName(it.filePath) + ' → ' + it.binPath);
        } catch (e) {
          failed.push({ id: it.id, reason: e.message });
          wfLog('✗ ' + baseName(it.filePath) + ' — ' + e.message, true);
        }
      }
    } finally {
      wfState.importing = false;
    }

    await api('POST', '/watch/ack', { done: done, failed: failed });
    if (done.length > 0) {
      api('POST', '/notify', {
        title: 'Watch Folder',
        body: 'Đã import ' + done.length + ' file',
      });
    }
  }

  // ── Import một file vào đúng bin ────────────────────────────────────────
  // importFiles() KHÔNG trả về ProjectItem (main.js:2488), nên phải import rồi
  // tìm lại clip theo tên và chuyển bin bằng ppMoveToBin — đúng cách autoImportVoice
  // đang làm, thay vì tự viết lại phần cast FolderItem/transaction đầy bẫy.
  async function importOne(item) {
    var proj = await getActiveProject();
    if (!proj) throw new Error('không có project đang mở');

    var all = await collectAll(proj);
    if (await findByMediaPath(all, item.filePath)) return;   // đã có trong project, bỏ qua

    if (typeof proj.importFiles !== 'function') throw new Error('không có API importFiles');
    await proj.importFiles([item.filePath]);

    var name = baseName(item.filePath);
    var after = await collectAll(proj);
    var hit = (await findByMediaPath(after, item.filePath))
           || after.filter(function (x) { return !x.isFolder && x.name === name; })[0];
    if (!hit) throw new Error('import xong nhưng không thấy "' + name + '" trong project');

    // Thứ tự tham số (item, proj, binName) — sai thứ tự fail ÂM THẦM.
    var mv = await ppMoveToBin(hit.item, proj, toBinName(item.binPath));
    if (!mv || !mv.ok) throw new Error((mv && mv.error) || 'chuyển vào bin thất bại');
  }

  async function collectAll(proj) {
    var root = typeof proj.getRootItem === 'function' ? proj.getRootItem() : proj.rootItem;
    if (root && typeof root.then === 'function') root = await root;
    if (!root) return [];
    return await sacCollectBinItems(root);
  }

  async function mediaPathOf(entry) {
    try {
      var cast = (ppro && ppro.ClipProjectItem && ppro.ClipProjectItem.cast)
        ? ppro.ClipProjectItem.cast(entry.item) : null;
      var target = cast || entry.item;
      if (!target || typeof target.getMediaFilePath !== 'function') return null;
      var p = target.getMediaFilePath();
      if (p && typeof p.then === 'function') p = await p;
      return p ? String(p) : null;
    } catch (e) { return null; }
  }

  // Chống import trùng: so sánh theo ĐƯỜNG DẪN MEDIA, không theo tên, vì hai
  // thư mục khác nhau hoàn toàn có thể chứa file trùng tên. Lọc theo tên trước
  // rồi mới đọc media path, để không phải gọi getMediaFilePath cho cả project
  // mỗi lượt import.
  async function findByMediaPath(all, filePath) {
    var want = String(filePath).toLowerCase();
    var name = baseName(filePath);
    var cands = all.filter(function (x) { return !x.isFolder && x.name === name; });
    for (var i = 0; i < cands.length; i++) {
      var mp = await mediaPathOf(cands[i]);
      if (mp && String(mp).toLowerCase() === want) return cands[i];
    }
    return null;
  }

  // ── Cây bin ─────────────────────────────────────────────────────────────
  async function readBinTree() {
    var proj = await getActiveProject();
    if (!proj) return [];
    var all = await collectAll(proj);
    return all.filter(function (x) { return x.isFolder; }).map(function (x) {
      var full = x.path ? x.path + '/' + x.name : x.name;
      return { path: full, name: x.name, depth: full.split('/').length - 1 };
    }).sort(function (a, b) { return a.path.localeCompare(b.path); });
  }

  // ── Trạng thái UI ───────────────────────────────────────────────────────
  function setStatusUI(kind, text) {
    var dot = document.getElementById('wfDot');
    var txt = document.getElementById('wfStatusText');
    if (dot) dot.className = 'wf-dot ' + (kind === 'ok' ? 'ok' : kind === 'pause' ? 'pause' : 'err');
    if (txt) txt.textContent = text;
  }

  function updateStatsUI(stats) {
    var sub = document.getElementById('wfStatusSub');
    if (!sub || !stats) return;
    var name = wfState.projectPath ? baseName(wfState.projectPath) : '—';
    sub.textContent = stats.watches.length + ' watch · ' + name
      + ' · chờ ' + stats.queued + ' file · đã import '
      + wfState.sessionImported + ' file phiên này';

    // Watch mất thư mục thì tô cảnh báo lên đúng card.
    stats.watches.forEach(function (w) {
      var card = document.querySelector('.wf-card[data-id="' + w.id + '"]');
      if (card) card.className = 'wf-card' + (w.status === 'unavailable' ? ' unavailable' : '');
    });
  }

  // ── Render danh sách watch ──────────────────────────────────────────────
  function newWatch() {
    return {
      id: 'w_' + Math.random().toString(36).slice(2, 8),
      enabled: true, label: 'Watch mới', folder: '', binPath: '',
      recursive: true, maxDepth: 3, mirrorSubfolders: true,
      include: ['video'], includeRegex: '', excludeRegex: '',
      intervalMs: 3000, stableChecks: 2,
    };
  }

  function renderWatches() {
    var list = document.getElementById('wfList');
    if (!list) return;
    list.innerHTML = '';
    wfState.watches.forEach(function (w) { list.appendChild(renderCard(w)); });
  }

  function mkBtn(text, cls) {
    var b = document.createElement('div');
    b.className = 'wf-btn ' + (cls || '');
    b.setAttribute('role', 'button');
    b.textContent = text;
    return b;
  }

  function row(labelText, node) {
    var r = document.createElement('div'); r.className = 'wf-row';
    var l = document.createElement('label'); l.textContent = labelText;
    r.appendChild(l); r.appendChild(node);
    return r;
  }

  // Thiếu cặp claim/release thì phím tắt B/V/C của Premiere nuốt ký tự.
  function bindKeyboard(input) {
    input.addEventListener('focus', function () {
      if (window.claimKeyboard) window.claimKeyboard();
    });
    input.addEventListener('blur', function () {
      if (window.releaseKeyboard) window.releaseKeyboard();
    });
  }

  function renderCard(w) {
    var card = document.createElement('div');
    card.className = 'wf-card';
    card.setAttribute('data-id', w.id);

    var head = document.createElement('div');
    head.className = 'wf-card-head';

    var chk = document.createElement('input');
    chk.type = 'checkbox'; chk.checked = w.enabled !== false;
    chk.addEventListener('change', function () { w.enabled = chk.checked; saveConfig(); });

    var title = document.createElement('div');
    title.className = 'wf-card-title'; title.textContent = w.label || 'Watch';

    var spacer = document.createElement('div'); spacer.className = 'wf-spacer';

    var scanNow = mkBtn('Quét ngay', 'wf-btn-sm');
    scanNow.addEventListener('click', function () {
      api('POST', '/watch/scan-now', { watchId: w.id });
    });

    var edit = mkBtn('Sửa', 'wf-btn-sm');
    var del  = mkBtn('Xoá', 'wf-btn-sm');
    del.addEventListener('click', function () {
      wfState.watches = wfState.watches.filter(function (x) { return x.id !== w.id; });
      saveConfig(); renderWatches();
    });

    head.appendChild(chk); head.appendChild(title); head.appendChild(spacer);
    head.appendChild(scanNow); head.appendChild(edit); head.appendChild(del);

    var pathLine = document.createElement('div');
    pathLine.className = 'wf-card-path';
    pathLine.textContent = (w.folder || '(chưa chọn thư mục)')
      + '  →  ' + (w.binPath || '(chưa chọn bin)');

    var body = renderForm(w);
    body.hidden = !!(w.folder && w.binPath);   // watch chưa xong thì mở sẵn form
    edit.addEventListener('click', function () { body.hidden = !body.hidden; });

    card.appendChild(head); card.appendChild(pathLine); card.appendChild(body);
    return card;
  }

  function renderForm(w) {
    var body = document.createElement('div');
    body.className = 'wf-card-body';

    // Tên
    var nameIn = document.createElement('input');
    nameIn.type = 'text'; nameIn.value = w.label || '';
    bindKeyboard(nameIn);
    nameIn.addEventListener('change', function () {
      w.label = nameIn.value; saveConfig(); renderWatches();
    });
    body.appendChild(row('Tên', nameIn));

    // Thư mục
    var pickFolder = mkBtn(w.folder || 'Chọn thư mục…');
    pickFolder.addEventListener('click', async function () {
      try {
        var uxpFs = require('uxp').storage.localFileSystem;
        var folder = await uxpFs.getFolder();
        if (!folder) return;
        w.folder = folder.nativePath;
        if (!w.label || w.label === 'Watch mới') w.label = folder.name;
        saveConfig(); renderWatches();
      } catch (e) { wfLog('Không chọn được thư mục — ' + e.message, true); }
    });
    body.appendChild(row('Thư mục', pickFolder));

    // Bin đích + cây bin
    var binLine = mkBtn(w.binPath ? w.binPath.split('/').join(' / ') : 'Chọn bin…');
    var tree = document.createElement('div');
    tree.className = 'wf-tree'; tree.hidden = true;
    var hint = document.createElement('div');
    hint.className = 'wf-bin-hint';

    binLine.addEventListener('click', async function () {
      tree.hidden = !tree.hidden;
      if (tree.hidden) return;
      tree.innerHTML = '';
      var loading = document.createElement('div');
      loading.className = 'wf-bin-hint'; loading.textContent = 'Đang đọc cây bin…';
      tree.appendChild(loading);

      var bins = await readBinTree();
      tree.innerHTML = '';
      bins.forEach(function (b) {
        var r = document.createElement('div');
        r.className = 'wf-tree-row' + (b.path === w.binPath ? ' selected' : '');
        r.setAttribute('role', 'button');
        r.textContent = new Array(b.depth + 1).join('   ') + b.name;
        r.addEventListener('click', function () {
          w.binPath = b.path;
          binLine.textContent = b.path.split('/').join(' / ');
          hint.textContent = '';
          tree.hidden = true; saveConfig(); renderWatches();
        });
        tree.appendChild(r);
      });

      var mk = document.createElement('div');
      mk.className = 'wf-tree-row wf-tree-new';
      mk.setAttribute('role', 'button');
      mk.textContent = '＋ Tạo bin mới…';
      mk.addEventListener('click', function () {
        var inp = document.createElement('input');
        inp.type = 'text'; inp.value = w.binPath || 'Footage/';
        bindKeyboard(inp);
        inp.addEventListener('change', function () {
          w.binPath = inp.value.replace(/^\/+|\/+$/g, '');
          binLine.textContent = w.binPath.split('/').join(' / ');
          hint.textContent = 'sẽ được tạo khi import';
          tree.hidden = true; saveConfig(); renderWatches();
        });
        tree.innerHTML = ''; tree.appendChild(inp);
        inp.focus();
      });
      tree.appendChild(mk);
    });

    body.appendChild(row('Bin đích', binLine));
    body.appendChild(tree);
    body.appendChild(hint);

    // Loại file
    var kinds = document.createElement('div');
    [['video', 'Video'], ['audio', 'Audio'], ['image', 'Ảnh'], ['all', 'Tất cả']]
      .forEach(function (pair) {
        var lab = document.createElement('label');
        lab.style.marginRight = '10px';
        var c = document.createElement('input');
        c.type = 'checkbox'; c.checked = w.include.indexOf(pair[0]) >= 0;
        c.addEventListener('change', function () {
          w.include = c.checked
            ? w.include.concat([pair[0]])
            : w.include.filter(function (k) { return k !== pair[0]; });
          saveConfig();
        });
        lab.appendChild(c);
        lab.appendChild(document.createTextNode(' ' + pair[1]));
        kinds.appendChild(lab);
      });
    body.appendChild(row('Loại file', kinds));

    function checkRow(labelText, key) {
      var c = document.createElement('input');
      c.type = 'checkbox'; c.checked = w[key] !== false;
      c.addEventListener('change', function () { w[key] = c.checked; saveConfig(); });
      return row(labelText, c);
    }
    body.appendChild(checkRow('Quét thư mục con', 'recursive'));
    body.appendChild(checkRow('Mirror thành bin con', 'mirrorSubfolders'));

    function textRow(labelText, key, placeholder) {
      var i = document.createElement('input');
      i.type = 'text'; i.value = w[key] || ''; i.placeholder = placeholder || '';
      bindKeyboard(i);
      i.addEventListener('change', function () { w[key] = i.value; saveConfig(); });
      return row(labelText, i);
    }
    body.appendChild(textRow('Chỉ nhận (regex)', 'includeRegex', 'ví dụ ^DJI_'));
    body.appendChild(textRow('Loại trừ (regex)', 'excludeRegex', 'ví dụ _proxy$'));

    var iv = document.createElement('input');
    iv.type = 'number'; iv.value = w.intervalMs || 3000; iv.min = '1000'; iv.step = '1000';
    bindKeyboard(iv);
    iv.addEventListener('change', function () {
      w.intervalMs = Number(iv.value) || 3000; saveConfig();
    });
    body.appendChild(row('Chu kỳ quét (ms)', iv));

    return body;
  }

  // ── Lưu config ──────────────────────────────────────────────────────────
  // Bridge validate lần nữa; regex sai thì báo đỏ chứ không lưu im lặng.
  async function saveConfig() {
    if (!wfState.projectPath) return;
    var incomplete = wfState.watches.filter(function (w) { return !w.folder || !w.binPath; });
    var ready = wfState.watches.filter(function (w) { return w.folder && w.binPath; });

    var r = await api('POST', '/watch/config', {
      projectPath: wfState.projectPath, watches: ready,
    });
    var list = document.getElementById('wfList');
    if (!r.ok) {
      wfLog('Config chưa lưu được — ' + r.error, true);
      if (list) list.classList.add('invalid');
      setStatusUI('err', r.error);
      return;
    }
    if (list) list.classList.remove('invalid');

    // Config đổi thì khởi động lại session để engine nạp watch mới.
    await api('POST', '/watch/session/start', { projectPath: wfState.projectPath });
    setStatusUI(wfState.paused ? 'pause' : 'ok',
      incomplete.length ? (incomplete.length + ' watch chưa đủ thư mục/bin')
                        : (wfState.paused ? 'Tạm dừng' : 'Đang theo dõi'));
  }

  // ── Gắn sự kiện ─────────────────────────────────────────────────────────
  var addBtn = document.getElementById('wfAdd');
  if (addBtn) addBtn.addEventListener('click', function () {
    wfState.watches.push(newWatch());
    renderWatches();
  });

  var pauseBtn = document.getElementById('wfPauseAll');
  if (pauseBtn) pauseBtn.addEventListener('click', function () {
    wfState.paused = !wfState.paused;
    pauseBtn.textContent = wfState.paused ? 'Tiếp tục' : 'Tạm dừng tất cả';
    setStatusUI(wfState.paused ? 'pause' : 'ok',
      wfState.paused ? 'Tạm dừng' : 'Đang theo dõi');
  });

  var logHead = document.getElementById('wfLogHead');
  if (logHead) logHead.addEventListener('click', function () {
    var box = document.getElementById('wfLog');
    box.hidden = !box.hidden;
    document.getElementById('wfLogCaret').textContent = box.hidden ? '▸' : '▾';
    renderLog();
  });

  // Chỉ khởi động session khi người dùng thực sự mở tab Watch — không ai dùng
  // tính năng này thì bridge không quét gì cả.
  var tabBtn = document.querySelector('.tab-btn[data-tab="watch"]');
  if (tabBtn) tabBtn.addEventListener('click', function () {
    if (wfState.started) return;
    wfState.started = true;
    startSession();
  });

  // Đổi project khi panel đang mở: đóng session cũ, mở session mới.
  setInterval(async function () {
    if (!wfState.started) return;
    var p = await currentProjectPath();
    if (p && p !== wfState.projectPath) {
      await stopSession();
      var ok = await startSession();
      if (ok) wfLog('Đã chuyển sang project ' + baseName(p));
    }
  }, PROJECT_CHECK_MS);

  // Để gỡ lỗi từ console UXP.
  window.wfInternals = {
    state: wfState, api: api, log: wfLog,
    startSession: startSession, stopSession: stopSession,
    currentProjectPath: currentProjectPath, readBinTree: readBinTree,
  };
})();
