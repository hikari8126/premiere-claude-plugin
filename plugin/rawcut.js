// plugin/rawcut.js — tab Raw-cutter: cắt từng cut của timeline ra file riêng (+ clips.csv,
// manifest.json, MP3 voice-over).
//
// Port từ Raw-cutter 3.93 (CEP, của mill2nn) sang UXP. Chia việc:
//   rawcut-core.js  (RCC) logic thuần — dump, fingerprint, lọc clip, danh sách render
//   rawcut-ppro.js  (RCP) gọi Premiere — đọc sequence, FCP XML, render từng cut
//   bridge /rawcut/* — lưu lần đọc, chạy engine xmlcut.py (ffmpeg), thư mục xuất SAMX
// Classic script, nạp SAU main.js: dùng chung BRIDGE_URL, claimKeyboard/releaseKeyboard.
//
// Ba mode: Source Render (cắt từ file gốc → <version>/raw/), Timeline Render (Premiere
// render từng cut kèm màu/title/effect → <version>/edited/), Both (raw/ rồi edited/).
// Retry = chạy lại đúng lựa chọn với --resume: clip đã xong giữ nguyên, manifest đủ dòng.

(function () {
  'use strict';

  var LS_KEY = 'rc_prefs';
  var MODES = { source: 'Source Render', render: 'Timeline Render', both: 'Both' };
  var HALF_LABEL = { source: 'Source Render → raw/', render: 'Timeline Render → edited/' };
  var SCALES = [100, 75, 50, 25];
  var FPS_LIST = ['', '23.976', '24', '25', '29.97', '30', '50', '59.94', '60'];
  var MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;   // cache render cần trống ≥ 2 GB
  // Cờ [n/N] của engine coi là lỗi thật (xmlcut.py ~12241): FAIL, BAD, MISS (mất nguồn), NORE (thiếu render).
  var REAL_FAIL = { FAIL: 1, BAD: 1, MISS: 1, NORE: 1 };

  var st = {
    prefs: null,
    read: null,        // lần Đọc timeline gần nhất
    dest: null,        // kết quả /rawcut/dest
    view: 'source',    // danh sách đang xem trong mode Both
    unpicked: { source: {}, render: {} },
    showDead: false,
    busy: false,
    running: false,
    stop: false,
    xhr: null,
    confirmResolve: null,
    last: null,        // lượt xuất gần nhất (cho Retry / Mở thư mục)
    presets: {},
    watch: { polling: false, pendingKey: '', changedAt: 0, failKey: '' }
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function base(p) { var s = String(p || ''); return s.substring(s.lastIndexOf('/') + 1); }
  function shortDir(p) { var parts = String(p || '').split('/').filter(Boolean); return parts.length > 4 ? '…/' + parts.slice(-4).join('/') : String(p || ''); }

  // ── Prefs ───────────────────────────────────────────────────────────────
  function loadPrefs() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) {}
    var crf = Number(s.crf);
    return {
      mode: MODES[s.mode] ? s.mode : 'both',
      types: (s.types && typeof s.types === 'object') ? s.types : {},
      crf: (crf >= 1 && crf <= 35) ? crf : 1,
      scale: SCALES.indexOf(Number(s.scale)) !== -1 ? Number(s.scale) : 100,
      fps: FPS_LIST.indexOf(String(s.fps || '')) !== -1 ? String(s.fps || '') : '',
      transitions: s.transitions !== false,
      resume: !!s.resume,
      audioMix: !!s.audioMix,
      audioPer: Array.isArray(s.audioPer) ? s.audioPer : [],
      hear: (s.hear && typeof s.hear === 'object') ? s.hear : {},
      vinc: (s.vinc && typeof s.vinc === 'object') ? s.vinc : {},
      master: (s.master && typeof s.master === 'object') ? s.master : {},
      chosen: (s.chosen && typeof s.chosen === 'object') ? s.chosen : {},
      productPick: (s.productPick && typeof s.productPick === 'object') ? s.productPick : {}
    };
  }
  function savePrefs() { try { localStorage.setItem(LS_KEY, JSON.stringify(st.prefs)); } catch (e) {} }

  // ── Bridge ──────────────────────────────────────────────────────────────
  async function api(method, url, body, signal) {
    try {
      var init = method === 'GET' ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) };
      if (signal) init.signal = signal;
      var r = await fetch(BRIDGE_URL + url, init);
      var t = await r.text();
      try { return JSON.parse(t); }
      catch (e) { return { ok: false, error: r.status === 404 ? 'Bridge chưa có Raw-cutter — cập nhật Claude Bridge.' : 'Bridge trả về lỗi (' + r.status + ')' }; }
    } catch (e) {
      if (signal && signal.aborted) return { ok: false, aborted: true, error: 'Đã dừng.' };
      return { ok: false, error: 'Không kết nối được Bridge (localhost:3030) — mở Claude Bridge.' };
    }
  }
  function bridgeHasRawcut() {
    var h = window.bridgeHealth;
    if (!h) return true;   // chưa biết → không chặn, lỗi thật sẽ hiện khi gọi
    return !!(h.capabilities && h.capabilities.rawcut);
  }

  // POST SSE qua XHR: onEvent(obj) cho mỗi dòng data:, trả {end} khi xong.
  function sse(url, body, onEvent) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest(), last = 0, buf = '', end = null, done = false;
      st.xhr = xhr;
      xhr.__rcAborted = false;
      function pump() {
        var text = xhr.responseText || '';
        buf += text.slice(last); last = text.length;
        var i;
        while ((i = buf.indexOf('\n')) >= 0) {
          var line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (line.indexOf('data: ') !== 0) continue;
          var raw = line.slice(6);
          if (raw === '[DONE]') continue;
          try { var ev = JSON.parse(raw); if (ev.type === 'end') end = ev; else onEvent(ev); } catch (e) {}
        }
      }
      function finish(extra) { if (done) return; done = true; st.xhr = null; resolve(Object.assign({ end: end }, extra || {})); }
      xhr.open('POST', BRIDGE_URL + url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.responseType = 'text';
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 3 || xhr.readyState === 4) pump();
        if (xhr.readyState === 4) {
          // abort()/mất mạng cũng đi qua readyState 4 (status 0) TRƯỚC onabort/onerror.
          if (!end && (xhr.__rcAborted || st.stop)) { finish({ aborted: true }); return; }
          if (!end && !xhr.status) { finish({ error: 'Mất kết nối Bridge giữa chừng' }); return; }
          if (!end && xhr.status && xhr.status !== 200) {
            var err = '';
            try { err = JSON.parse(xhr.responseText).error; } catch (e) { err = 'Bridge lỗi ' + xhr.status; }
            finish({ error: err });
          } else finish();
        }
      };
      xhr.onerror = function () { finish({ error: 'Mất kết nối Bridge giữa chừng' }); };
      xhr.onabort = function () { finish({ aborted: true }); };
      xhr.send(JSON.stringify(body || {}));
    });
  }

  // ── Nhân vật pixel (rawcut-pixel.js) — không có thì bỏ qua ──
  function pixel(scene) { if (typeof RCPX !== 'undefined') RCPX.play(scene, $('rcPixel')); }
  function pixelEnd(ok, cancelled) {
    if (typeof RCPX === 'undefined') return;
    if (cancelled) RCPX.hide(); else RCPX.finish(ok);
  }

  // ── Trạng thái chung ────────────────────────────────────────────────────
  // Dòng trạng thái chỉ còn cho lỗi / cảnh báo. Thông tin tiến trình chạy ở chân trang
  // (cạnh nhân vật pixel); thành công thì im — đã có thẻ báo cáo + ✓.
  function setStatus(msg, kind) {
    var m = String(msg || '').replace(/^[✓✅❌⛔⚠⏳]\uFE0F?\s*/, '');
    var s = $('rcStatus');
    if (kind === 'err' || kind === 'warn') {
      s.textContent = m;
      s.className = 'rc-status' + (kind === 'err' ? ' rc-err' : '');
      return;
    }
    s.textContent = '';
    s.className = 'rc-status';
    if (m && (st.busy || st.running)) liveText(m);
  }
  function liveText(m) {
    $('rcProgress').style.display = '';
    $('rcBar').style.display = 'none';
    $('rcProgText').textContent = m;
  }
  function setBusy(b, label) {
    st.busy = b;
    $('rcRead').classList.toggle('is-disabled', b);
    if (!b && !st.running) showProgress(false);
    paintGo(label);
  }
  function projectKey() { return (st.read && st.read.projectPath) || ''; }

  // ── Đọc timeline ────────────────────────────────────────────────────────
  function scanOptions(half) {
    var p = st.prefs, o = { transitions: p.transitions ? 'split' : 'ignore', crf: p.crf, scale: p.scale };
    if (p.fps) o.fps = p.fps;
    if (half === 'render' && st.read && st.read.master) o.videoTrack = st.read.master;
    return o;
  }

  // opts.auto: do theo dõi timeline gọi (sequence mới / timeline vừa sửa) — không xoá báo cáo.
  async function onRead(opts) {
    opts = (opts && opts.auto) ? opts : {};
    if (st.busy || st.running || st.confirmResolve) return;
    if (typeof RCP === 'undefined' || typeof RCC === 'undefined') { setStatus('Thiếu rawcut-core.js / rawcut-ppro.js', 'err'); return; }
    if (!bridgeHasRawcut()) { setStatus('Bridge chưa có Raw-cutter — cập nhật Claude Bridge rồi thử lại.', 'err'); return; }
    if (!opts.auto) st.watch.failKey = '';
    var prev = st.read;
    setBusy(true, 'ĐANG ĐỌC…');
    pixel('read');
    var readOk = false;
    try {
      var env = await api('GET', '/rawcut/status');
      paintEnv(env);
      if (!env.ok) { setStatus('❌ ' + envProblem(env), 'err'); return; }
      setStatus(prev && opts.auto ? 'Timeline vừa thay đổi — đang cập nhật…' : 'Đang đọc sequence…');
      var r = await RCP.readSequence();
      setStatus('Đang xuất FCP XML…');
      var x = await RCP.exportXml(r.seq);
      var read = {
        seqId: r.info.id, seqName: r.info.name, fp: r.fp, info: r.info, fps: r.fps,
        projectPath: r.info.projectPath, xmlWhy: x.why, warnings: r.warnings.slice(),
        dump: r.dump, xmlPath: x.path, read: null, rows: { source: [], render: [] }, manifest: {},
        notes: [], master: 0, audioTracks: [], noCuts: false
      };
      if (read.xmlWhy) read.warnings.unshift(read.xmlWhy);
      read.master = Number(st.prefs.master[read.seqId] || 0);
      st.read = read;
      // Cùng sequence (vừa sửa timeline) → giữ các clip người dùng đã bỏ tick.
      if (!prev || prev.seqId !== read.seqId) st.unpicked = { source: {}, render: {} };
      await scanHalves();
      await resolveDest();
      paintAll();
      if (read.noCuts) setStatus('Timeline không có cut nào để cắt.', 'warn');
      else setStatus('');
      readOk = !read.noCuts;
      if (prev) flashName();
    } catch (e) {
      var msg = (e && e.message) || String(e);
      if (opts.auto && opts.key) st.watch.failKey = opts.key;   // không đọc lại mãi một trạng thái lỗi
      setStatus(msg, /Đã dừng/.test(msg) ? 'warn' : 'err');
    } finally {
      setBusy(false);
      // Tự cập nhật thành công thì không hiện ✓ (đỡ nhiễu) — chỉ hiện khi đọc tay hoặc lỗi.
      if (readOk && opts.auto) { if (typeof RCPX !== 'undefined') RCPX.hide(); }
      else pixelEnd(readOk, /Đã dừng/.test($('rcStatus').textContent));
    }
  }

  function flashName() {
    var n = $('rcSeqName');
    n.classList.add('rc-flash');
    setTimeout(function () { n.classList.remove('rc-flash'); }, 900);
  }

  // ── Theo dõi sequence: tự đọc khi mở tab, khi đổi sequence, khi timeline bị sửa ──
  // Hỏi Premiere mỗi 2s (chỉ khi tab RAW đang hiện). Timeline sửa → chờ yên 2s rồi đọc lại;
  // đổi sang sequence khác → đọc ngay. Đang Đọc/Xuất/hỏi xác nhận thì không đụng.
  var WATCH_MS = 2000, SETTLE_MS = 2000;
  function tabVisible() { var t = $('tab-rawcut'); return !!t && t.classList.contains('active'); }
  async function watchTick() {
    var w = st.watch;
    if (w.polling || !tabVisible() || st.busy || st.running || st.confirmResolve) return;
    if (typeof RCP === 'undefined') return;
    w.polling = true;
    try {
      var s = await RCP.stamp(true);
      if (!s.ok) {
        $('rcState').textContent = st.read ? 'Không có sequence nào đang mở — đang giữ lần đọc trước' : '';
        if (!st.read) paintGo();
        return;
      }
      if ($('rcState').textContent) $('rcState').textContent = '';
      var key = s.id + '|' + (s.fp || '') + '|' + s.name;
      var have = st.read ? st.read.seqId + '|' + st.read.fp + '|' + st.read.seqName : '';
      if (key === have || key === w.failKey) { w.pendingKey = ''; return; }
      var switched = !st.read || s.id !== st.read.seqId;
      if (key !== w.pendingKey) {
        w.pendingKey = key; w.changedAt = Date.now();
        if (!switched) return;   // sửa timeline: đợi yên rồi mới đọc
      } else if (!switched && Date.now() - w.changedAt < SETTLE_MS) return;
      w.pendingKey = '';
      await onRead({ auto: true, key: key });
    } catch (e) {
    } finally {
      w.polling = false;
    }
  }

  // Quét (manifest-only) các nửa cần cho mode hiện tại, trên CÙNG một lần đọc.
  async function scanHalves() {
    var read = st.read, mode = st.prefs.mode;
    var halves = mode === 'both' ? ['source', 'render'] : [mode];
    read.rows = { source: [], render: [] };
    read.manifest = {};
    read.notes = []; read.noCuts = false;
    for (var i = 0; i < halves.length; i++) {
      var half = halves[i];
      setStatus('Đang đọc cut list ' + (half === 'render' ? 'edited/' : 'raw/') + '… (file Drive chưa tải về sẽ lâu hơn)');
      var body = { sequenceName: read.seqName, half: half, options: scanOptions(half) };
      if (read.read) body.read = read.read;
      else { body.projectPath = read.projectPath; body.dump = read.dump; body.xmlPath = read.xmlPath; }
      var s = await scanCall(body);
      if (!s.ok) throw new Error(s.error || 'Engine không đọc được timeline');
      read.read = s.read;
      if (s.noCuts) { read.noCuts = true; continue; }
      read.manifest[half] = s.manifest;
      read.rows[half] = RCC.rowsFromManifest(s.manifest, half);
      (s.notes || []).concat(s.warnings || []).forEach(function (n) { if (read.notes.indexOf(n) === -1) read.notes.push(n); });
      var set = s.manifest.settings || {};
      if (set.audio_tracks_available) read.audioTracks = set.audio_tracks_available.map(function (t) { return { index: Number(t.index), items: Number(t.items || 0) }; }).filter(function (t) { return t.index > 0; });
      if (half === 'source' || !read.width) { read.width = Number(set.sequence_width || read.info.width || 0); read.height = Number(set.sequence_height || read.info.height || 0); }
    }
    // Master track: track hình thấp nhất có clip (mặc định V1 như bản gốc).
    var vt = RCC.videoTracksPresent(read.rows.render.length ? read.rows.render : read.rows.source);
    if (vt.length && !vt.some(function (t) { return t.index === read.master; })) {
      read.master = vt[0].index;
      if (read.rows.render.length) {
        // Quét lại nửa render đúng master track.
        var s2 = await scanCall({ read: read.read, sequenceName: read.seqName, half: 'render', options: scanOptions('render') });
        if (s2.aborted) throw new Error('Đã dừng đọc.');
        if (s2.ok && !s2.noCuts) { read.manifest.render = s2.manifest; read.rows.render = RCC.rowsFromManifest(s2.manifest, 'render'); }
      }
    }
  }

  // /rawcut/scan có thể Dừng: huỷ request → bridge giết engine.
  async function scanCall(body) {
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    st.scanAbort = ctl;
    try { return await api('POST', '/rawcut/scan', body, ctl ? ctl.signal : null); }
    finally { st.scanAbort = null; }
  }

  async function rescan(msg) {
    if (!st.read || st.busy || st.running) return;
    setBusy(true, 'ĐANG ĐỌC…');
    try { await scanHalves(); await resolveDest(); paintAll(); setStatus(msg || '✓ Đã đọc lại cut list'); }
    catch (e) { setStatus('❌ ' + ((e && e.message) || e), 'err'); }
    finally { setBusy(false); }
  }

  function envProblem(env) {
    var out = [];
    if (env.error) out.push(env.error);
    if (env.python && !env.python.ok) out.push('thiếu python3 ≥ 3.8 (cài: brew install python3)');
    if (env.ffmpeg && !env.ffmpeg.ok) out.push('thiếu ffmpeg (cài: brew install ffmpeg)');
    if (env.engine && !env.engine.exists) out.push('Bridge thiếu engine Raw-cutter — cập nhật Claude Bridge');
    return out.join(' · ') || 'Bridge chưa sẵn sàng';
  }
  function paintEnv(env) {
    var e = $('rcEnv');
    e.textContent = env && env.ok ? '' : envProblem(env || {});
  }

  // ── Thư mục xuất ────────────────────────────────────────────────────────
  async function resolveDest(extra) {
    if (!st.read) return;
    var pk = projectKey();
    var body = Object.assign({
      projectPath: pk, sequenceName: st.read.seqName, sequenceId: st.read.seqId, mode: st.prefs.mode,
      chosen: st.prefs.chosen[pk] || '', productPick: st.prefs.productPick[pk] || ''
    }, extra || {});
    st.dest = await api('POST', '/rawcut/dest', body);
    return st.dest;
  }

  async function onChooseFolder() {
    if (!st.read || st.running) return;
    var f = null;
    try { f = await require('uxp').storage.localFileSystem.getFolder(); } catch (e) {}
    if (!f) return;
    var p = f.nativePath || '';
    var r = await resolveDest({ chosen: p, walk: true });
    if (r && r.ok) {
      st.prefs.chosen[projectKey()] = r.chosen || p;
      savePrefs();
    }
    paintDest();
    paintGo();
  }
  async function onResetFolder() {
    delete st.prefs.chosen[projectKey()];
    savePrefs();
    await resolveDest();
    paintDest(); paintGo();
  }
  async function onProductPick(v) {
    if (v) st.prefs.productPick[projectKey()] = v; else delete st.prefs.productPick[projectKey()];
    savePrefs();
    await resolveDest();
    paintDest(); paintGo();
  }

  function paintDest() {
    var card = $('rcDestCard'), line = $('rcDestLine'), d = st.dest, pick = $('rcProduct');
    card.style.display = st.read ? '' : 'none';
    $('rcResetFolder').style.display = st.prefs.chosen[projectKey()] ? '' : 'none';
    line.innerHTML = '';
    if (!d) { pick.style.display = 'none'; return; }
    var mode = st.prefs.mode;
    if (d.ok) {
      var head = el('div', 'rc-dest-head', (d.product ? d.product.name + ' · ' : '') + d.version + (d.route === 'free' ? ' · thư mục tự chọn' : ''));
      line.appendChild(head);
      if (mode !== 'render') line.appendChild(el('div', 'rc-dest-path', 'raw/ → ' + shortDir(d.dirs.raw)));
      if (mode !== 'source') line.appendChild(el('div', 'rc-dest-path', 'edited/ → ' + shortDir(d.dirs.edited)));
      (d.notes || []).forEach(function (n) { line.appendChild(el('div', 'rc-dest-note', n)); });
    } else {
      line.appendChild(el('div', 'rc-dest-err', (d.why || d.error || 'Chưa xác định được thư mục xuất')));
    }
    var list = (d.candidates && d.candidates.length ? d.candidates : []).concat((d.products || []).filter(function (n) { return !d.candidates || d.candidates.indexOf(n) === -1; }));
    var showPick = list.length && (d.needPick || d.route === 'picked' || d.route === 'matched');
    pick.style.display = showPick ? '' : 'none';
    if (!showPick) { closePicker(); return; }
    var cur = st.prefs.productPick[projectKey()] || '', cands = d.candidates || [];
    var autoName = d.route === 'matched' && d.product ? d.product.name : '';
    st.pickItems = [{ v: '', label: autoName ? 'Tự khớp: ' + autoName : 'Bỏ chọn (tự khớp)' }]
      .concat(list.map(function (n) { return { v: n, label: n, cand: cands.indexOf(n) !== -1 }; }));
    $('rcProductLabel').textContent = cur ? cur : (autoName ? autoName + '  ·  tự khớp' : 'Chọn sản phẩm…');
    if (st.pickOpen) renderPickList();
  }

  // ── Ô chọn sản phẩm có tìm kiếm ──
  function fold(x) {
    var t = String(x || '').toLowerCase().replace(/đ/g, 'd');
    try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
    return t.replace(/[^a-z0-9]/g, '');
  }
  function pickFiltered() {
    var q = fold($('rcProductSearch').value), items = st.pickItems || [];
    if (!q) return items.slice(0, 600);
    return items.filter(function (it) { return it.v && fold(it.label).indexOf(q) !== -1; }).slice(0, 600);
  }
  function renderPickList() {
    var box = $('rcProductList'), cur = st.prefs.productPick[projectKey()] || '';
    box.innerHTML = '';
    var items = pickFiltered();
    if (!items.length) { box.appendChild(el('div', 'rc-pick-empty', 'Không có sản phẩm nào khớp.')); return; }
    items.forEach(function (it) {
      var row = el('div', 'rc-pick-item' + (it.v === cur ? ' is-cur' : ''));
      row.appendChild(el('span', '', it.label));
      if (it.cand && it.v !== cur) row.appendChild(el('span', 'rc-pick-tag', 'gợi ý'));
      row.setAttribute('role', 'button');
      row.addEventListener('click', function () { choosePick(it.v); });
      box.appendChild(row);
    });
  }
  function openPicker() {
    if (st.running) return;
    st.pickOpen = true;
    $('rcProductPanel').style.display = '';
    $('rcProductCaret').textContent = '▴';
    $('rcProductSearch').value = '';
    renderPickList();
    try { $('rcProductSearch').focus(); } catch (e) {}
  }
  function closePicker() {
    st.pickOpen = false;
    $('rcProductPanel').style.display = 'none';
    $('rcProductCaret').textContent = '▾';
  }
  function choosePick(v) {
    closePicker();
    if (v === (st.prefs.productPick[projectKey()] || '')) return;
    onProductPick(v);
  }

  // ── Danh sách clip ──────────────────────────────────────────────────────
  function rowsOf(half) { return (st.read && st.read.rows[half]) || []; }
  function typesOn() {
    var on = {};
    RCC.typeList(rowsOf('source'), st.prefs.types).forEach(function (t) { on[t.ext] = t.on; });
    return on;
  }
  function vSig() { return RCC.videoTracksPresent(rowsOf('render')).map(function (t) { return t.index; }).join(','); }
  function aSig() { return (st.read ? st.read.audioTracks : []).map(function (t) { return t.index; }).join(','); }
  function includeList() {
    var have = RCC.videoTracksPresent(rowsOf('render')).map(function (t) { return t.index; });
    var saved = st.prefs.vinc[vSig()];
    var list = Array.isArray(saved) ? saved.filter(function (n) { return have.indexOf(n) !== -1; }) : have.slice();
    if (st.read && st.read.master && list.indexOf(st.read.master) === -1) list.push(st.read.master);
    return list.sort(function (a, b) { return a - b; });
  }
  function hearList() {
    var have = (st.read ? st.read.audioTracks : []).map(function (t) { return t.index; });
    var saved = st.prefs.hear[projectKey() + '|' + aSig()];
    return Array.isArray(saved) ? saved.filter(function (n) { return have.indexOf(n) !== -1; }) : have.slice();
  }
  function pickedFor(half) {
    return RCC.pickRows(rowsOf(half), {
      half: half, typesOn: typesOn(), unpicked: st.unpicked[half],
      master: st.read ? st.read.master : 0
    });
  }
  function halvesOfMode() { return st.prefs.mode === 'both' ? ['source', 'render'] : [st.prefs.mode]; }

  function paintClips() {
    var card = $('rcClipsCard');
    var has = !!st.read && (rowsOf('source').length || rowsOf('render').length);
    card.style.display = has ? '' : 'none';
    if (!has) return;
    var mode = st.prefs.mode;
    if (mode !== 'both') st.view = mode;
    // Chuyển raw/ ↔ edited/ khi Both
    var tabs = $('rcViewTabs');
    tabs.innerHTML = '';
    tabs.style.display = mode === 'both' ? '' : 'none';
    if (mode === 'both') {
      ['source', 'render'].forEach(function (h) {
        var b = el('div', 'rsz-seg' + (st.view === h ? ' active' : ''), (h === 'source' ? 'raw/' : 'edited/') + ' · ' + pickedFor(h).length);
        b.setAttribute('role', 'button');
        b.addEventListener('click', function () { st.view = h; paintClips(); });
        tabs.appendChild(b);
      });
    }
    var half = st.view, rows = rowsOf(half);
    // Chip loại file (chỉ Source)
    var chips = $('rcTypes');
    chips.innerHTML = '';
    chips.style.display = half === 'source' ? '' : 'none';
    if (half === 'source') {
      var tl = RCC.typesWithFallback(RCC.typeList(rows, st.prefs.types));
      tl.list.forEach(function (t) {
        var c = el('div', 'rsz-chip' + (t.on ? ' on' : '') + (t.n ? '' : ' rc-chip-zero'), '.' + t.ext + ' ' + t.n);
        c.setAttribute('role', 'button');
        c.addEventListener('click', function () { st.prefs.types[t.ext] = !t.on; savePrefs(); paintClips(); paintGo(); });
        chips.appendChild(c);
      });
      if (tl.reset) { tl.list.forEach(function (t) { st.prefs.types[t.ext] = t.on; }); savePrefs(); }
    }
    var picked = pickedFor(half), pickedKey = {};
    picked.forEach(function (r) { pickedKey[r.key] = true; });
    var cuttable = rows.filter(function (r) {
      return r.cuttable && !(half === 'render' && r.trackType === 'video' && st.read.master && r.trackIndex !== st.read.master);
    });
    $('rcClipCount').textContent = picked.length + '/' + cuttable.length + ' clip';
    var list = $('rcList');
    list.innerHTML = '';
    var dead = 0;
    rows.forEach(function (r, i) {
      // Timeline Render chỉ render master track — clip hình ở track khác nằm trong khung đó.
      if (half === 'render' && r.trackType === 'video' && st.read.master && r.trackIndex !== st.read.master) return;
      if (!r.cuttable) { dead++; if (!st.showDead) return; }
      var on = !!pickedKey[r.key];
      var row = el('div', 'rc-row' + (r.cuttable ? '' : ' is-dead') + (r.kind === 'bad' ? ' is-bad' : (r.kind === 'warn' ? ' is-warn' : '')));
      var tick = el('div', 'rc-tick' + (on ? ' on' : ''), on ? '✓' : '');
      row.appendChild(tick);
      var main = el('div', 'rc-row-main');
      var title = el('div', 'rc-row-title');
      title.appendChild(el('span', 'rc-row-idx', String(r.tlIndex || i + 1)));
      title.appendChild(document.createTextNode((r.trackType === 'audio' ? 'A' : 'V') + r.trackIndex + ' · ' + (r.clip || base(r.source) || '—')));
      main.appendChild(title);
      var sub = [r.tc, r.speed, r.status].filter(Boolean).join(' · ');
      if (r.notes) sub += ' · ' + r.notes;
      main.appendChild(el('div', 'rc-row-sub', sub));
      row.appendChild(main);
      if (r.cuttable) {
        row.setAttribute('role', 'button');
        row.addEventListener('click', function () {
          if (st.running) return;
          if (st.unpicked[half][r.key]) delete st.unpicked[half][r.key]; else st.unpicked[half][r.key] = true;
          paintClips(); paintGo();
        });
      }
      list.appendChild(row);
    });
    var sd = $('rcShowDead');
    sd.style.display = dead ? '' : 'none';
    sd.textContent = (st.showDead ? 'Ẩn ' : 'Hiện ') + dead + ' clip không cắt được';
    $('rcAllToggle').textContent = picked.length ? 'Bỏ chọn hết' : 'Chọn hết';
  }

  function onAllToggle() {
    var half = st.view;
    var rows = pickedFor(half).length ? pickedFor(half) : [];
    st.unpicked[half] = {};
    if (rows.length) rows.forEach(function (r) { st.unpicked[half][r.key] = true; });
    paintClips(); paintGo();
  }

  // ── Timeline Render + Audio ─────────────────────────────────────────────
  function chipRow(container, items, isOn, onToggle) {
    container.innerHTML = '';
    items.forEach(function (it) {
      var c = el('div', 'rsz-chip' + (isOn(it) ? ' on' : ''), it.label);
      c.setAttribute('role', 'button');
      c.addEventListener('click', function () { if (!st.running) onToggle(it); });
      container.appendChild(c);
    });
  }

  function paintRender() {
    var show = !!st.read && st.prefs.mode !== 'source' && rowsOf('render').length;
    $('rcRenderCard').style.display = show ? '' : 'none';
    if (!show) return;
    var vt = RCC.videoTracksPresent(rowsOf('render'));
    chipRow($('rcMaster'), vt.map(function (t) { return { n: t.index, label: 'V' + t.index + ' · ' + t.items + ' clip' }; }),
      function (it) { return it.n === st.read.master; },
      function (it) { onMaster(it.n); });
    var inc = includeList();
    chipRow($('rcVTracks'), vt.map(function (t) { return { n: t.index, label: 'V' + t.index }; }),
      function (it) { return inc.indexOf(it.n) !== -1; },
      function (it) {
        if (it.n === st.read.master) { setStatus('Master track luôn có trong bản render.'); return; }
        var cur = includeList(), i = cur.indexOf(it.n);
        if (i === -1) cur.push(it.n); else cur.splice(i, 1);
        st.prefs.vinc[vSig()] = cur; savePrefs(); paintRender();
      });
  }

  async function onMaster(v) {
    v = Number(v || 0);
    if (st.running || st.busy) return;
    if (!st.read || !v || v === st.read.master) return;
    st.read.master = v;
    st.prefs.master[st.read.seqId] = v; savePrefs();
    st.unpicked.render = {};
    await rescan('✓ Đã đọc lại theo master V' + v);
  }

  function paintAudio() {
    var tracks = st.read ? st.read.audioTracks : [];
    $('rcAudioCard').style.display = st.read && tracks.length ? '' : 'none';
    if (!st.read) return;
    $('rcAudioMix').classList.toggle('on', st.prefs.audioMix);
    var items = tracks.map(function (t) { return { n: t.index, label: 'A' + t.index + (t.items ? '' : ' (trống)') }; });
    chipRow($('rcAudioPer'), items, function (it) { return st.prefs.audioPer.indexOf(it.n) !== -1; }, function (it) {
      var i = st.prefs.audioPer.indexOf(it.n);
      if (i === -1) st.prefs.audioPer.push(it.n); else st.prefs.audioPer.splice(i, 1);
      savePrefs(); paintAudio();
    });
    var showHear = st.prefs.mode !== 'source';
    $('rcHearWrap').style.display = showHear ? '' : 'none';
    if (showHear) {
      var hear = hearList();
      chipRow($('rcAudioHear'), items, function (it) { return hear.indexOf(it.n) !== -1; }, function (it) {
        var cur = hearList(), i = cur.indexOf(it.n);
        if (i === -1) cur.push(it.n); else cur.splice(i, 1);
        st.prefs.hear[projectKey() + '|' + aSig()] = cur; savePrefs(); paintAudio();
      });
    }
  }

  // ── Chất lượng ──────────────────────────────────────────────────────────
  function paintQuality() {
    $('rcMoreSum').textContent = 'CRF ' + st.prefs.crf + ' · ' + st.prefs.scale + '%' + (st.prefs.fps ? ' · ' + st.prefs.fps + ' fps' : '');
    $('rcCrfVal').textContent = String(st.prefs.crf);
    chipRow($('rcScale'), SCALES.map(function (x) { return { n: x, label: x + '%' }; }),
      function (it) { return it.n === st.prefs.scale; },
      function (it) { st.prefs.scale = it.n; savePrefs(); paintQuality(); });
    $('rcFps').value = st.prefs.fps;
    $('rcTrans').classList.toggle('on', st.prefs.transitions);
    $('rcResume').classList.toggle('on', st.prefs.resume);
    var fpsNote = $('rcFpsNote');
    fpsNote.textContent = st.prefs.fps ? 'Ép frame rate làm clip KHÔNG còn đúng từng frame của timeline.' : '';
    var names = Object.keys(st.presets).sort();
    chipRow($('rcPreset'), names.map(function (n) { return { n: n, label: n }; }), function () { return false; },
      function (it) { onPresetPick(it.n); });
    if (!names.length) $('rcPreset').appendChild(el('div', 'rc-pick-empty', 'Chưa có preset — đặt tên bên dưới rồi Lưu.'));
  }
  function stepCrf(d) {
    var v = Math.round((st.prefs.crf + d) * 2) / 2;
    st.prefs.crf = v < 1 ? 1 : (v > 35 ? 35 : v);
    savePrefs(); paintQuality(); paintGo();
  }
  async function loadPresets() {
    var r = await api('POST', '/rawcut/presets', { action: 'list' });
    if (r && r.presets) st.presets = r.presets;
    paintQuality();
  }
  function onPresetPick(name) {
    var p = st.presets[name];
    if (!p) return;
    $('rcPresetName').value = name;
    if (p.crf != null) st.prefs.crf = Number(p.crf);
    if (p.scale != null) st.prefs.scale = SCALES.indexOf(Number(p.scale)) !== -1 ? Number(p.scale) : 100;
    st.prefs.fps = p.fps ? String(p.fps) : '';
    savePrefs(); paintQuality(); paintGo();
  }
  async function onPresetSave() {
    var name = String($('rcPresetName').value || '').trim();
    if (!name) { setStatus('Gõ tên preset trước khi Lưu.', 'warn'); return; }
    var r = await api('POST', '/rawcut/presets', { action: 'save', name: name, crf: st.prefs.crf, scale: st.prefs.scale, fps: st.prefs.fps || null });
    if (r.ok) { st.presets = r.presets || st.presets; $('rcPresetName').value = ''; setStatus('✓ Đã lưu preset "' + name + '"'); }
    else setStatus('❌ ' + (r.error || 'Không lưu được preset'), 'err');
    paintQuality();
  }
  async function onPresetDelete() {
    var name = String($('rcPresetName').value || '').trim();
    if (!name || !st.presets[name]) { setStatus('Gõ đúng tên preset cần xoá.', 'warn'); return; }
    var r = await api('POST', '/rawcut/presets', { action: 'delete', name: name });
    if (r.ok) { st.presets = r.presets || {}; setStatus('✓ Đã xoá preset "' + name + '"'); }
    else setStatus('❌ ' + (r.error || 'Không xoá được preset'), 'err');
    paintQuality();
  }

  // ── Nút Xuất ────────────────────────────────────────────────────────────
  function paintGo(label) {
    var go = $('rcGo');
    var n = 0, halves = halvesOfMode();
    if (st.read) halves.forEach(function (h) { n += pickedFor(h).length; });
    var ready = !!st.read && st.dest && st.dest.ok && n > 0;
    go.classList.toggle('is-busy', st.busy || st.running || !ready);
    $('rcGoLabel').textContent = label || (st.running ? 'ĐANG XUẤT…' : (!st.read ? (st.busy ? 'ĐANG ĐỌC…' : 'MỞ MỘT SEQUENCE') : (n ? 'XUẤT ' + n + ' CLIP' : 'CHƯA CHỌN CLIP')));
    var sub = MODES[st.prefs.mode] + (st.prefs.mode === 'both' ? ' · raw/ rồi edited/' : '');
    if (st.read && !st.busy && !st.running && st.dest && !st.dest.ok) sub = 'Chưa có thư mục xuất — xem mục Thư mục xuất';
    $('rcGoSub').textContent = sub;
    $('rcCancel').style.display = (st.running || st.busy) ? '' : 'none';
  }

  function paintModes() {
    document.querySelectorAll('#rcModes .rsz-seg').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-mode') === st.prefs.mode);
    });
  }

  function paintSeq() {
    var r = st.read;
    $('rcDot').className = 'wf-dot ' + (r ? 'ok' : 'err');
    var name = $('rcSeqName');
    name.textContent = r ? r.seqName : 'Mở một sequence trong Premiere';
    name.classList.toggle('is-empty', !r);
    $('rcDetailToggle').style.display = r ? '' : 'none';
    var meta = $('rcSeqMeta');
    meta.textContent = r ? [(r.width || r.info.width) + '×' + (r.height || r.info.height), (r.fps ? r.fps.toFixed(3).replace(/\.?0+$/, '') : '?') + ' fps', r.read && r.read.xml ? 'XML ✓' : 'không có XML'].join(' · ') : '';
    var notes = $('rcNotes');
    notes.innerHTML = '';
    if (r) (r.warnings.concat(r.notes)).slice(0, 6).forEach(function (n) { notes.appendChild(el('div', 'rc-note', '• ' + n)); });
  }

  function paintAll() {
    paintModes(); paintSeq(); paintDest(); paintClips(); paintRender(); paintAudio(); paintQuality(); paintGo();
  }

  // ── Hỏi lại trước khi xuất (thay hộp thoại: UXP không có z-index) ─────────
  function askConfirm(msg, yesLabel) {
    $('rcConfirmMsg').textContent = msg;
    $('rcConfirmYes').textContent = yesLabel || 'Vẫn xuất';
    $('rcConfirm').style.display = '';
    return new Promise(function (resolve) { st.confirmResolve = resolve; });
  }
  function answerConfirm(v) {
    $('rcConfirm').style.display = 'none';
    var f = st.confirmResolve; st.confirmResolve = null;
    if (f) f(v);
  }

  // ── Xuất ────────────────────────────────────────────────────────────────
  function exportOptions(half) {
    var p = st.prefs, o = scanOptions(half);
    if (p.audioMix) o.audio = true;
    var per = p.audioPer.filter(function (n) { return st.read.audioTracks.some(function (t) { return t.index === n; }); });
    if (per.length) { o.audioPerTrack = true; o.audioTracks = per.slice().sort(function (a, b) { return a - b; }); }
    if (half === 'source') {
      var on = typesOn(), ext = [];
      for (var k in on) if (on[k] && k !== '(none)') ext.push(k);
      o.ext = ext;
    }
    if (half === 'render' && hearList().length) o.renderAudio = true;
    if (p.resume) o.resume = true;
    return o;
  }

  async function guardSequence(needRender) {
    var s = await RCP.stamp(true);
    var r = st.read;
    if (!s.ok) {
      if (needRender) return { ok: false, why: 'Không có sequence nào đang mở — mở lại "' + r.seqName + '" rồi Xuất.' };
      return { ok: true };
    }
    if (s.id !== r.seqId) {
      if (needRender) return { ok: false, why: 'Đang mở sequence khác ("' + s.name + '") — Timeline Render cần đúng sequence đã Đọc ("' + r.seqName + '"). Mở lại nó rồi Xuất.' };
      var y = await askConfirm('Đang mở "' + s.name + '", khác sequence đã Đọc ("' + r.seqName + '"). Xuất theo bản đã Đọc?');
      return y ? { ok: true } : { ok: false, why: 'Đã huỷ.' };
    }
    if (s.name !== r.seqName) {
      var v0 = (st.dest && st.dest.version) || '';
      var d2 = await api('POST', '/rawcut/dest', { projectPath: projectKey(), sequenceName: s.name, sequenceId: s.id, mode: st.prefs.mode, chosen: st.prefs.chosen[projectKey()] || '', productPick: st.prefs.productPick[projectKey()] || '' });
      if (!d2.ok || d2.version !== v0) return { ok: false, why: 'Sequence đã đổi tên ("' + s.name + '") sau lần Đọc — version có thể đã đổi. Bấm Đọc timeline lại.' };
    }
    if (s.fp && r.fp && s.fp !== r.fp) {
      var y2 = await askConfirm('Timeline đã bị sửa sau lần Đọc. Xuất vẫn theo bản đã Đọc (nên Đọc lại trước).', 'Vẫn xuất');
      if (!y2) return { ok: false, why: 'Đã huỷ — bấm Đọc timeline lại để lấy bản mới.' };
      return { ok: true, consentFp: s.fp };
    }
    return { ok: true, consentFp: r.fp };
  }

  async function onGo(retry) {
    if (st.busy || st.running || st.confirmResolve) return;
    if (!st.read) { setStatus('Bấm Đọc timeline trước.', 'warn'); return; }
    var halves = retry ? Object.keys(retry) : halvesOfMode();
    var picked = {};
    halves.forEach(function (h) { picked[h] = pickedFor(h); });
    if (!halves.some(function (h) { return picked[h].length; })) { setStatus('Chưa chọn clip nào.', 'warn'); return; }
    // Khoá NGAY (trước mọi await): bấm Xuất 2 lần không được chạy 2 lượt song song —
    // hai lượt render đan nhau sẽ ghi nhận sai mute/in-out ban đầu và để timeline hỏng.
    st.running = true; st.stop = false;
    paintGo();
    var g;
    try {
      st.dest = await resolveDest();   // hỏi đĩa lại: có thể vừa có người xuất cùng version
      paintDest();
      if (!st.dest || !st.dest.ok) { setStatus('⛔ ' + ((st.dest && (st.dest.why || st.dest.error)) || 'Chưa có thư mục xuất'), 'err'); st.running = false; paintGo(); return; }
      g = await guardSequence(halves.indexOf('render') !== -1);
    } catch (e) { g = { ok: false, why: (e && e.message) || String(e) }; }
    if (!g.ok) { setStatus('⛔ ' + g.why, 'err'); st.running = false; paintGo(); return; }

    hideReport();
    paintGo();
    var results = [];
    var dest = st.dest;
    try {
      for (var i = 0; i < halves.length; i++) {
        if (st.stop) break;
        var h = halves[i];
        var prefix = (halves.length > 1 ? '(' + (i + 1) + '/' + halves.length + ') ' : '') + HALF_LABEL[h];
        var res = (h === 'source')
          ? await exportHalf('source', dest.dirs.raw, picked.source, null, prefix, !!retry)
          : await renderHalf(dest.dirs.edited, picked.render, prefix, retry ? retry.render : null, g.consentFp);
        results.push(res);
      }
    } catch (e) {
      results.push({ half: '?', error: (e && e.message) || String(e), errors: [] });
    } finally {
      st.running = false;
      showProgress(false);
      paintGo();
    }
    st.last = { results: results, dest: dest, halves: halves };
    paintReport(results);
    pixelEnd(results.length && results.every(function (r) { return r.skipped || (!r.error && !r.failed); }),
             results.some(function (r) { return r.cancelled; }));
    var bad = results.some(function (r) { return r.error || r.failed > 0 || r.cancelled; });
    try { api('POST', '/notify', { title: 'Raw-cutter', body: bad ? 'Xuất xong — có clip lỗi' : 'Xuất xong — ' + results.map(function (r) { return r.ok + ' clip ' + (r.half === 'render' ? 'edited/' : 'raw/'); }).join(', ') }); } catch (e) {}
  }

  // Một lượt engine (SSE) vào outDir.
  async function exportHalf(half, outDir, picked, renderDir, prefix, isRetry) {
    var res = { half: half, dir: outDir, ok: 0, failed: 0, total: picked.length, errors: [] };
    if (!picked.length) { res.skipped = true; return res; }
    if (st.stop) { res.cancelled = true; res.error = 'Đã dừng — chưa cắt gì.'; return res; }
    pixel('cut');
    var opts = exportOptions(half);
    if (isRetry) opts.resume = true;
    var body = {
      read: st.read.read, sequenceName: st.read.seqName, out: outDir, options: opts,
      pick: RCC.pickKeys(rowsOf(half), picked)
    };
    if (renderDir) body.renderDir = renderDir;
    var done = 0, cur = '', lastFail = false;
    showProgress(true, prefix + ' · chuẩn bị…', 0);
    var r = await sse('/rawcut/export', body, function (ev) {
      if (ev.type !== 'event') return;
      var e = ev.ev;
      if (e.type === 'start') cur = e.file;
      else if (e.type === 'done') {
        done = e.n;
        // SKIP/SLNT/DRY = dòng không cắt được, đã có trong tóm tắt — chỉ liệt kê lỗi thật.
        // MISS của dòng không chọn (gửi kèm để giữ cảnh báo) không phải lỗi lượt này — chỉ FAIL/BAD/NORE
        // luôn là lỗi; MISS chỉ tính khi đã có trong tóm tắt clip chọn (xem dưới).
        lastFail = !e.ok && !!REAL_FAIL[e.flag] && e.flag !== 'MISS';
        if (lastFail) res.errors.push(e.flag + ' ' + e.file);
        showProgress(true, prefix + ' · ' + e.n + '/' + e.total + ' · ' + e.file, e.total ? e.n / e.total : 0);
        return;
      } else if (e.type === 'reason') { if (lastFail && res.errors.length) res.errors[res.errors.length - 1] += ' — ' + e.text; return; }
      else if (e.type === 'encoding') cur = 'bắt đầu cắt';
      showProgress(true, prefix + ' · ' + done + '/' + picked.length + (cur ? ' · ' + cur : ''), picked.length ? done / picked.length : 0);
    });
    var end = r.end;
    if (r.error) { res.error = r.error; return res; }
    if (r.aborted || (end && end.cancelled)) { res.cancelled = true; res.error = 'Đã dừng — clip đang cắt dở bị bỏ, manifest không ghi.'; return res; }
    if (!end) { res.error = 'Bridge ngắt giữa chừng'; return res; }
    if (end.lock) { res.error = 'Thư mục đang có lượt xuất khác ghi vào: ' + end.lock; return res; }
    if (end.spawnError) { res.error = 'Không chạy được engine: ' + end.spawnError; return res; }
    res.manifest = end.manifest;
    if (end.manifest) {
      var s = RCC.summarize(end.manifest);
      // Chỉ tính lỗi trên clip ĐÃ CHỌN — dòng không cắt được gửi kèm --pick (để manifest giữ cảnh
      // báo) cũng ra missing_source/unsupported nhưng không phải lỗi của lượt này.
      var mine = {};
      picked.forEach(function (r) { mine[r.key] = true; });
      var fk = RCC.failedKeys(end.manifest) || {}, mineFk = null, nMissing = 0;
      Object.keys(fk).forEach(function (k) {
        if (!mine[k]) return;
        (mineFk = mineFk || {})[k] = fk[k];
        if (fk[k] === 'missing_source') nMissing++;
      });
      res.ok = s.ok + s.skipped; res.failed = s.failed + s.noRender + s.mismatch + nMissing; res.summary = s;
      res.failedKeys = mineFk;
      if (nMissing) RCC.rowsFromManifest(end.manifest, half).forEach(function (r) {
        if (mineFk && mineFk[r.key] === 'missing_source') res.errors.push('MISS ' + (r.outputFile || r.clip) + ' — không thấy file nguồn: ' + r.source);
      });
    }
    if (end.code !== 0 && !res.failed) res.error = 'Engine thoát mã ' + end.code + (end.tail ? ': ' + end.tail : '');
    return res;
  }

  // Nửa Timeline Render: Premiere render từng cut vào cache → engine cắt edited/ từ đó.
  async function renderHalf(outDir, picked, prefix, retryKeys, consentFp) {
    var res = { half: 'render', dir: outDir, ok: 0, failed: 0, total: picked.length, errors: [] };
    if (!picked.length) { res.skipped = true; return res; }
    var cache = await api('POST', '/rawcut/render-cache', { out: outDir });
    if (!cache.ok) { res.error = cache.error; return res; }
    if (cache.freeBytes < MIN_FREE_BYTES) { res.error = 'Ổ chứa cache render còn dưới 2 GB — dọn bớt rồi thử lại.'; return res; }
    var kept = {};
    (cache.files || []).forEach(function (f) { kept[f.replace(/\.[^.]+$/, '')] = true; });
    var rr = RCC.renderRanges(picked, st.read.master, retryKeys, kept);
    var w = st.read.width || st.read.info.width, hgt = st.read.height || st.read.info.height;
    var preset = await api('POST', '/rawcut/render-preset', { dir: cache.dir, mbps: RCC.renderMbps(st.prefs.crf, w, hgt, st.read.fps) });
    if (!preset.ok) { res.error = preset.error; return res; }
    if (preset.warning) res.errors.push('⚠ ' + preset.warning);
    if (rr.ranges.length) {
      showProgress(true, prefix + ' · Premiere render 0/' + rr.ranges.length, 0);
      pixel('render');
      var rend = await RCP.renderRanges({
        ranges: rr.ranges, dir: cache.dir, preset: preset.path, stockPreset: preset.stockPath,
        keepVideo: includeList(), keepAudio: hearList(), offeredAudio: st.read.audioTracks.map(function (t) { return t.index; }),
        expect: { id: st.read.seqId, fp: consentFp || st.read.fp },
        onProgress: function (d, t, label) { showProgress(true, prefix + ' · Premiere render ' + d + '/' + t + (label ? ' · ' + label : ''), t ? d / t : 0); },
        shouldStop: function () { return st.stop; }
      });
      res.render = rend;
      (rend.warnings || []).forEach(function (x) { res.errors.push('⚠ ' + x); });
      rend.renders.filter(function (x) { return !x.ok; }).forEach(function (x) { res.errors.push('Render lỗi ' + x.label + ': ' + x.error); });
      if (rend.stopped) { res.cancelled = true; res.error = 'Đã dừng sau ' + rend.written + '/' + rr.ranges.length + ' bản render — chưa cắt gì vào edited/.'; return res; }
      // Hỏng giữa chừng (in/out không vào, không render được cut nào) → không cắt edited/ dở dang.
      if (rend.refused || rend.error || !rend.ok) { res.error = (rend.error || 'Premiere không render được cut nào') + ' — chưa cắt gì vào edited/.'; return res; }
    }
    var out = await exportHalf('render', outDir, picked, cache.dir, prefix, !!retryKeys);
    out.errors = res.errors.concat(out.errors);
    out.render = res.render;
    out.renderDir = cache.dir;
    var clean = !out.error && !out.failed && out.manifest && Number((out.manifest.settings || {}).renders_missing || 0) === 0;
    if (clean) await api('POST', '/rawcut/render-cache/clean', { dir: cache.dir });
    return out;
  }

  function onCancel() {
    if (st.scanAbort) { try { st.scanAbort.abort(); } catch (e) {} setStatus('⏳ Đang dừng đọc…'); return; }
    if (!st.running) return;
    st.stop = true;
    if (st.confirmResolve) answerConfirm(false);
    if (st.xhr) { try { st.xhr.__rcAborted = true; st.xhr.abort(); } catch (e) {} }
    setStatus('⏳ Đang dừng…');
  }

  // ── Tiến độ + báo cáo ───────────────────────────────────────────────────
  function showProgress(on, text, frac) {
    $('rcProgress').style.display = on ? '' : 'none';
    if (!on) return;
    $('rcBar').style.display = '';
    $('rcProgText').textContent = text || '';
    $('rcBarFill').style.width = Math.round(Math.max(0, Math.min(1, frac || 0)) * 100) + '%';
  }
  function hideReport() { $('rcReport').innerHTML = ''; $('rcActions').style.display = 'none'; }

  function paintReport(results) {
    var box = $('rcReport');
    box.innerHTML = '';
    var anyFailed = false, retry = {};
    results.forEach(function (r) {
      if (r.skipped) return;
      var row = el('div', 'rsz-row' + (r.error || r.failed ? ' is-err' : ''));
      var head = el('div', 'rsz-row-head');
      head.appendChild(el('div', 'rsz-row-title', r.half === 'render' ? 'edited/ — Timeline Render' : (r.half === 'source' ? 'raw/ — Source Render' : 'Lỗi')));
      head.appendChild(el('div', 'rsz-row-badge', r.error ? (r.cancelled ? 'DỪNG' : 'LỖI') : (r.ok + ' ✓' + (r.failed ? ' · ' + r.failed + ' lỗi' : ''))));
      row.appendChild(head);
      var lines = [];
      if (r.error) lines.push(r.error);
      if (r.summary) {
        var s = r.summary, bits = [], tl = [];
        if (s.skipped) bits.push(s.skipped + ' giữ nguyên');
        if (s.missing) tl.push(s.missing + ' thiếu file nguồn');
        if (s.unsupported) tl.push(s.unsupported + ' không cắt được');
        if (tl.length) bits.push('trên timeline: ' + tl.join(', '));
        if (s.noRender) bits.push(s.noRender + ' thiếu bản render');
        if (s.mismatch) bits.push(s.mismatch + ' render lệch độ dài');
        if (bits.length) lines.push(bits.join(' · '));
      }
      if (r.dir) lines.push('→ ' + shortDir(r.dir));
      row.appendChild(el('div', 'rsz-row-sub', lines.join('\n')));
      r.errors.slice(0, 8).forEach(function (x) { row.appendChild(el('div', 'rc-row-err', x)); });
      if (r.errors.length > 8) row.appendChild(el('div', 'rc-row-err', '… còn ' + (r.errors.length - 8) + ' dòng — xem clips.csv / report/bridge-log.txt'));
      box.appendChild(row);
      if (r.failedKeys && (r.half === 'source' || r.half === 'render')) { retry[r.half] = r.half === 'render' ? r.failedKeys : true; anyFailed = true; }
    });
    var acts = $('rcActions');
    acts.style.display = results.length ? '' : 'none';
    $('rcOpenRaw').style.display = results.some(function (r) { return r.half === 'source' && !r.skipped; }) ? '' : 'none';
    $('rcOpenEdited').style.display = results.some(function (r) { return r.half === 'render' && !r.skipped; }) ? '' : 'none';
    $('rcRetry').style.display = anyFailed ? '' : 'none';
    st.retry = anyFailed ? retry : null;
    var allOk = results.length && results.every(function (r) { return r.skipped || (!r.error && !r.failed); });
    setStatus(allOk ? '' : 'Xuất xong nhưng có lỗi — xem báo cáo.', allOk ? '' : 'warn');
  }

  // ── Khởi động ───────────────────────────────────────────────────────────
  function bindKeyboard(id) {
    var e = $(id);
    if (!e) return;
    e.addEventListener('focus', function () { if (window.claimKeyboard) window.claimKeyboard(); });
    e.addEventListener('blur', function () { if (window.releaseKeyboard) window.releaseKeyboard(); });
  }

  function init() {
    if (!$('tab-rawcut') || typeof RCC === 'undefined') return;
    st.prefs = loadPrefs();
    $('rcRead').addEventListener('click', function () { onRead(); });
    // Chi tiết / Thêm cài đặt: luôn thu gọn khi mở plugin (không nhớ).
    function collapser(btnId, bodyId, label, titleId) {
      $(btnId).addEventListener('click', function () {
        var b = $(bodyId), open = b.style.display === 'none';
        b.style.display = open ? '' : 'none';
        $(titleId || btnId).textContent = (open ? '▾ ' : '▸ ') + label;
      });
    }
    collapser('rcDetailToggle', 'rcDetail', 'Chi tiết');
    collapser('rcMoreToggle', 'rcMoreBody', 'THÊM CÀI ĐẶT', 'rcMoreTitle');
    document.querySelectorAll('#rcModes .rsz-seg').forEach(function (b) {
      b.addEventListener('click', async function () {
        if (st.running || st.busy) return;
        var m = b.getAttribute('data-mode');
        if (m === st.prefs.mode) return;
        st.prefs.mode = m; savePrefs();
        paintModes(); paintGo();
        if (st.read) await rescan('✓ Đã đọc lại cho ' + MODES[m]);
      });
    });
    $('rcChooseFolder').addEventListener('click', onChooseFolder);
    $('rcResetFolder').addEventListener('click', onResetFolder);
    $('rcProductBtn').addEventListener('click', function () { if (st.pickOpen) closePicker(); else openPicker(); });
    $('rcProductSearch').addEventListener('input', renderPickList);
    $('rcProductSearch').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closePicker(); return; }
      if (e.key === 'Enter') { var f = pickFiltered().filter(function (it) { return it.v; })[0]; if (f) choosePick(f.v); }
    });
    bindKeyboard('rcProductSearch');
    $('rcAllToggle').addEventListener('click', onAllToggle);
    $('rcShowDead').addEventListener('click', function () { st.showDead = !st.showDead; paintClips(); });
    $('rcAudioMix').addEventListener('click', function () { st.prefs.audioMix = !st.prefs.audioMix; savePrefs(); paintAudio(); });
    $('rcCrfMinus').addEventListener('click', function () { stepCrf(-0.5); });
    $('rcCrfPlus').addEventListener('click', function () { stepCrf(0.5); });
    FPS_LIST.forEach(function (f) { var o = el('option', '', f ? f + ' fps' : 'Theo nguồn'); o.value = f; $('rcFps').appendChild(o); });
    $('rcFps').addEventListener('change', function () { st.prefs.fps = $('rcFps').value; savePrefs(); paintQuality(); });
    // <select> của UXP đổi giá trị khi lăn chuột ngang qua → chặn lăn trên ô fps.
    $('rcFps').addEventListener('wheel', function (e) { e.preventDefault(); e.stopPropagation(); }, { passive: false });
    $('rcTrans').addEventListener('click', function () { st.prefs.transitions = !st.prefs.transitions; savePrefs(); paintQuality(); });
    $('rcResume').addEventListener('click', function () { st.prefs.resume = !st.prefs.resume; savePrefs(); paintQuality(); });
    $('rcPresetSave').addEventListener('click', onPresetSave);
    $('rcPresetDel').addEventListener('click', onPresetDelete);
    bindKeyboard('rcPresetName');
    $('rcGo').addEventListener('click', function () { onGo(null); });
    $('rcCancel').addEventListener('click', onCancel);
    $('rcConfirmYes').addEventListener('click', function () { answerConfirm(true); });
    $('rcConfirmNo').addEventListener('click', function () { answerConfirm(false); });
    $('rcOpenRaw').addEventListener('click', function () { if (st.last) api('POST', '/rawcut/open', { dir: st.last.dest.dirs.raw }); });
    $('rcOpenEdited').addEventListener('click', function () { if (st.last) api('POST', '/rawcut/open', { dir: st.last.dest.dirs.edited }); });
    $('rcRetry').addEventListener('click', function () { if (st.retry) onGo(st.retry); });
    $('rcDiagToggle').addEventListener('click', function () {
      var b = $('rcDiagBody'), open = b.style.display === 'none';
      b.style.display = open ? '' : 'none';
      $('rcDiagToggle').textContent = (open ? '▾' : '▸') + ' Dò lỗi';
    });
    $('rcDiagBtn').addEventListener('click', async function () {
      $('rcDiagOut').value = '⏳ Đang dò…';
      var env = await api('GET', '/rawcut/status');
      var txt = await RCP.diag();
      $('rcDiagOut').value = 'Bridge: ' + JSON.stringify({ ok: env.ok, python: env.python && env.python.bin + ' ' + env.python.version, ffmpeg: env.ffmpeg && env.ffmpeg.ok, engine: env.engine && env.engine.version }) + '\n' + txt;
    });
    bindKeyboard('rcDiagOut');
    var tabBtn = document.querySelector('.tab-btn[data-tab="rawcut"]');
    if (tabBtn) tabBtn.addEventListener('click', function () {
      if (!Object.keys(st.presets).length) loadPresets();
      setTimeout(watchTick, 50);   // mở tab là đọc ngay
    });
    setInterval(watchTick, WATCH_MS);
    paintAll();
  }

  init();
})();
