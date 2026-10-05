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
  // Cờ tính là "đã xử lý một clip đã chọn" (SKIP/SLNT/DRY là dòng không cắt được gửi kèm).
  var COUNTED = { OK: 1, HAVE: 1, FAIL: 1, BAD: 1, MISS: 1, NORE: 1 };

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
    watch: { polling: false, pendingKey: '', changedAt: 0, failKey: '' },
    bulk: null         // chế độ hàng loạt: {sig, active, items:[{seq,id,name,label,read,dest,unpicked,include,status,error}]}
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  // UXP không hỗ trợ CSS :empty → ô trống phải ẩn bằng JS, không thì hiện thành thanh rỗng.
  function setText(e, txt) {
    if (typeof e === 'string') e = $(e);
    if (!e) return;
    e.textContent = txt || '';
    e.style.display = txt ? '' : 'none';
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function base(p) { var s = String(p || ''); return s.substring(s.lastIndexOf('/') + 1); }
  function shortDir(p) { return RCC.shortDest(p); }   // giữ tên sản phẩm (thư mục trên Output/)

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
      hideText: s.hideText !== false,
      resume: !!s.resume,
      audioMix: !!s.audioMix,
      audioPer: Array.isArray(s.audioPer) ? s.audioPer : [],
      hear: (s.hear && typeof s.hear === 'object') ? s.hear : {},
      vinc: (s.vinc && typeof s.vinc === 'object') ? s.vinc : {},
      master: (s.master && typeof s.master === 'object') ? s.master : {},
      chosen: RCC.cleanChosen(s.chosen),
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
      return { ok: false, error: window.BRIDGE_OFFLINE_MSG };
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
      // UXP chỉ bắn readystatechange MỘT lần ở readyState 3 — các đoạn sau chỉ đến qua onprogress
      // (đo 2026-10-02). Không nghe onprogress thì tiến độ đứng yên tới khi xuất xong.
      xhr.onprogress = pump;
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
      s.className = 'rc-status' + (kind === 'err' ? ' rc-err' : '');
      setText(s, m);
      return;
    }
    s.className = 'rc-status';
    setText(s, '');
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
      var read = await readCore(null);
      // Cùng sequence (vừa sửa timeline) → giữ các clip người dùng đã bỏ tick.
      if (!prev || prev.seqId !== read.seqId) st.unpicked = { source: {}, render: {} };
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

  // Đọc 1 sequence (seq = null → sequence đang mở): dump → FCP XML → engine quét → thư mục xuất.
  // Ghi vào st.read / st.dest (chế độ hàng loạt: của sequence đang xem).
  async function readCore(seq) {
    var r = await RCP.readSequence(seq || undefined);
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
    await scanHalves();
    await resolveDest();
    return read;
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
      // Chọn ≥ 2 sequence ở Project panel → chế độ hàng loạt (không theo dõi từng timeline).
      var sel = await RCP.selectedSequences();
      if (sel.length >= 2) {
        var sig = sel.map(function (q) { return RCP.guidOf(q); }).join(',');
        if (!st.bulk || st.bulk.sig !== sig) await enterBulk(sel, sig);
        return;
      }
      // Danh sách tab Claude đưa sang (ghim): bỏ chọn ở Project panel không xoá; chọn đúng
      // 1 sequence (hoặc một bộ ≥2 khác ở trên) mới thoát.
      if (st.bulk && st.bulk.pinned && sel.length !== 1) return;
      if (st.bulk) exitBulk();
      var s = await RCP.stamp(true);
      if (!s.ok) {
        setText('rcState', st.read ? 'Không có sequence nào đang mở — đang giữ lần đọc trước' : '');
        if (!st.read) paintGo();
        return;
      }
      if ($('rcState').textContent) setText('rcState', '');
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
    setText(e, env && env.ok ? '' : envProblem(env || {}));
  }

  // ── Hàng loạt: chọn nhiều sequence ở Project panel ─────────────────────
  function curItem() { return st.bulk ? st.bulk.items[st.bulk.active] : null; }
  // Nhãn tab: version trong tên ("CurvyFlex2.0 vid14.1 […]" → v14.1); không có thì tên rút gọn.
  function verLabel(name) {
    var t = String(name || '').replace(/\[[^\]]*\]/g, ' ');
    var m = /(?:^|[^A-Za-z0-9])(vid\s*|v)(\d+(?:\.\d+)*)(?![A-Za-z0-9])/i.exec(t) || /(?:^|\s)(\d+\.\d+(?:\.\d+)*)(?![A-Za-z0-9])/.exec(t);
    if (m) return 'v' + (m[2] || m[1]);
    t = t.trim();
    return t.length > 12 ? t.slice(0, 11) + '…' : (t || '?');
  }
  function useItem(i) {
    if (!st.bulk) return;
    st.bulk.active = i;
    var it = st.bulk.items[i];
    st.read = it.read; st.dest = it.dest; st.unpicked = it.unpicked;
    st.view = st.prefs.mode === 'both' ? (st.view || 'source') : st.prefs.mode;
    paintAll();
  }
  async function enterBulk(seqs, sig, pinned) {
    var keep = {};
    if (st.bulk) st.bulk.items.forEach(function (it) { keep[it.id] = it; });
    st.bulk = { sig: sig, active: 0, pinned: !!pinned, items: seqs.map(function (q) {
      var id = RCP.guidOf(q), old = keep[id];
      return old || { seq: q, id: id, name: String(q.name || ''), label: verLabel(q.name), read: null, dest: null,
                      unpicked: { source: {}, render: {} }, include: true, status: 'wait', error: '' };
    }) };
    st.read = null; st.dest = null;
    paintAll();
    await bulkReadAll(false);
  }
  function exitBulk() {
    // Không xoá báo cáo: mở lại sequence ban đầu sau khi xuất có thể làm đổi chọn ở Project panel.
    st.bulk = null; st.read = null; st.dest = null; st.unpicked = { source: {}, render: {} };
    paintAll();
  }
  // Đọc lần lượt từng sequence đã chọn (force: đọc lại cả những cái đã đọc).
  async function bulkReadAll(force) {
    if (!st.bulk || st.busy || st.running) return;
    if (!bridgeHasRawcut()) { setStatus('Bridge chưa có Raw-cutter — cập nhật Claude Bridge rồi thử lại.', 'err'); return; }
    var items = st.bulk.items, bad = 0;
    setBusy(true, 'ĐANG ĐỌC…');
    pixel('read');
    try {
      var env = await api('GET', '/rawcut/status');
      paintEnv(env);
      if (!env.ok) { setStatus(envProblem(env), 'err'); return; }
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!st.bulk || st.bulk.items !== items) return;   // selection đổi giữa chừng
        if (it.read && !force) continue;
        it.status = 'reading';
        st.bulk.active = i; st.read = null; st.unpicked = it.unpicked;
        paintBulk();
        setText('rcState', 'Đang đọc ' + (i + 1) + '/' + items.length + ' · ' + it.label);
        try {
          await readCore(it.seq);
          it.read = st.read; it.dest = st.dest;
          it.status = it.dest && it.dest.ok && !it.read.noCuts ? 'ok' : 'err';
          it.error = it.read.noCuts ? 'Không có cut nào để cắt.' : (it.dest && !it.dest.ok ? (it.dest.why || it.dest.error || '') : '');
        } catch (e) {
          it.status = 'err'; it.error = (e && e.message) || String(e);
        }
        if (it.status !== 'ok') it.include = false;
      }
      items.forEach(function (x) { if (x.status !== 'ok') bad++; });
      setStatus(bad ? bad + '/' + items.length + ' sequence chưa xuất được — xem lý do ở Thư mục xuất.' : '', bad ? 'warn' : '');
    } finally {
      setBusy(false);
      if (st.bulk && st.bulk.items === items) {
        var first = 0;
        for (var k = 0; k < items.length; k++) { if (items[k].status === 'ok') { first = k; break; } }
        useItem(first);
      }
      pixelEnd(!bad, false);
    }
  }
  // Thư mục / sản phẩm đổi → tính lại thư mục xuất cho mọi sequence đã chọn.
  async function refreshDests() {
    if (!st.bulk) return;
    var cur = st.bulk.active;
    for (var i = 0; i < st.bulk.items.length; i++) {
      var it = st.bulk.items[i];
      if (!it.read) continue;
      st.bulk.active = i; st.read = it.read;
      await resolveDest();
      if (it.status !== 'reading') {
        var ok = it.dest && it.dest.ok && !it.read.noCuts;
        if (ok && it.status === 'err') it.include = true;
        it.status = ok ? 'ok' : 'err';
        it.error = ok ? '' : (it.read.noCuts ? 'Không có cut nào để cắt.' : (it.dest.why || it.dest.error || ''));
        if (!ok) it.include = false;
      }
    }
    useItem(cur);
  }
  function pickedForItem(it, half) {
    if (!it || !it.read) return [];
    var on = {};
    RCC.typeList(it.read.rows.source || [], st.prefs.types).forEach(function (t) { on[t.ext] = t.on; });
    return RCC.pickRows(it.read.rows[half] || [], { half: half, typesOn: on, unpicked: it.unpicked[half], master: it.read.master });
  }
  function bulkTargets() {
    return st.bulk ? st.bulk.items.filter(function (it) { return it.include && it.status === 'ok'; }) : [];
  }
  function bulkClipCount() {
    var n = 0;
    bulkTargets().forEach(function (it) { halvesOfMode().forEach(function (h) { n += pickedForItem(it, h).length; }); });
    return n;
  }
  // Danh sách tick trong Thư mục xuất + thanh tab version bên dưới.
  function paintBulk() {
    var list = $('rcBulkList'), tabs = $('rcSeqTabs');
    if (!st.bulk) { list.style.display = 'none'; tabs.style.display = 'none'; return; }
    list.style.display = ''; list.innerHTML = '';
    st.bulk.items.forEach(function (it, i) {
      var row = el('div', 'rc-bulk-row' + (it.status === 'err' ? ' is-err' : ''));
      row.appendChild(el('div', 'rc-tick' + (it.include ? ' on' : ''), it.include ? '✓' : ''));
      var main = el('div', 'rc-row-main');
      var title = el('div', 'rc-row-title');
      title.appendChild(el('span', 'rc-ver', it.label));
      title.appendChild(document.createTextNode(it.name));
      main.appendChild(title);
      var sub = it.status === 'reading' ? 'Đang đọc…' : (it.status === 'wait' ? 'Chờ đọc…'
        : (it.status === 'err' ? it.error : (st.prefs.mode !== 'render' && it.dest ? 'raw/ → ' + shortDir(it.dest.dirs.raw) : (it.dest ? 'edited/ → ' + shortDir(it.dest.dirs.edited) : ''))));
      main.appendChild(el('div', 'rc-row-sub', sub));
      row.appendChild(main);
      if (it.status === 'ok') {
        row.setAttribute('role', 'button');
        row.addEventListener('click', function () { if (st.running) return; it.include = !it.include; paintBulk(); paintGo(); });
      }
      list.appendChild(row);
    });
    tabs.style.display = ''; tabs.innerHTML = '';
    st.bulk.items.forEach(function (it, i) {
      var t = el('div', 'rc-seqtab' + (i === st.bulk.active ? ' active' : '') + (it.include ? '' : ' is-off'));
      t.appendChild(el('span', 'wf-dot ' + (it.status === 'ok' ? 'ok' : (it.status === 'err' ? 'err' : 'pause'))));
      t.appendChild(document.createTextNode(it.label));
      t.setAttribute('role', 'button');
      t.addEventListener('click', function () { if (st.busy) return; useItem(i); });
      tabs.appendChild(t);
    });
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
    var it = curItem();
    if (it && it.read === st.read) it.dest = st.dest;
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
      st.prefs.chosen[projectKey()] = p;               // r.chosen chỉ là cờ true — lưu đường dẫn đã chọn
      savePrefs();
    }
    await refreshDests();
    paintDest();
    paintGo();
  }
  async function onResetFolder() {
    delete st.prefs.chosen[projectKey()];
    savePrefs();
    await resolveDest();
    await refreshDests();
    paintDest(); paintGo();
  }
  async function onProductPick(v) {
    if (v) st.prefs.productPick[projectKey()] = v; else delete st.prefs.productPick[projectKey()];
    savePrefs();
    await resolveDest();
    await refreshDests();
    paintDest(); paintGo();
  }

  function paintDest() {
    var card = $('rcDestCard'), line = $('rcDestLine'), d = st.dest, pick = $('rcProduct');
    card.style.display = st.read ? '' : 'none';
    $('rcResetFolder').style.display = st.prefs.chosen[projectKey()] ? '' : 'none';
    line.innerHTML = '';
    if (st.bulk) {
      card.style.display = '';
      // Sản phẩm chọn theo project → lấy dest của sequence nào cần chọn (hoặc đang xem).
      var need = st.bulk.items.filter(function (it) { return it.dest && (it.dest.needPick || it.dest.route === 'picked' || it.dest.route === 'matched'); })[0];
      d = need ? need.dest : d;
      paintBulk();
    } else { $('rcBulkList').style.display = 'none'; $('rcSeqTabs').style.display = 'none'; }
    if (!d) { pick.style.display = 'none'; return; }
    var mode = st.prefs.mode;
    if (st.bulk) { /* từng dòng đã có ở rcBulkList */ }
    else if (d.ok) {
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
    $('rcListToggle').textContent = (st.listOpen ? '▾ Ẩn danh sách' : '▸ Xem danh sách') + ' (' + rows.length + ' dòng)';
    $('rcListWrap').style.display = st.listOpen ? '' : 'none';
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
    $('rcHideText').classList.toggle('on', st.prefs.hideText);
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
    setText(fpsNote, st.prefs.fps ? 'Ép frame rate làm clip KHÔNG còn đúng từng frame của timeline.' : '');
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
    if (st.bulk) {
      var nSeq = bulkTargets().length, nClip = bulkClipCount();
      go.classList.toggle('is-busy', st.busy || st.running || !nSeq || !nClip);
      $('rcGoLabel').textContent = label || (st.running ? 'ĐANG XUẤT…' : (st.busy ? 'ĐANG ĐỌC…' : (nSeq ? 'XUẤT ' + nSeq + ' SEQUENCE' : 'CHƯA CÓ SEQUENCE NÀO XUẤT ĐƯỢC')));
      $('rcGoSub').textContent = MODES[st.prefs.mode] + ' · ' + nClip + ' clip';
      $('rcCancel').style.display = (st.running || st.busy) ? '' : 'none';
      return;
    }
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
    if (st.bulk) {
      var nOk = st.bulk.items.filter(function (it) { return it.status === 'ok'; }).length;
      $('rcDot').className = 'wf-dot ' + (nOk ? 'ok' : 'pause');
      name.textContent = st.bulk.items.length + ' sequence đã chọn';
      name.classList.remove('is-empty');
      if (!st.busy) setText('rcState', nOk + ' sẵn sàng' + (st.bulk.items.length - nOk ? ' · ' + (st.bulk.items.length - nOk) + ' chưa xuất được' : '') + ' — đang xem ' + (curItem() ? curItem().label : ''));
    } else {
      name.textContent = r ? r.seqName : 'Mở một sequence trong Premiere';
      name.classList.toggle('is-empty', !r);
    }
    $('rcDetailToggle').style.display = r ? '' : 'none';
    var meta = $('rcSeqMeta');
    setText(meta, r ? [(r.width || r.info.width) + '×' + (r.height || r.info.height), (r.fps ? r.fps.toFixed(3).replace(/\.?0+$/, '') : '?') + ' fps', r.read && r.read.xml ? 'XML ✓' : 'không có XML'].join(' · ') : '');
    var notes = $('rcNotes');
    notes.innerHTML = '';
    if (r) (r.warnings.concat(r.notes)).slice(0, 6).forEach(function (n) { notes.appendChild(el('div', 'rc-note', '• ' + n)); });
    notes.style.display = notes.children.length ? '' : 'none';
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
      results = await runHalves(halves, picked, dest, '', retry, g.consentFp);
    } catch (e) {
      results.push({ half: '?', error: (e && e.message) || String(e), errors: [] });
    } finally {
      st.running = false;
      progStop();
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

  // Chạy các nửa của 1 sequence (st.read đang là sequence đó). tag: tiền tố tiến độ (hàng loạt).
  async function runHalves(halves, picked, dest, tag, retry, consentFp) {
    var results = [];
    for (var i = 0; i < halves.length; i++) {
      if (st.stop) break;
      var h = halves[i];
      var prefix = (tag ? tag + ' · ' : '') + (halves.length > 1 ? '(' + (i + 1) + '/' + halves.length + ') ' : '') + HALF_LABEL[h];
      var res = (h === 'source')
        ? await exportHalf('source', dest.dirs.raw, picked.source || [], null, prefix, !!retry)
        : await renderHalf(dest.dirs.edited, picked.render || [], prefix, retry ? retry.render : null, consentFp);
      results.push(res);
    }
    return results;
  }

  // Hàng loạt: lần lượt mở từng sequence → đọc lại (bản mới nhất, giữ clip đã bỏ tick) → xuất.
  // retryMap: {id: {source:true, render:{key:status}}} khi Thử lại các sequence lỗi.
  async function onGoBulk(retryMap) {
    if (!st.bulk || st.busy || st.running || st.confirmResolve) return;
    var targets = retryMap ? st.bulk.items.filter(function (it) { return retryMap[it.id]; }) : bulkTargets();
    if (!targets.length) { setStatus('Chưa có sequence nào để xuất.', 'warn'); return; }
    st.running = true; st.stop = false;
    hideReport();
    paintGo();
    var orig = null, all = [];
    try { orig = await getActiveSequence(); } catch (e) {}
    try {
      for (var k = 0; k < targets.length; k++) {
        if (st.stop) break;
        var it = targets[k], tag = it.label + ' (' + (k + 1) + '/' + targets.length + ')';
        useItem(st.bulk.items.indexOf(it));
        var retry = retryMap ? retryMap[it.id] : null;
        var halves = retry ? Object.keys(retry) : halvesOfMode();
        // Chỉ Timeline Render cần sequence đang mở trên timeline (đặt in/out + render).
        var needOpen = halves.indexOf('render') !== -1, opened = true;
        if (needOpen) { liveText(tag + ' · mở sequence…'); opened = await RCP.activate(it.seq); }
        if (!opened) { all.push({ item: it, results: [{ half: '?', error: 'Không mở được sequence lên timeline — chưa render.', errors: [] }] }); continue; }
        try {
          liveText(tag + ' · đọc lại timeline…');
          await readCore(it.seq);
          it.read = st.read; it.dest = st.dest;
        } catch (e) { all.push({ item: it, results: [{ half: '?', error: (e && e.message) || String(e), errors: [] }] }); continue; }
        if (!it.dest || !it.dest.ok) { all.push({ item: it, results: [{ half: '?', error: (it.dest && (it.dest.why || it.dest.error)) || 'Chưa có thư mục xuất', errors: [] }] }); continue; }
        var picked = {};
        halves.forEach(function (h) { picked[h] = pickedForItem(it, h); });
        var results = await runHalves(halves, picked, it.dest, tag, retry, it.read.fp);
        all.push({ item: it, results: results });
      }
    } catch (e) {
      all.push({ item: curItem(), results: [{ half: '?', error: (e && e.message) || String(e), errors: [] }] });
    } finally {
      if (orig && halvesOfMode().indexOf('render') !== -1) { try { await RCP.activate(orig); } catch (e) {} }
      st.running = false;
      progStop();
      showProgress(false);
      paintGo();
    }
    var flat = [];
    all.forEach(function (a) { a.results.forEach(function (r) { r.seqLabel = a.item ? a.item.label : '?'; r.seqId = a.item ? a.item.id : ''; flat.push(r); }); });
    st.last = { results: flat, bulk: all };
    paintReport(flat);
    var bad = flat.some(function (r) { return r.error || r.failed > 0 || r.cancelled; });
    pixelEnd(!bad, flat.some(function (r) { return r.cancelled; }));
    try { api('POST', '/notify', { title: 'Raw-cutter', body: (bad ? 'Xuất xong — có lỗi' : 'Xuất xong') + ' · ' + all.length + ' sequence' }); } catch (e) {}
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
    var lastFail = false;
    progStart({ prefix: prefix, total: picked.length, phase: 'cut' });
    var r = await sse('/rawcut/export', body, function (ev) {
      if (ev.type !== 'event') return;
      var e = ev.ev;
      if (e.type === 'start') {
        if (!prog.started[e.file]) { prog.started[e.file] = true; prog.inflight++; }
        prog.label = e.file;
      } else if (e.type === 'done') {
        if (prog.started[e.file]) { delete prog.started[e.file]; prog.inflight = Math.max(0, prog.inflight - 1); }
        if (COUNTED[e.flag]) prog.done = Math.min(prog.total, prog.done + 1);
        // SKIP/SLNT/DRY = dòng không cắt được, đã có trong tóm tắt — chỉ liệt kê lỗi thật.
        // MISS của dòng không chọn (gửi kèm để giữ cảnh báo) không phải lỗi lượt này — chỉ FAIL/BAD/NORE
        // luôn là lỗi; MISS chỉ tính khi đã có trong tóm tắt clip chọn (xem dưới).
        lastFail = !e.ok && !!REAL_FAIL[e.flag] && e.flag !== 'MISS';
        if (lastFail) res.errors.push(e.flag + ' ' + e.file);
      } else if (e.type === 'reason') { if (lastFail && res.errors.length) res.errors[res.errors.length - 1] += ' — ' + e.text; }
    });
    progStop();
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
      progStart({ prefix: prefix, total: rr.ranges.length, phase: 'render' });
      pixel('render');
      var rend = await RCP.renderRanges({
        ranges: rr.ranges, dir: cache.dir, preset: preset.path, stockPreset: preset.stockPath,
        hideText: st.prefs.hideText, master: st.read.master,
        keepVideo: includeList(), keepAudio: hearList(), offeredAudio: st.read.audioTracks.map(function (t) { return t.index; }),
        expect: { id: st.read.seqId, fp: consentFp || st.read.fp },
        onProgress: function (d, t, label) {
          var now = Date.now();
          if (d > prog.done) { prog.stepMs.push((now - prog.stepAt) / (d - prog.done)); prog.stepAt = now; prog.done = d; }
          prog.total = t; prog.label = label || ''; progPaint();
        },
        shouldStop: function () { return st.stop; }
      });
      progStop();
      res.render = rend;
      (rend.warnings || []).forEach(function (x) { res.errors.push('⚠ ' + x); });
      rend.renders.filter(function (x) { return !x.ok; }).forEach(function (x) { res.errors.push('Render lỗi ' + x.label + ': ' + x.error); });
      if (rend.textHidden) res.info = 'Đã ẩn ' + rend.textHidden + ' clip text/MOGRT trong lúc render (đã bật lại).';
      if (rend.skipped && rend.skipped.length) {
        // Cut là chính clip text trên master track: không render (khung đen), không cắt.
        picked = picked.filter(function (r) { return rend.skipped.indexOf(RCC.renderLabel(r)) === -1; });
        res.info = (res.info ? res.info + ' ' : '') + 'Bỏ qua ' + rend.skipped.length + ' cut là text trên master track.';
      }
      if (rend.stopped) { res.cancelled = true; res.error = 'Đã dừng sau ' + rend.written + '/' + rr.ranges.length + ' bản render — chưa cắt gì vào edited/.'; return res; }
      // Hỏng giữa chừng (in/out không vào, không render được cut nào) → không cắt edited/ dở dang.
      if (rend.refused || rend.error || !rend.ok) { res.error = (rend.error || 'Premiere không render được cut nào') + ' — chưa cắt gì vào edited/.'; return res; }
    }
    var out = await exportHalf('render', outDir, picked, cache.dir, prefix, !!retryKeys);
    out.errors = res.errors.concat(out.errors);
    out.info = res.info;
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
  // ── Tiến độ chạy: đồng hồ + thanh nhích dần, để thấy plugin đang làm việc ──
  // Engine cắt song song (8 clip) và chỉ báo khi một clip XONG — clip CRF 1 từ Drive có thể
  // mất cả chục giây → đếm thêm clip đang cắt, thanh nhích theo đó. Render: Premiere làm từng
  // cut (~1.5–3s), thanh nhích theo thời gian trung bình mỗi cut. Đồng hồ nhảy mỗi giây.
  var prog = { timer: null };
  function fmtTime(ms) { var x = Math.floor(ms / 1000); return Math.floor(x / 60) + ':' + ('0' + (x % 60)).slice(-2); }
  function progStart(o) {
    progStop();
    prog = { t0: Date.now(), done: 0, total: o.total || 0, inflight: 0, label: '', phase: o.phase || 'cut',
             prefix: o.prefix || '', stepAt: Date.now(), stepMs: [], started: {}, timer: null };
    prog.timer = setInterval(progPaint, 250);
    progPaint();
  }
  function progStop() { if (prog.timer) clearInterval(prog.timer); prog.timer = null; }
  function progPaint() {
    var p = prog, now = Date.now(), total = Math.max(1, p.total), frac, mid;
    if (p.phase === 'render') {
      var avg = 2500;
      if (p.stepMs.length) avg = p.stepMs.reduce(function (a, b) { return a + b; }, 0) / p.stepMs.length;
      frac = (p.done + Math.min(0.9, (now - p.stepAt) / avg)) / total;
      mid = 'Premiere render ' + p.done + '/' + p.total;
    } else {
      frac = (p.done + 0.4 * p.inflight) / total;
      mid = (p.done || p.inflight) ? 'xong ' + p.done + '/' + p.total + (p.inflight ? ' · đang cắt ' + p.inflight : '')
                                   : 'chuẩn bị ' + p.total + ' clip…';
    }
    showProgress(true, p.prefix + ' · ' + mid + ' · ' + fmtTime(now - p.t0) + (p.label ? '\n' + p.label : ''), Math.min(1, frac));
  }

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
      head.appendChild(el('div', 'rsz-row-title', (r.seqLabel ? r.seqLabel + ' · ' : '') + (r.half === 'render' ? 'edited/ — Timeline Render' : (r.half === 'source' ? 'raw/ — Source Render' : 'Lỗi'))));
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
      if (r.info) lines.push(r.info);
      if (r.dir) lines.push('→ ' + shortDir(r.dir));
      row.appendChild(el('div', 'rsz-row-sub', lines.join('\n')));
      r.errors.slice(0, 8).forEach(function (x) { row.appendChild(el('div', 'rc-row-err', x)); });
      if (r.errors.length > 8) row.appendChild(el('div', 'rc-row-err', '… còn ' + (r.errors.length - 8) + ' dòng — xem clips.csv / report/bridge-log.txt'));
      box.appendChild(row);
      if (r.failedKeys && (r.half === 'source' || r.half === 'render')) {
        // Hàng loạt: gom theo sequence {id: {source:true, render:{…}}}; một sequence thì như cũ.
        var bag = r.seqId ? (retry[r.seqId] = retry[r.seqId] || {}) : retry;
        bag[r.half] = r.half === 'render' ? r.failedKeys : true; anyFailed = true;
      } else if (r.seqId && r.error && !r.cancelled) {
        // Sequence hỏng trước khi engine chạy (không mở/không đọc được) → thử lại cả sequence.
        var b2 = retry[r.seqId] = retry[r.seqId] || {};
        if (r.half === 'source' || r.half === 'render') b2[r.half] = r.half === 'render' ? null : true;
        else halvesOfMode().forEach(function (h) { b2[h] = h === 'render' ? null : true; });
        anyFailed = true;
      }
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
    $('rcRead').addEventListener('click', function () { if (st.bulk) bulkReadAll(true); else onRead(); });
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
        if (st.bulk) await bulkReadAll(true);
        else if (st.read) await rescan('✓ Đã đọc lại cho ' + MODES[m]);
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
    $('rcListToggle').addEventListener('click', function () { st.listOpen = !st.listOpen; paintClips(); });
    $('rcShowDead').addEventListener('click', function () { st.showDead = !st.showDead; paintClips(); });
    $('rcAudioMix').addEventListener('click', function () { st.prefs.audioMix = !st.prefs.audioMix; savePrefs(); paintAudio(); });
    $('rcCrfMinus').addEventListener('click', function () { stepCrf(-0.5); });
    $('rcCrfPlus').addEventListener('click', function () { stepCrf(0.5); });
    FPS_LIST.forEach(function (f) { var o = el('option', '', f ? f + ' fps' : 'Theo nguồn'); o.value = f; $('rcFps').appendChild(o); });
    $('rcFps').addEventListener('change', function () { st.prefs.fps = $('rcFps').value; savePrefs(); paintQuality(); });
    // <select> của UXP đổi giá trị khi lăn chuột ngang qua → chặn lăn trên ô fps.
    $('rcFps').addEventListener('wheel', function (e) { e.preventDefault(); e.stopPropagation(); }, { passive: false });
    $('rcHideText').addEventListener('click', function () { if (st.running) return; st.prefs.hideText = !st.prefs.hideText; savePrefs(); paintRender(); });
    $('rcTrans').addEventListener('click', function () { st.prefs.transitions = !st.prefs.transitions; savePrefs(); paintQuality(); });
    $('rcResume').addEventListener('click', function () { st.prefs.resume = !st.prefs.resume; savePrefs(); paintQuality(); });
    $('rcPresetSave').addEventListener('click', onPresetSave);
    $('rcPresetDel').addEventListener('click', onPresetDelete);
    bindKeyboard('rcPresetName');
    $('rcGo').addEventListener('click', function () { if (st.bulk) onGoBulk(null); else onGo(null); });
    $('rcCancel').addEventListener('click', onCancel);
    $('rcConfirmYes').addEventListener('click', function () { answerConfirm(true); });
    $('rcConfirmNo').addEventListener('click', function () { answerConfirm(false); });
    // Hàng loạt: mở thư mục của sequence đang xem (bấm tab version để đổi).
    function lastDest() { return st.last ? (st.last.bulk ? (curItem() && curItem().dest) : st.last.dest) : null; }
    $('rcOpenRaw').addEventListener('click', function () { var d = lastDest(); if (d && d.dirs) api('POST', '/rawcut/open', { dir: d.dirs.raw }); });
    $('rcOpenEdited').addEventListener('click', function () { var d = lastDest(); if (d && d.dirs) api('POST', '/rawcut/open', { dir: d.dirs.edited }); });
    $('rcRetry').addEventListener('click', function () { if (!st.retry) return; if (st.last && st.last.bulk && st.bulk) onGoBulk(st.retry); else onGo(st.retry); });
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

  // ── Cho tab Claude điều phối (claude-tab.js) ──────────────────────────
  // Chuẩn bị tab RAW cho các sequence tab Claude chọn: đặt mode, 1 sequence → mở lên timeline
  // (tab tự đọc), ≥ 2 → hàng loạt ghim + đọc hết. KHÔNG tự bấm Xuất — việc nặng, người dùng
  // xem lại thư mục xuất / clip rồi bấm XUẤT trong tab RAW.
  window.RawcutAPI = {
    modes: MODES,
    prepare: async function (seqs, mode) {
      if (st.busy || st.running) throw new Error('tab RAW đang chạy lượt khác');
      if (!seqs || !seqs.length) throw new Error('chưa có sequence nào');
      if (mode && MODES[mode] && mode !== st.prefs.mode) { st.prefs.mode = mode; savePrefs(); paintModes(); }
      if (typeof window.tabOpen === 'function') window.tabOpen('rawcut');
      if (seqs.length === 1) {
        if (st.bulk) exitBulk();
        var ok = await RCP.activate(seqs[0]);
        if (!ok) throw new Error('không mở được sequence lên timeline');
        setTimeout(watchTick, 50);
        return { count: 1 };
      }
      await enterBulk(seqs, seqs.map(function (q) { return RCP.guidOf(q); }).join(','), true);
      var nOk = st.bulk ? st.bulk.items.filter(function (it) { return it.status === 'ok'; }).length : 0;
      return { count: seqs.length, ready: nOk };
    }
  };
})();
