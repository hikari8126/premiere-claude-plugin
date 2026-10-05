// plugin/rawcut-ppro.js — phần gọi Premiere của tab Raw-cutter (thay host.jsx của bản CEP).
//
// Classic script, nạp SAU main.js: dùng chung ppro, getActiveProject, getActiveSequence,
// BRIDGE_URL. Logic thuần ở rawcut-core.js (global RCC). Xuất global RCP:
//   RCP.readSequence()  → dump JSON (schema của engine) + fingerprint + thông tin sequence
//   RCP.exportXml(seq)  → đường dẫn FCP XML (Premiere ≥ 26.3) hoặc null
//   RCP.stamp(deep)     → {id, name, fp?} của sequence đang mở (chống timeline bị sửa)
//   RCP.renderRanges(o) → Premiere render từng cut ra cache cho nửa Timeline Render
//   RCP.diag()          → chẩn đoán API (đọc, không sửa gì)
//
// API đã dò trên Premiere 25.6.5 (2026-10-01): track item có getStartTime/getEndTime
// (thời gian sequence), getInPoint/getOutPoint (ĐƠN VỊ TIMELINE — out−in = độ dài trên
// timeline), getSpeed() là hệ số (1.59 = 159%), isSpeedReversed() trả số, isDisabled(),
// getIsSelected(), isAdjustmentLayer(). ClipProjectItem có isOffline/isSequence/
// isMulticamClip/getSequence/getFootageInterpretation (getFrameRate, getRemovePullDown…).
// Track: isMuted/setMute. TickTime.createWithTicks có. 25.6 KHÔNG có ProjectConverter.

