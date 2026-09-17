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
    perWatch: {},        // watchId → số file đã import phiên này (hiện trên badge)
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
  function wfLog(text, isErr, dim) {
    var t = new Date();
    function p2(n) { return String(n).padStart(2, '0'); }
    wfState.log.unshift({
      time: p2(t.getHours()) + ':' + p2(t.getMinutes()) + ':' + p2(t.getSeconds()),
      text: text, err: !!isErr, dim: !!dim,
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
      d.className = 'wf-log-line' + (l.err ? ' err' : (l.dim ? ' dim' : ''));
      var t = document.createElement('span');
      t.className = 'wf-log-time'; t.textContent = l.time;
      d.appendChild(t);
      d.appendChild(document.createTextNode(l.text));
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
      // 404 ở /watch/* nghĩa là bridge cũ hơn 1.16.0 — endpoint chưa tồn tại,
      // Express trả HTML nên r.json() ném và rơi vào nhánh offline.
      setStatusUI('err', r.offline
        ? 'Bridge offline hoặc cũ hơn 1.16.0 — cập nhật Bridge app'
        : ('Lỗi: ' + r.error));
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
      setStatusUI('err', r.offline
        ? 'Bridge offline hoặc cũ hơn 1.16.0'
        : ('Lỗi: ' + r.error));
      return;
    }
    setStatusUI(wfState.paused ? 'pause' : 'ok', wfState.paused ? 'Tạm dừng' : 'Đang theo dõi');
    updateStatsUI(r.stats);
    if (!r.items || r.items.length === 0) return;

    wfState.importing = true;
    var done = [], failed = [], skipped = 0;
    try {
      // Quét project MỘT lần cho cả mẻ. Đối chiếu có thể đẩy về hàng trăm file đã
      // có sẵn trong project; quét lại toàn bộ cây cho từng file là không dùng được.
      var proj0 = await getActiveProject();
      var cache = proj0 ? { proj: proj0, items: await collectAll(proj0) } : null;
      for (var i = 0; i < r.items.length; i++) {
        var it = r.items[i];
        try {
          var outcome = await importOne(it, cache);
          done.push(it.id);
          if (outcome === 'skipped') {
            skipped += 1;   // không spam nhật ký: đối chiếu có thể bỏ qua hàng trăm file
          } else {
            wfState.sessionImported += 1;
            wfState.perWatch[it.watchId] = (wfState.perWatch[it.watchId] || 0) + 1;
            wfLog('✓ ' + baseName(it.filePath) + ' → ' + it.binPath);
          }
        } catch (e) {
          failed.push({ id: it.id, reason: e.message });
          wfLog('✗ ' + baseName(it.filePath) + ' — ' + e.message, true);
        }
      }
    } finally {
      wfState.importing = false;
    }

    await api('POST', '/watch/ack', { done: done, failed: failed });
    if (done.length - skipped > 0) renderWatches();   // badge số file trên thẻ
    if (skipped > 0) wfLog('bỏ qua ' + skipped + ' file project đã có', false, true);
    if (done.length - skipped > 0) {
      api('POST', '/notify', {
        title: 'Watch Folder',
        body: 'Đã import ' + (done.length - skipped) + ' file',
      });
    }
  }

  // ── Import một file vào đúng bin ────────────────────────────────────────
  // importFiles() KHÔNG trả về ProjectItem (main.js:2488), nên phải import rồi
  // tìm lại clip theo tên và chuyển bin bằng ppMoveToBin — đúng cách autoImportVoice
  // đang làm, thay vì tự viết lại phần cast FolderItem/transaction đầy bẫy.
  async function importOne(item, cache) {
    var proj = (cache && cache.proj) || await getActiveProject();
    if (!proj) throw new Error('không có project đang mở');

    var all = (cache && cache.items) || await collectAll(proj);
    if (await findByMediaPath(all, item.filePath)) return 'skipped';   // project đã có

    if (typeof proj.importFiles !== 'function') throw new Error('không có API importFiles');
    await proj.importFiles([item.filePath]);

    var name = baseName(item.filePath);
    var after = await collectAll(proj);
    if (cache) cache.items = after;         // mẻ sau dùng lại, khỏi quét thêm lần nữa
    var hit = (await findByMediaPath(after, item.filePath))
           || after.filter(function (x) { return !x.isFolder && x.name === name; })[0];
    if (!hit) throw new Error('import xong nhưng không thấy "' + name + '" trong project');

    // Thứ tự tham số (item, proj, binName) — sai thứ tự fail ÂM THẦM.
    var mv = await ppMoveToBin(hit.item, proj, toBinName(item.binPath));
    if (!mv || !mv.ok) throw new Error((mv && mv.error) || 'chuyển vào bin thất bại');
    return 'imported';
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

  // ── Bảng chọn thư mục ───────────────────────────────────────────────────
  // UXP getFolder() chỉ nhận initialDomain nên không mở được hộp thoại hệ thống
  // tại thư mục project. Thay bằng bảng duyệt trong plugin, dữ liệu do bridge
  // cấp, mở sẵn ở root sản phẩm = cấp cha của thư mục chứa .prproj.
  var wfDir = { cur: null, dirs: [], onPick: null, hidden: [], wired: false };

  function wfDirStatus(msg, cls) {
    var el = document.getElementById('wfDirStatus');
    if (!el) return;
    el.hidden = !msg;
    el.textContent = msg || '';
    el.className = 'vgm-status' + (cls ? ' ' + cls : '');
  }

  async function wfDirLoad(p) {
    var url = '/watch/browse?' + (p
      ? 'path=' + encodeURIComponent(p)
      : 'projectPath=' + encodeURIComponent(wfState.projectPath || ''));
    wfDirStatus('⏳ Đang đọc thư mục…', '');
    var r = await api('GET', url);
    if (!r.ok) {
      wfDirStatus('⚠ Không đọc được thư mục (' + (r.error || '?') + ')', 'is-warn');
      return;
    }
    wfDirStatus('', '');
    wfDir.cur = r.path;
    wfDir.dirs = r.dirs;
    var crumb = document.getElementById('wfDirCrumb');
    if (crumb) crumb.textContent = r.path;
    wfDirRender(r.dirs);
  }

  function wfDirRender(dirs) {
    var host = document.getElementById('wfDirList');
    if (!host) return;
    host.innerHTML = '';
    var filt = document.getElementById('wfDirFilter');
    var q = (filt && filt.value.trim().toLowerCase()) || '';

    if (!dirs.length) {
      var empty = document.createElement('div');
      empty.className = 'wf-bin-hint';
      empty.textContent = 'Thư mục này không có thư mục con — bấm "Chọn" để theo dõi chính nó.';
      host.appendChild(empty);
      return;
    }

    dirs.forEach(function (d) {
      if (q && d.name.toLowerCase().indexOf(q) < 0) return;
      // KHÔNG đặt role="button": styles.css có luật chung
      // div[role="button"] { display: inline-flex } → mọi dòng chạy inline và
      // dính thành một khối chữ.
      var row = document.createElement('div');
      row.className = 'sac-bind-row';
      row.style.paddingLeft = '8px';

      var caret = document.createElement('span');
      caret.className = 'sac-bind-caret';
      caret.textContent = d.hasChildren ? '▸' : '';
      row.appendChild(caret);

      var lbl = document.createElement('span');
      lbl.textContent = d.name;
      row.appendChild(lbl);

      // Một click = đi vào trong. Chọn chính thư mục đang đứng thì bấm nút "Chọn"
      // ở dưới — nhờ vậy không cần phân biệt click chọn với click mở.
      row.addEventListener('click', function () { wfDirLoad(d.path); });
      host.appendChild(row);
    });
  }

  function wfDirClose() {
    var m = document.getElementById('wfDirModal');
    if (m) m.hidden = true;
    wfDir.hidden.forEach(function (el) { el.style.display = ''; });
    wfDir.hidden = [];
    wfDir.onPick = null;
  }

  function wfDirWire() {
    if (wfDir.wired) return;
    wfDir.wired = true;

    var close = document.getElementById('wfDirClose');
    if (close) close.addEventListener('click', wfDirClose);

    var filt = document.getElementById('wfDirFilter');
    if (filt) {
      bindKeyboard(filt);
      // Lọc trên danh sách đã tải, không gọi lại bridge mỗi phím gõ.
      filt.addEventListener('input', function () { wfDirRender(wfDir.dirs || []); });
    }

    var up = document.getElementById('wfDirUp');
    if (up) up.addEventListener('click', function () {
      if (!wfDir.cur) return;
      var parent = wfDir.cur.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
      wfDirLoad(parent);
    });

    // Đường thoát khi thư mục nguồn nằm ngoài cây project (ổ ngoài, NAS).
    var native = document.getElementById('wfDirNative');
    if (native) native.addEventListener('click', async function () {
      try {
        var uxpFs = require('uxp').storage.localFileSystem;
        var folder = await uxpFs.getFolder();
        if (!folder) return;
        var cb = wfDir.onPick;
        wfDirClose();
        if (cb) cb(folder.nativePath, folder.name);
      } catch (e) { wfDirStatus('⚠ ' + e.message, 'is-warn'); }
    });

    var save = document.getElementById('wfDirSave');
    if (save) save.addEventListener('click', function () {
      if (!wfDir.cur) return;
      var cb = wfDir.onPick;
      var chosen = wfDir.cur;
      wfDirClose();
      if (cb) cb(chosen, chosen.split('/').pop());
    });
  }

  async function wfPickFolder(opts) {
    wfDirWire();
    opts = opts || {};
    wfDir.onPick = opts.onPick || null;

    // UXP không có z-index: input native của tab đang mở sẽ vẽ đè lên modal.
    wfDir.hidden = [];
    var activePanel = document.querySelector('.tab-panel.active');
    if (activePanel) { activePanel.style.display = 'none'; wfDir.hidden.push(activePanel); }
    var modal = document.getElementById('wfDirModal');
    if (modal) modal.hidden = false;
    var filt = document.getElementById('wfDirFilter');
    if (filt) filt.value = '';

    await wfDirLoad(opts.start || null);
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
    if (!wfState.watches.length) {
      var e = document.createElement('div');
      e.className = 'wf-empty';
      var t = document.createElement('div');
      t.className = 'wf-empty-title';
      t.textContent = 'Chưa theo dõi thư mục nào';
      e.appendChild(t);
      e.appendChild(document.createTextNode(
        'Thêm một thư mục để file mới render xong tự vào bin. '
        + 'File có sẵn từ trước không bị đụng tới — dùng nút Đối chiếu khi cần kéo lại.'));
      list.appendChild(e);
      return;
    }
    wfState.watches.forEach(function (w) { list.appendChild(renderCard(w)); });
  }

  function mkBtn(text, cls, icon) {
    var b = document.createElement('div');
    b.className = 'wf-btn ' + (cls || '');
    b.setAttribute('role', 'button');
    if (window.piMakeButton) window.piMakeButton(b);
    if (icon && window.piSetBtn) window.piSetBtn(b, icon, text, null, 11);
    else b.textContent = text;
    return b;
  }

  // Nút chọn thư mục/bin: rộng hết hàng, canh trái, hiện mờ khi chưa chọn.
  function mkPick(value, placeholder) {
    var b = document.createElement('div');
    b.className = 'wf-pick' + (value ? '' : ' is-empty');
    b.setAttribute('role', 'button');
    b.textContent = value || placeholder;
    b.setPick = function (v) {
      b.textContent = v || placeholder;
      b.className = 'wf-pick' + (v ? '' : ' is-empty');
    };
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
    card.className = 'wf-card' + (w.enabled === false ? ' is-off' : '');
    card.setAttribute('data-id', w.id);

    var head = document.createElement('div');
    head.className = 'wf-card-head';

    var chk = document.createElement('input');
    chk.type = 'checkbox'; chk.checked = w.enabled !== false;
    chk.addEventListener('change', function () {
      w.enabled = chk.checked; saveConfig(); renderWatches();
    });

    var title = document.createElement('div');
    title.className = 'wf-card-title'; title.textContent = w.label || 'Watch';

    // Badge nói ngay tình trạng: chưa cấu hình xong / đang tắt / số file đã import.
    var badge = document.createElement('div');
    if (!w.folder || !w.binPath) {
      badge.className = 'wf-badge warn'; badge.textContent = 'chưa xong';
    } else if (w.enabled === false) {
      badge.className = 'wf-badge'; badge.textContent = 'tắt';
    } else {
      badge.className = 'wf-badge';
      badge.textContent = (wfState.perWatch[w.id] || 0) + ' file';
    }

    // "Đối chiếu" chứ không phải "Quét ngay": nó so thư mục với project và import
    // những file còn thiếu, kể cả file đã nằm sẵn từ trước khi tạo watch.
    var scanNow = mkBtn('Đối chiếu', 'wf-btn-sm', 'rotate_right');
    scanNow.addEventListener('click', async function () {
      scanNow.textContent = 'Đang đối chiếu…';
      var r = await api('POST', '/watch/scan-now', { watchId: w.id });
      scanNow.textContent = 'Đối chiếu';
      if (!r.ok) { wfLog('Đối chiếu "' + (w.label || w.id) + '" — ' + r.error, true); return; }
      wfLog('Đối chiếu "' + (w.label || w.id) + '": ' + r.total
        + ' file cần kiểm tra, import cái nào project còn thiếu');
    });

    var edit = mkBtn('Sửa', 'wf-btn-sm', 'gear');
    var del  = mkBtn('', 'wf-btn-sm wf-btn-danger', 'trash');
    del.addEventListener('click', function () {
      wfState.watches = wfState.watches.filter(function (x) { return x.id !== w.id; });
      saveConfig(); renderWatches();
    });

    head.appendChild(chk); head.appendChild(title); head.appendChild(badge);
    head.appendChild(scanNow); head.appendChild(edit); head.appendChild(del);

    var pathLine = document.createElement('div');
    pathLine.className = 'wf-card-path';
    pathLine.appendChild(document.createTextNode(w.folder || '(chưa chọn thư mục)'));
    var arrow = document.createElement('span');
    arrow.className = 'wf-arrow'; arrow.textContent = '→';
    pathLine.appendChild(arrow);
    var binSpan = document.createElement('span');
    binSpan.className = 'wf-bin';
    binSpan.textContent = w.binPath ? toBinName(w.binPath) : '(chưa chọn bin)';
    pathLine.appendChild(binSpan);

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
    var pickFolder = mkPick(w.folder, 'Chọn thư mục…');
    pickFolder.addEventListener('click', function () {
      wfPickFolder({
        start: w.folder || null,          // sửa watch cũ thì mở lại đúng chỗ đang trỏ
        onPick: function (p, name) {
          w.folder = p;
          if (!w.label || w.label === 'Watch mới') w.label = name;
          saveConfig(); renderWatches();
        },
      });
    });
    body.appendChild(row('Thư mục', pickFolder));

    // Bin đích — mượn modal chọn bin của Voice Gen (window.vgPickBin): nó đã có
    // cây gập/mở, sort tự nhiên (1x < 2x < 10x), tạo bin con và ô lọc. Tự vẽ lại
    // chỉ để có một cây kém hơn và lệch hành vi với phần còn lại của plugin.
    var binLine = mkPick(w.binPath ? toBinName(w.binPath) : '', 'Chọn bin…');
    var hint = document.createElement('div');
    hint.className = 'wf-bin-hint';

    binLine.addEventListener('click', function () {
      if (typeof window.vgPickBin !== 'function') {
        hint.textContent = 'Không mở được bảng chọn bin — thử reload plugin';
        return;
      }
      window.vgPickBin({
        title: 'Chọn bin cho Watch Folder',
        current: w.binPath ? toBinName(w.binPath) : '',
        onPick: function (full) {
          // Modal trả full path phân tách ' / '; watch lưu bằng '/'.
          w.binPath = String(full).split(' / ').map(function (x) { return x.trim(); })
            .filter(Boolean).join('/');
          binLine.setPick(toBinName(w.binPath));
          hint.textContent = '';
          saveConfig(); renderWatches();
        },
      });
    });

    body.appendChild(row('Bin đích', binLine));
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
  if (addBtn && window.piSetBtn) window.piSetBtn(addBtn, 'plus', 'Thêm thư mục theo dõi', null, 12);
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
    currentProjectPath: currentProjectPath,
  };
})();