var RCP = (function () {
  'use strict';
  var TPS = 254016000000;
  var MAX_NEST_DEPTH = 4;

  async function un(v) { return (v && typeof v.then === 'function') ? await v : v; }
  function has(o, k) { return !!o && typeof o[k] === 'function'; }
  async function call(o, k, fallback) {
    if (!has(o, k)) return fallback;
    try { return await un(o[k]()); } catch (e) { return fallback; }
  }
  function ticksOf(t) {
    if (t === null || t === undefined) return null;
    try { if (t.ticks !== undefined && t.ticks !== null) return String(t.ticks); } catch (e) {}
    try { if (typeof t.seconds === 'number') return String(Math.round(t.seconds * TPS)); } catch (e) {}
    if (typeof t === 'number') return String(Math.round(t * TPS));
    return null;
  }
  function guidOf(seq) {
    try { var g = seq && seq.guid; return g ? String(g.toString ? g.toString() : g) : ''; } catch (e) { return ''; }
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function hostVersion() {
    try { var h = require('uxp').host; return String((h && h.version) || ''); } catch (e) { return ''; }
  }
  // Không bao giờ ném: bridge restart giữa lượt render không được làm vỡ vòng render.
  async function bridgePost(url, body) {
    try {
      var r = await fetch(BRIDGE_URL + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      var t = await r.text();
      try { return JSON.parse(t); } catch (e) { return { ok: false, error: 'Bridge trả về không phải JSON (bridge cũ?)' }; }
    } catch (e) { return { ok: false, error: 'Không kết nối được Bridge' }; }
  }

  // Bắt lỗi BÊN TRONG lockedAccess — throw lọt ra ngoài lock có thể làm treo Premiere.
  async function commit(project, fn, label) {
    var err = null;
    var r = project.lockedAccess(function () {
      try { project.executeTransaction(fn, label || 'Raw-cutter'); } catch (e) { err = e; }
    });
    if (r && typeof r.then === 'function') await r;
    if (err) throw err;
  }

  async function trackList(seq, kind) {
    var n = Number(await call(seq, kind === 'v' ? 'getVideoTrackCount' : 'getAudioTrackCount', 0)) || 0;
    var out = [];
    for (var i = 0; i < n; i++) {
      var t = null;
      try { t = await un(kind === 'v' ? seq.getVideoTrack(i) : seq.getAudioTrack(i)); } catch (e) {}
      if (t) out.push({ index: i + 1, track: t });
    }
    return out;
  }
  async function itemsOf(track) {
    try { var a = await un(track.getTrackItems(1, false)); return a ? Array.prototype.slice.call(a) : []; } catch (e) { return []; }
  }

  // Đọc một track item. withDetail=false: chỉ phần cần cho fingerprint.
  async function readItem(it, withDetail) {
    var c = {};
    c.startTicks = ticksOf(await call(it, 'getStartTime', null)) || '0';
    c.endTicks = ticksOf(await call(it, 'getEndTime', null)) || '0';
    c.inTicks = ticksOf(await call(it, 'getInPoint', null)) || '0';
    c.outTicks = ticksOf(await call(it, 'getOutPoint', null)) || '0';
    c.disabled = !!(await call(it, 'isDisabled', false));
    var pi = null, cpi = null;
    try { pi = await un(it.getProjectItem()); } catch (e) {}
    if (pi) {
      try { cpi = (ppro.ClipProjectItem && ppro.ClipProjectItem.cast) ? ppro.ClipProjectItem.cast(pi) : pi; } catch (e) { cpi = pi; }
    }
    var nodeId = '';
    try { nodeId = String((pi && (has(pi, 'getId') ? await un(pi.getId()) : pi.id)) || ''); } catch (e) {}
    var mediaPath = '';
    if (cpi && has(cpi, 'getMediaFilePath')) { try { mediaPath = String((await un(cpi.getMediaFilePath())) || ''); } catch (e) {} }
    var isSeq = !!(await call(cpi, 'isSequence', false));
    c.pi = { name: '', nodeId: nodeId, mediaPath: mediaPath, isSequence: isSeq, isOffline: false, isMulticam: false };
    c._cpi = cpi;
    if (!withDetail) return c;

    c.name = String((await call(it, 'getName', '')) || '');
    var spd = await call(it, 'getSpeed', null);
    c.speed = (typeof spd === 'number' && spd > 0) ? spd : null;
    c.reversed = !!(await call(it, 'isSpeedReversed', false));
    c.selected = !!(await call(it, 'getIsSelected', false));
    c.adjustment = !!(await call(it, 'isAdjustmentLayer', false));
    try { c.pi.name = String((pi && pi.name) || ''); } catch (e) {}
    c.pi.isOffline = !!(await call(cpi, 'isOffline', false));
    c.pi.isMulticam = !!(await call(cpi, 'isMulticamClip', false));
    if (!isSeq && has(cpi, 'getFootageInterpretation')) {
      try {
        var fi = await un(cpi.getFootageInterpretation());
        c.interp = {
          frameRate: await call(fi, 'getFrameRate', null),
          par: await call(fi, 'getPixelAspectRatio', null),
          fieldType: await call(fi, 'getFieldType', null),
          removePulldown: await call(fi, 'getRemovePullDown', null),
          alphaUsage: await call(fi, 'getAlphaUsage', null)
        };
      } catch (e) {}
    }
    c.components = [];
    try {
      var ch = await un(it.getComponentChain());
      var n = Number(await call(ch, 'getComponentCount', 0)) || 0;
      for (var k = 0; k < n; k++) {
        var co = await un(ch.getComponentAtIndex(k));
        if (!co) continue;
        c.components.push({ matchName: String((await call(co, 'getMatchName', '')) || ''), displayName: String((await call(co, 'getDisplayName', '')) || '') });
      }
    } catch (e) {}
    return c;
  }

  // Fingerprint một sequence (đệ quy vào nest, nhớ theo guid, chặn vòng lặp).
  async function seqFingerprint(seq, depth, memo, stack) {
    var id = guidOf(seq);
    if (memo[id]) return memo[id];
    if (depth > MAX_NEST_DEPTH) return 'deep';
    if (stack[id]) return '?';
    stack[id] = true;
    var tracks = [];
    var kinds = ['v', 'a'];
    for (var k = 0; k < kinds.length; k++) {
      var list = await trackList(seq, kinds[k]);
      for (var i = 0; i < list.length; i++) {
        var t = { kind: kinds[k], index: list[i].index, muted: await call(list[i].track, 'isMuted', null), clips: [] };
        var items = await itemsOf(list[i].track);
        for (var j = 0; j < items.length; j++) {
          var c = await readItem(items[j], false);
          var nest = null;
          if (c.pi.isSequence && has(c._cpi, 'getSequence')) {
            try { var ns = await un(c._cpi.getSequence()); nest = ns ? await seqFingerprint(ns, depth + 1, memo, stack) : '?'; } catch (e) { nest = '?'; }
          }
          t.clips.push({ start: c.startTicks, end: c.endTicks, inp: c.inTicks, out: c.outTicks, on: !c.disabled, nodeId: c.pi.nodeId, path: c.pi.mediaPath, nest: nest });
        }
        tracks.push(t);
      }
    }
    delete stack[id];
    memo[id] = RCC.fingerprint(tracks);
    return memo[id];
  }

  async function frameSize(seq) {
    var fs = await call(seq, 'getFrameSize', null);
    if (fs && fs.width) return { width: Number(fs.width), height: Number(fs.height) };
    try {
      var st = await un(seq.getSettings());
      var r = await un(st.getVideoFrameRect());
      if (r) return { width: Number(r.width || (r.right - r.left) || 0), height: Number(r.height || (r.bottom - r.top) || 0) };
    } catch (e) {}
    return { width: 0, height: 0 };
  }

  // Đọc sequence đang mở → {seq, project, info, dump, fp, warnings}.
  async function readSequence(seqOpt) {
    var project = await getActiveProject();
    var seq = seqOpt || await getActiveSequence();
    var tb = String((await call(seq, 'getTimebase', '')) || '');
    var size = await frameSize(seq);
    var info = {
      premiereVersion: hostVersion(),
      projectName: String(project.name || ''),
      projectPath: String(project.path || ''),
      name: String(seq.name || ''),
      id: guidOf(seq),
      timebase: tb,
      width: size.width, height: size.height,
      endTicks: ticksOf(await call(seq, 'getEndTime', null)) || '0',
      inTicks: ticksOf(await call(seq, 'getInPoint', null)),
      outTicks: ticksOf(await call(seq, 'getOutPoint', null))
    };
    var clips = [], warnings = [], kinds = ['v', 'a'];
    var fpTracks = [], memo = {}, stack = {};
    stack[info.id] = true;
    for (var k = 0; k < kinds.length; k++) {
      var list = await trackList(seq, kinds[k]);
      for (var i = 0; i < list.length; i++) {
        var t = { kind: kinds[k], index: list[i].index, muted: await call(list[i].track, 'isMuted', null), clips: [] };
        var items = await itemsOf(list[i].track);
        for (var j = 0; j < items.length; j++) {
          var c;
          try { c = await readItem(items[j], true); }
          catch (e) { c = { error: (e && e.message) || String(e), pi: {} }; warnings.push('Không đọc được 1 clip ở ' + (kinds[k] === 'v' ? 'V' : 'A') + list[i].index); }
          c.trackIndex = list[i].index;
          c.trackType = kinds[k] === 'v' ? 'video' : 'audio';
          var nest = null;
          if (c.pi && c.pi.isSequence && has(c._cpi, 'getSequence')) {
            try { var ns = await un(c._cpi.getSequence()); nest = ns ? await seqFingerprint(ns, 1, memo, stack) : '?'; } catch (e) { nest = '?'; }
          }
          delete c._cpi;
          clips.push(c);
          t.clips.push({ start: c.startTicks, end: c.endTicks, inp: c.inTicks, out: c.outTicks, on: !c.disabled, nodeId: (c.pi || {}).nodeId, path: (c.pi || {}).mediaPath, nest: nest });
        }
        fpTracks.push(t);
      }
    }
    var dump = RCC.buildDump(info, clips);
    return {
      seq: seq, project: project, info: info, dump: dump, fp: RCC.fingerprint(fpTracks), warnings: warnings,
      fps: dump.sequence.fps, videoTracks: fpTracks.filter(function (t) { return t.kind === 'v'; }).length,
      audioTracks: fpTracks.filter(function (t) { return t.kind === 'a'; }).map(function (t) { return { index: t.index, items: t.clips.length }; })
    };
  }

  // FCP XML của sequence (để engine có nest, transition, audio level). null = không có API.
  async function exportXml(seq) {
    var PC = ppro.ProjectConverter;
    if (!PC || typeof PC.exportAsFinalCutProXML !== 'function') return { path: null, why: 'Premiere bản này chưa có xuất FCP XML qua UXP (cần ≥ 26.3) — đọc bằng dữ liệu Premiere, nested sequence sẽ bị bỏ qua.' };
    var folder = await require('uxp').storage.localFileSystem.getTemporaryFolder();
    var name = 'rawcut-' + Date.now() + '.xml';
    var outPath = String(folder.nativePath || '').replace(/\/$/, '') + '/' + name;
    var ok = false;
    try { ok = await un(PC.exportAsFinalCutProXML(seq, outPath, true)); }
    catch (e) { return { path: null, why: 'Xuất FCP XML lỗi: ' + ((e && e.message) || e) + ' — đọc bằng dữ liệu Premiere.' }; }
    if (!ok) return { path: null, why: 'Premiere không xuất được FCP XML — đọc bằng dữ liệu Premiere, nested sequence sẽ bị bỏ qua.' };
    return { path: outPath, why: '' };
  }

  // Sequence đang mở: id + tên; deep → kèm fingerprint.
  async function stamp(deep) {
    var seq = null;
    try { seq = await getActiveSequence(); } catch (e) { return { ok: false, none: true }; }
    var out = { ok: true, id: guidOf(seq), name: String(seq.name || '') };
    if (deep) {
      var memo = {}, stack = {};
      try { out.fp = await seqFingerprint(seq, 0, memo, stack); } catch (e) { out.fp = null; }
    }
    return out;
  }

  // ── Ẩn text khi render ─────────────────────────────────────────────────
  // Clip text/title (AE.ADBE Text…) và MOGRT (AE.ADBE Capsule) có tham số chữ — cùng cách nhận
  // diện với tab Un-nest (main.js UNNEST_TEXT_*). MOGRT có cả hình lẫn chữ cũng bị ẩn.
  var TEXT_COMP_RE = /text|title|caption/i;
  var TEXT_PARAM_RE = /\btext\b|main text|source text|font\s?size|\bfont\b|tracking|leading|paragraph|highlight text|text box/i;
  async function isTextItem(it) {
    try {
      var ch = await un(it.getComponentChain());
      var n = Number(await call(ch, 'getComponentCount', 0)) || 0;
      for (var k = 0; k < n; k++) {
        var co = await un(ch.getComponentAtIndex(k));
        var mn = String((await call(co, 'getMatchName', '')) || '');
        if (TEXT_COMP_RE.test(mn)) return true;
        if (/capsule/i.test(mn)) {
          var pc = Number(await call(co, 'getParamCount', 0)) || 0;
          for (var j = 0; j < pc; j++) {
            var pr = await un(co.getParam(j));
            var dn = '';
            try { dn = has(pr, 'getDisplayName') ? String(await un(pr.getDisplayName())) : String((pr && pr.displayName) || ''); } catch (e) {}
            if (TEXT_PARAM_RE.test(dn)) return true;
          }
        }
      }
    } catch (e) {}
    return false;
  }
  // Gom clip text ĐANG BẬT của sequence (+ nest ≤ 4 tầng). spans: [inF, outF] của text nằm trên
  // master track ở tầng ngoài cùng — cut đó tắt đi sẽ render ra khung đen, nên bỏ không render.
  async function collectText(seq, depth, seen, col, master, tb) {
    var id = guidOf(seq);
    if (depth > MAX_NEST_DEPTH || seen[id]) return;
    seen[id] = true;
    var list = await trackList(seq, 'v');
    for (var i = 0; i < list.length; i++) {
      var items = await itemsOf(list[i].track);
      for (var j = 0; j < items.length; j++) {
        var it = items[j];
        if (await call(it, 'isDisabled', false)) continue;
        var cpi = null, nested = null;
        try { cpi = ppro.ClipProjectItem.cast(await un(it.getProjectItem())); } catch (e) {}
        if (cpi && (await call(cpi, 'isSequence', false)) && has(cpi, 'getSequence')) {
          try { nested = await un(cpi.getSequence()); } catch (e) {}
          if (nested) { await collectText(nested, depth + 1, seen, col, 0, tb); continue; }
        }
        if (!(await isTextItem(it))) continue;
        col.items.push(it);
        if (depth === 0 && list[i].index === master && tb > 0) {
          var a = ticksOf(await call(it, 'getStartTime', null)), b = ticksOf(await call(it, 'getEndTime', null));
          if (a !== null && b !== null) col.spans.push([Math.round(Number(a) / tb), Math.round(Number(b) / tb)]);
        }
      }
    }
  }
  async function setItemsDisabled(project, items, flag) {
    try {
      await commit(project, function (ca) {
        items.forEach(function (it) { ca.addAction(it.createSetDisabledAction(flag)); });
      }, flag ? 'Raw-cutter ẩn text' : 'Raw-cutter hiện lại text');
      return items.length;
    } catch (e) {
      // Gộp chung lỗi (vd clip ở nest khác) → làm từng clip, đếm số làm được.
      var ok = 0;
      for (var i = 0; i < items.length; i++) {
        try { await commit(project, function (ca) { ca.addAction(items[i].createSetDisabledAction(flag)); }, 'Raw-cutter text'); ok++; } catch (e2) {}
      }
      return ok;
    }
  }

  // ── Render từng cut ────────────────────────────────────────────────────
  // o = {ranges:[{label,inF,outF}], dir, preset, stockPreset, keepVideo:[n], keepAudio:[n]|null,
  //      offeredAudio:[n], expect:{id, fp}, onProgress(done,total,label), shouldStop()}
  async function renderRanges(o) {
    try { return await renderRangesInner(o); }
    catch (e) { return { ok: false, renders: [], warnings: [], written: 0, failed: 0, stopped: false, refused: '', error: 'Render lỗi: ' + ((e && e.message) || e) }; }
  }
  var AME_MISSING_RE = /AME is not installed|Media Encoder (is )?not installed/i;
  var AME_MISSING_MSG = 'Máy chưa cài Adobe Media Encoder — Timeline Render (edited/) cần AME. Mở Creative Cloud → '
    + 'cài "Media Encoder" cùng năm với Premiere, khởi động lại Premiere rồi xuất lại. Source Render (raw/) không cần AME.';
  async function renderRangesInner(o) {
    var res = { ok: false, renders: [], warnings: [], written: 0, failed: 0, stopped: false, refused: '', presetFallback: false, textHidden: 0, skipped: [] };
    var textItems = [];
    if (!ppro.EncoderManager || !ppro.EncoderManager.getManager) { res.error = 'Premiere bản này không có EncoderManager (cần ≥ 25.6)'; return res; }
    var project = await getActiveProject();
    var seq = await getActiveSequence();
    if (o.expect && o.expect.id && guidOf(seq) !== o.expect.id) { res.refused = 'sequence'; res.error = 'Đang mở sequence khác lần Đọc — không render.'; return res; }
    if (o.expect && o.expect.fp) {
      var now = null;
      try { now = await seqFingerprint(seq, 0, {}, {}); } catch (e) {}
      if (now && now !== o.expect.fp) { res.refused = 'edited'; res.error = 'Timeline đã bị sửa sau lần Đọc — không render.'; return res; }
      if (!now) res.warnings.push('Không lấy được fingerprint để kiểm timeline — vẫn render.');
    }
    var tb = Number(String((await call(seq, 'getTimebase', '')) || ''));
    if (!(tb > 0)) { res.error = 'Không đọc được timebase của sequence'; return res; }
    var em = ppro.EncoderManager.getManager();
    var ET = ppro.Constants && ppro.Constants.ExportType && ppro.Constants.ExportType.IMMEDIATELY;
    var mk = function (frames) {
      var tk = String(Math.round(frames * tb));
      return (ppro.TickTime.createWithTicks) ? ppro.TickTime.createWithTicks(tk) : ppro.TickTime.createWithSeconds(Number(tk) / TPS);
    };
    var preset = o.preset;
    var ext = 'mp4';
    try { var e2 = await un(em.getExportFileExtension(seq, preset)); if (e2) ext = String(e2).replace(/^\./, ''); } catch (e) {}

    var origIn = await call(seq, 'getInPoint', null), origOut = await call(seq, 'getOutPoint', null);
    var changed = [];   // [{track, was}] — chỉ khôi phục cái đã đổi
    async function setMute(track, want) {
      var was = await call(track, 'isMuted', null);
      if (was === want) return true;
      try { await un(track.setMute(want)); } catch (e) { return false; }
      changed.push({ track: track, was: was });
      var back = await call(track, 'isMuted', null);
      return back === want;
    }
    var ioChanged = false;
    var curOut = ticksOf(origOut);
    // ⚠️ Premiere 25.6 (đo 2026-10-02): đặt out RỒI in trong CÙNG một transaction thì out bị bỏ,
    // sequence giữ out "chưa đặt" (−101606400000000000) → render hỏng ngay cut thứ 2. Đặt từng
    // điểm một transaction riêng thì thứ tự nào cũng nhận. Vẫn đọc lại; lệch thì thử thứ tự ngược.
    async function setPoint(which, t) {
      await commit(project, function (ca) {
        ca.addAction(which === 'in' ? seq.createSetInPointAction(t) : seq.createSetOutPointAction(t));
      }, 'Raw-cutter ' + which);
    }
    async function setIO(a, b) {
      var wa = ticksOf(a), wb = ticksOf(b);
      // In mới vượt out hiện tại → đặt out trước, khỏi có lúc in > out.
      var outFirst = curOut !== null && Number(curOut) >= 0 && Number(wa) >= Number(curOut);
      var order = outFirst ? ['out', 'in'] : ['in', 'out'];
      for (var k = 0; k < 2; k++) await setPoint(order[k], order[k] === 'in' ? a : b);
      ioChanged = true;
      var gi = ticksOf(await call(seq, 'getInPoint', null)), go = ticksOf(await call(seq, 'getOutPoint', null));
      if (gi !== wa || go !== wb) {
        order.reverse();
        for (var j = 0; j < 2; j++) await setPoint(order[j], order[j] === 'in' ? a : b);
      }
      curOut = ticksOf(await call(seq, 'getOutPoint', null));
    }
    try {
      // Hình: chỉ track được chọn hiện trong bản render.
      var vts = await trackList(seq, 'v'), keepV = o.keepVideo || [];
      if (!keepV.length) { res.error = 'Không có track hình nào được chọn — từ chối render khung đen.'; return res; }
      for (var i = 0; i < vts.length; i++) {
        var keep = keepV.indexOf(vts[i].index) !== -1;
        var okm = await setMute(vts[i].track, !keep);
        if (!okm && keep) { res.error = 'Không bật được track V' + vts[i].index + ' — không render.'; return res; }
        if (!okm) res.warnings.push('Không ẩn được V' + vts[i].index + ' khi render.');
      }
      // Tiếng: chỉ tắt track đang hiện trong danh sách mà bị bỏ tick.
      if (o.keepAudio) {
        var ats = await trackList(seq, 'a'), offered = o.offeredAudio || [];
        for (var a = 0; a < ats.length; a++) {
          var n = ats[a].index;
          if (offered.indexOf(n) === -1 || o.keepAudio.indexOf(n) !== -1) continue;
          if (!(await setMute(ats[a].track, true))) res.warnings.push('Không tắt được A' + n + ' khi render.');
        }
      }
      // Text / MOGRT có chữ: tắt tạm trong lúc render, xong bật lại đúng những clip đã tắt.
      if (o.hideText) {
        var col = { items: [], spans: [] };
        await collectText(seq, 0, {}, col, Number(o.master) || 0, tb);
        if (col.items.length) {
          var nOff = await setItemsDisabled(project, col.items, true);
          if (nOff === col.items.length) textItems = col.items;
          else {
            if (nOff) await setItemsDisabled(project, col.items, false);   // làm dở thì trả lại hết, render như cũ
            res.warnings.push('Không tắt được clip text — render vẫn còn chữ.');
          }
        }
        res.textHidden = textItems.length;
        var nCap = Number(await call(seq, 'getCaptionTrackCount', 0)) || 0;
        for (var ci = 0; ci < nCap; ci++) {
          var ct = null;
          try { ct = await un(seq.getCaptionTrack(ci)); } catch (e) {}
          if (ct && has(ct, 'setMute')) await setMute(ct, true);
        }
        if (col.spans.length) {
          o.ranges = o.ranges.filter(function (rg) {
            var inside = col.spans.some(function (sp) { return rg.inF >= sp[0] && rg.outF <= sp[1]; });
            if (inside) res.skipped.push(rg.label);
            return !inside;
          });
        }
      }
      // Hỏi thẳng Premiere có AME không (isAMEInstalled — property hoặc hàm tuỳ bản). false = chắc chắn
      // thiếu → dừng trước khi thử từng cut. Không đọc được → cứ render, lỗi cut đầu sẽ bắt lại.
      var amePresent = null;
      try {
        var ai = em.isAMEInstalled;
        if (typeof ai === 'function') ai = ai.call(em);
        amePresent = await un(ai);
      } catch (e) {}
      if (amePresent === false) { res.noAme = true; res.error = AME_MISSING_MSG; return res; }
      try { if (has(em, 'launchEncoder')) await un(em.launchEncoder()); } catch (e) {}

      var total = o.ranges.length;
      for (var r = 0; r < total; r++) {
        if (o.shouldStop && o.shouldStop()) { res.stopped = true; res.stoppedAt = r; break; }
        var rg = o.ranges[r];
        if (o.onProgress) o.onProgress(r, total, rg.label);
        var item = { label: rg.label, ok: false, ms: 0 };
        // Đặt in/out đúng frame, đọc lại kiểm.
        try { await setIO(mk(rg.inF), mk(rg.outF)); }
        catch (e) { item.error = 'Không đặt được in/out: ' + ((e && e.message) || e); item.noRange = true; res.renders.push(item); res.failed++; res.error = rg.label + ': ' + item.error; break; }
        var gi = ticksOf(await call(seq, 'getInPoint', null)), go = ticksOf(await call(seq, 'getOutPoint', null));
        var wi = String(Math.round(rg.inF * tb)), wo = String(Math.round(rg.outF * tb));
        if (gi !== wi || go !== wo) {
          var tol = tb / 2;
          if (Math.abs(Number(gi) - Number(wi)) > tol || Math.abs(Number(go) - Number(wo)) > tol) {
            item.error = 'In/out không vào đúng frame (' + gi + '/' + go + ')'; item.noRange = true; res.renders.push(item); res.failed++; res.error = rg.label + ': ' + item.error; break;
          }
          res.warnings.push(rg.label + ': in/out lệch dưới nửa frame');
        }
        var file = String(o.dir).replace(/\/$/, '') + '/' + rg.label + '.' + ext;
        await bridgePost('/rawcut/unlink', { path: file });
        var t0 = Date.now();
        var secs = (rg.outF - rg.inF) * tb / TPS;
        var got = await exportOne(em, seq, ET, file, preset, secs);
        if (!got.ok && r === 0 && o.stockPreset && preset !== o.stockPreset) {
          // Cut đầu lỗi với preset tự ghi → thử lại bằng preset gốc, dùng luôn cho cả lượt.
          preset = o.stockPreset; res.presetFallback = true;
          res.warnings.push('Preset bitrate tự ghi không render được — chuyển sang preset gốc.');
          got = await exportOne(em, seq, ET, file, preset, secs);
        }
        item.ms = Date.now() - t0;
        // Máy không cài Adobe Media Encoder: exportSequence của UXP cần AME kể cả khi render ngay
        // (IMMEDIATELY) → mọi cut đều lỗi y hệt. Dừng ở cut đầu, báo cách khắc phục một lần.
        if (!got.ok && AME_MISSING_RE.test(got.error || '')) {
          item.error = got.error; res.renders.push(item); res.failed++;
          res.noAme = true; res.error = AME_MISSING_MSG;
          break;
        }
        item.ok = got.ok; item.file = file; item.bytes = got.size;
        if (!got.ok) { item.error = got.error; res.failed++; } else res.written++;
        res.renders.push(item);
      }
      if (o.onProgress) o.onProgress(res.renders.length, total, '');
    } finally {
      // Chỉ trả in/out khi đã đổi (không thêm bước undo thừa). Cách trả giống Voice Changer
      // (vcxRenderSelection) — kể cả khi sequence chưa đặt in/out (giá trị âm của Premiere).
      if (textItems.length && (await setItemsDisabled(project, textItems, false)) !== textItems.length) {
        res.warnings.push('Có clip text chưa bật lại được — kiểm tra timeline (Clip → Enable).');
      }
      if (ioChanged) { try { if (origIn && origOut) await setIO(origIn, origOut); } catch (e) { res.warnings.push('Không trả lại in/out cũ: ' + ((e && e.message) || e)); } }
      for (var m = changed.length - 1; m >= 0; m--) {
        // Trạng thái cũ không rõ → trả về hiện (bản gốc để ẩn luôn là lỗi).
        var want = changed[m].was === null ? false : changed[m].was;
        try { await un(changed[m].track.setMute(want)); } catch (e) { res.warnings.push('Không khôi phục được mute của một track.'); }
      }
    }
    res.ok = res.stopped || (!o.ranges.length && !res.error) || (res.written > 0 && !res.renders.some(function (x) { return x.noRange; }));
    if (!res.ok && !res.stopped && !res.error) res.error = 'Premiere không render được cut nào';
    return res;
  }

  // exportSequence rồi chờ file có thật trên đĩa. IMMEDIATELY thường chỉ trả về khi đã ghi
  // xong (Voice Changer dựa vào đó) — vẫn chờ size đứng yên, hạn chờ theo độ dài cut.
  async function exportOne(em, seq, ET, file, preset, secs, statUrl) {
    var ret;
    try { ret = await un(em.exportSequence(seq, ET, file, preset, false)); }
    catch (e) { return { ok: false, error: 'exportSequence lỗi: ' + ((e && (e.message || e.code)) || e) }; }
    var limit = Date.now() + (ret === false ? 2000 : Math.max(60000, (secs || 0) * 10000));
    var last = -1, stable = 0;
    while (Date.now() < limit) {
      var stt = await bridgePost(statUrl || '/rawcut/stat', { path: file });
      if (stt && stt.exists && stt.size > 0) {
        if (stt.size === last) { if (++stable >= 2) return { ok: true, size: stt.size }; }
        else stable = 0;
        last = stt.size;
      }
      await sleep(last > 0 ? 300 : 200);
    }
    if (last > 0) return { ok: true, size: last };
    return { ok: false, error: ret === false ? 'Premiere từ chối export (preset?)' : 'Premiere không ghi ra file render' };
  }

  // ── Hàng loạt ──────────────────────────────────────────────────────────
  // Sequence đang chọn ở Project panel (cách tab RESIZE dùng), theo thứ tự chọn, bỏ trùng.
  async function selectedSequences() {
    var out = [], seen = {};
    try {
      if (!ppro.ProjectUtils || !has(ppro.ProjectUtils, 'getSelection')) return out;
      var project = await getActiveProject();
      var sel = await un(ppro.ProjectUtils.getSelection(project));
      var items = sel && has(sel, 'getItems') ? await un(sel.getItems()) : [];
      items = items ? Array.prototype.slice.call(items) : [];
      for (var i = 0; i < items.length; i++) {
        var cp = null;
        try { cp = ppro.ClipProjectItem.cast(items[i]); } catch (e) {}
        if (!cp || !(await call(cp, 'isSequence', false)) || !has(cp, 'getSequence')) continue;
        var sq = null;
        try { sq = await un(cp.getSequence()); } catch (e) {}
        var g = guidOf(sq);
        if (!sq || !g || seen[g]) continue;
        seen[g] = true;
        out.push(sq);
      }
    } catch (e) {}
    return out;
  }
  // Mở sequence lên timeline (để render đúng sequence) — chờ tới khi nó thành sequence đang mở.
  async function activate(seq) {
    if (!seq) return false;
    var project = await getActiveProject(), id = guidOf(seq);
    var isActive = async function () { try { return guidOf(await getActiveSequence()) === id; } catch (e) { return false; } };
    if (await isActive()) return true;
    try { if (has(project, 'openSequence')) await un(project.openSequence(seq)); } catch (e) {}
    try { if (!(await isActive()) && has(project, 'setActiveSequence')) await un(project.setActiveSequence(seq)); } catch (e) {}
    for (var i = 0; i < 20; i++) { if (await isActive()) return true; await sleep(150); }
    return false;
  }

  // ── Chẩn đoán (đọc, không sửa) ─────────────────────────────────────────
  async function diag() {
    var L = [];
    try {
      L.push('Premiere ' + hostVersion() + ' · ProjectConverter: ' + (ppro.ProjectConverter ? 'có' : 'KHÔNG') + ' · EncoderManager: ' + (ppro.EncoderManager ? 'có' : 'KHÔNG')
        + ' · TickTime.createWithTicks: ' + (ppro.TickTime && ppro.TickTime.createWithTicks ? 'có' : 'KHÔNG'));
      var r = await readSequence();
      L.push('Sequence "' + r.info.name + '" · ' + r.info.width + 'x' + r.info.height + ' · ' + (r.fps ? r.fps.toFixed(3) : '?') + ' fps · fp ' + r.fp);
      L.push('In/out: ' + (r.dump.sequence.in_point ? r.dump.sequence.in_point.seconds.toFixed(3) : '—') + ' → ' + (r.dump.sequence.out_point ? r.dump.sequence.out_point.seconds.toFixed(3) : '—'));
      var byTrack = {};
      r.dump.clips.forEach(function (c) { var k = (c.track_type === 'video' ? 'V' : 'A') + c.track_index; byTrack[k] = (byTrack[k] || 0) + 1; });
      L.push('Clip theo track: ' + JSON.stringify(byTrack));
      r.dump.clips.slice(0, 8).forEach(function (c, i) {
        L.push((i + 1) + '. ' + (c.track_type === 'video' ? 'V' : 'A') + c.track_index + ' "' + c.name + '" ' + c.start.seconds.toFixed(3) + '→' + c.end.seconds.toFixed(3)
          + ' in ' + c.in_point.seconds.toFixed(3) + ' out ' + c.out_point.seconds.toFixed(3) + ' speed ' + c.speed + (c.reversed ? ' REV' : '') + (c.disabled ? ' OFF' : '')
          + ' fps ' + c.interpretation.frame_rate + (c.project_item.is_sequence ? ' [NEST]' : '') + (c.project_item.is_offline ? ' [OFFLINE]' : '')
          + ' · ' + c.project_item.media_path.split('/').pop() + ' · ' + c.components.map(function (k) { return k.matchName; }).join(','));
      });
      if (r.warnings.length) L.push('Cảnh báo: ' + r.warnings.join(' | '));
    } catch (e) {
      L.push('LỖI: ' + ((e && e.message) || e));
    }
    return L.join('\n');
  }

  // Khối Render (tab Claude): xuất CẢ sequence ra một file (preset H.264 Match Source của bridge).
  // Đường dẫn file do caller quyết; thư mục phải có sẵn (bridge /render/prepare tạo).
  async function exportFile(seq, file, preset) {
    if (!ppro.EncoderManager || !ppro.EncoderManager.getManager) return { ok: false, error: 'Premiere bản này không có EncoderManager (cần ≥ 25.6)' };
    var em = ppro.EncoderManager.getManager();
    var ET = ppro.Constants && ppro.Constants.ExportType && ppro.Constants.ExportType.IMMEDIATELY;
    var secs = 0;
    try { var end = await call(seq, 'getEndTime', null); secs = end ? Number(await call(end, 'seconds', 0)) || Number(end.seconds) || 0 : 0; } catch (e) {}
    var r = await exportOne(em, seq, ET, file, preset, secs || 120, '/render/stat');
    if (!r.ok && AME_MISSING_RE.test(r.error || '')) r.error = AME_MISSING_MSG.replace('Timeline Render (edited/)', 'Render');
    return r;
  }

  return { exportFile: exportFile, readSequence: readSequence, exportXml: exportXml, stamp: stamp, renderRanges: renderRanges, diag: diag,
           selectedSequences: selectedSequences, activate: activate, guidOf: guidOf,
           _text: { collect: collectText, setDisabled: setItemsDisabled } };   // _text: cho dev.sh eval kiểm tra
})();
