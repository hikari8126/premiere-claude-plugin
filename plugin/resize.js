// plugin/resize.js — tab Resize: nhân bản sequence sang các ratio khác trong một cú bấm.
//
// Port từ 1-Click Resizer (CEP/ExtendScript, v1.10.3) —
// https://github.com/tungnguyen1202/1-click-resizer — sang UXP.
// Logic thuần (ratio, đặt tên, chọn đích, logo) ở resize-core.js (global RSZ);
// file này chỉ lo gọi Premiere + giao diện tab.
//
// Classic script, nạp SAU main.js nên dùng chung global scope của main.js:
//   ppro, getActiveProject, getActiveSequence, getClipItems, claimKeyboard/releaseKeyboard.
//
// Một cú RESIZE, với từng sequence nguồn × từng ratio đích:
//   createCloneAction → tìm bản sao (so guid trước/sau) → đổi frame size → đổi tên
//   → về đúng bin của nguồn → text/graphic/MOGRT canh Y theo guide của ratio đó.
//   Nền (track nền, mặc định V1), logo và audio giữ nguyên. Nguồn không bao giờ bị sửa.

(function () {
  'use strict';

  var LS_KEY = 'rsz_prefs';
  var POLL_MS = 1000;

  var MODE_SUB = {
    GG: 'Google · 9:16 / 4:5 / 1:1',
    FB: 'Facebook · 9:16 / 4:5',
    PIN: 'Pinterest · 2:3'
  };
  var CHIP_LABEL = { '9-16': '9:16', '4-5': '4:5', '1-1': '1:1', '2-3': '2:3' };

  var rszState = {
    prefs: null,
    busy: false,
    polling: false,
    pollTimer: null,
    lastInfoKey: null,
    srcRatios: [],       // ratio các nguồn đang chọn → ẩn chip trùng ratio nguồn
    seqByItemId: null,   // cache projectItem id → Sequence
    pending: null,       // R3: kế hoạch đã xem trước, chờ bấm lần 2 { sig, plan, count, at }
  };

  function $(id) { return document.getElementById(id); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Đồng hồ canh: lệnh Premiere đôi khi không bao giờ trả về (lượt resize đứng mãi, không báo
  // lỗi). Mỗi bước ghi tên + giờ bắt đầu; runResize thấy một bước quá STEP_LIMIT_MS thì dừng lượt
  // và báo đúng bước đó. ResizeAPI.status() để dò khi cần.
  var STEP_LIMIT_MS = 60000;
  var rzStepNow = { step: '', since: 0 };
  function rzStep(label) {
    rzStepNow = { step: label, since: Date.now() };
    console.log('[Resize] ' + label);
  }
  async function un(v) { return (v && typeof v.then === 'function') ? await v : v; }
  async function awaitArray(v) {
    v = await un(v);
    if (!v) return [];
    if (Array.isArray(v)) return v;
    var n = v.length || 0, out = [];
    for (var i = 0; i < n; i++) out.push(v[i]);
    return out;
  }
  function clamp01(v) { v = parseFloat(v); return isNaN(v) ? 0.5 : (v < 0 ? 0 : (v > 1 ? 1 : v)); }

  // ── Prefs (localStorage — một lần, dùng cho mọi project) ─────────────────
  function loadPrefs() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) {}
    var g = s.guide || {}, r = s.ratios || {};
    var bg = parseInt(s.bgTrack, 10);
    return {
      bgTrack: (bg && bg > 0) ? bg : 1,
      guide: { '9-16': clamp01(g['9-16']), '4-5': clamp01(g['4-5']),
               '1-1': clamp01(g['1-1']), '2-3': clamp01(g['2-3']) },
      mode: (s.mode === 'FB' || s.mode === 'PIN') ? s.mode : 'GG',
      auto: s.auto !== false,
      ratios: { '9-16': r['9-16'] !== false, '4-5': r['4-5'] !== false, '1-1': r['1-1'] !== false },
    };
  }
  function savePrefs() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(rszState.prefs)); } catch (e) {}
  }

  // ── Premiere helpers ────────────────────────────────────────────────────
  // Bắt lỗi BÊN TRONG lockedAccess — throw lọt ra ngoài lock có thể làm treo
  // Premiere (giống sacCommitTx ở main.js).
  async function commit(project, fn, label) {
    var err = null;
    var r = project.lockedAccess(function () {
      try { project.executeTransaction(fn, label || 'Resize'); }
      catch (e) { err = e; }
    });
    if (r && typeof r.then === 'function') await r;
    if (err) throw err;
  }

  function guidOf(seq) {
    try { var g = seq && seq.guid; return g ? String(g.toString ? g.toString() : g) : ''; }
    catch (e) { return ''; }
  }

  async function nameOf(obj) {
    try {
      var n = obj && obj.name;
      if (n && typeof n.then === 'function') n = await n;
      if (!n && obj && typeof obj.getName === 'function') n = await un(obj.getName());
      return String(n || '');
    } catch (e) { return ''; }
  }

  async function itemIdOf(pi) {
    try { return pi && typeof pi.getId === 'function' ? String(await un(pi.getId())) : ''; }
    catch (e) { return ''; }
  }

  async function projectItemOf(seq) {
    try { return await un(seq.getProjectItem()); } catch (e) { return null; }
  }

  async function frameSizeOf(seq) {
    try {
      var r = await un(seq.getFrameSize());
      if (r && r.width > 0 && r.height > 0) return { w: Math.round(r.width), h: Math.round(r.height) };
    } catch (e) {}
    try {
      var st = await un(seq.getSettings());
      var rc = await un(st.getVideoFrameRect());
      if (rc) return { w: Math.round(rc.width), h: Math.round(rc.height) };
    } catch (e2) {}
    return { w: 0, h: 0 };
  }

  async function listSequences(project) {
    try { return await awaitArray(project.getSequences()); } catch (e) { return []; }
  }

  // projectItem id → Sequence, dựng lại khi cache hụt (sequence mới, project khác).
  async function buildSeqMap(project) {
    var map = {};
    var seqs = await listSequences(project);
    for (var i = 0; i < seqs.length; i++) {
      var id = await itemIdOf(await projectItemOf(seqs[i]));
      if (id) map[id] = seqs[i];
    }
    rszState.seqByItemId = map;
    return map;
  }

  async function seqFromProjectItem(project, item, cp) {
    var id = await itemIdOf(item);
    var map = rszState.seqByItemId;
    if (id && (!map || !map[id])) map = await buildSeqMap(project);
    if (id && map && map[id]) return map[id];
    try { if (cp && typeof cp.getSequence === 'function') { var s = await un(cp.getSequence()); if (s) return s; } }
    catch (e) {}
    var nm = await nameOf(item);                            // lượt cuối: theo tên
    var seqs = await listSequences(project);
    for (var i = 0; i < seqs.length; i++) { if (await nameOf(seqs[i]) === nm) return seqs[i]; }
    return null;
  }

  // MỌI sequence đang chọn ở Project panel (không cần mở), theo thứ tự chọn, bỏ trùng.
  // Không chọn gì → dùng sequence đang mở trên timeline. Trả { seqs, from }.
  async function resolveSources(project) {
    var out = [], seen = {};
    try {
      if (ppro.ProjectUtils && typeof ppro.ProjectUtils.getSelection === 'function') {
        var sel = await un(ppro.ProjectUtils.getSelection(project));
        var items = sel ? await awaitArray(sel.getItems()) : [];
        for (var i = 0; i < items.length; i++) {
          var cp = null;
          try { cp = ppro.ClipProjectItem.cast(items[i]); } catch (e) {}
          var isSeq = false;
          try { isSeq = !!(cp && await un(cp.isSequence())); } catch (e2) {}
          if (!isSeq) continue;
          var s = await seqFromProjectItem(project, items[i], cp);
          var g = s ? guidOf(s) : '';
          if (!s || (g && seen[g])) continue;
          if (g) seen[g] = true;
          out.push(s);
        }
      }
    } catch (e3) { console.warn('[Resize] đọc selection Project panel lỗi:', e3 && e3.message); }
    if (out.length) return { seqs: out, from: 'selection' };
    try { var a = await getActiveSequence(); if (a) return { seqs: [a], from: 'active' }; } catch (e4) {}
    return { seqs: [], from: 'none' };
  }

  // createCloneAction không trả về sequence mới → so danh sách guid trước/sau.
  async function cloneSequence(project, seq) {
    var before = {};
    (await listSequences(project)).forEach(function (s) { before[guidOf(s)] = true; });
    await commit(project, function (ca) { ca.addAction(seq.createCloneAction()); }, 'Resize: nhân bản sequence');
    for (var t = 0; t < 12; t++) {
      var list = await listSequences(project);
      for (var i = 0; i < list.length; i++) { if (!before[guidOf(list[i])]) return list[i]; }
      await sleep(150);
    }
    return null;
  }

  // Đổi frame size rồi đọc lại để chắc Premiere không lặng lẽ bỏ qua.
  async function setFrameSize(project, seq, w, h) {
    var st = await un(seq.getSettings());
    var rc = await un(st.getVideoFrameRect());
    rc.width = w; rc.height = h;
    await un(st.setVideoFrameRect(rc));
    await commit(project, function (ca) { ca.addAction(seq.createSetSettingsAction(st)); }, 'Resize: đổi khung');
    var chk = await frameSizeOf(seq);
    return chk.w === w && chk.h === h;
  }

  async function renameSeq(project, seq, name) {
    var pi = await projectItemOf(seq);
    var target = (pi && typeof pi.createSetNameAction === 'function') ? pi
               : (typeof seq.createSetNameAction === 'function' ? seq : null);
    if (!target) return false;
    await commit(project, function (ca) { ca.addAction(target.createSetNameAction(name)); }, 'Resize: đổi tên');
    return true;
  }

  async function binIdOf(bin) {
    try { return await itemIdOf(ppro.ProjectItem.cast(bin)); } catch (e) { return ''; }
  }

  // Id của gốc project. Premiere không có Constants.ProjectItemType (chẩn đoán
  // 25.x: ROOT=undefined) nên nhận gốc bằng cách so id với getRootItem().
  async function rootIdOf(project) {
    try { return await binIdOf(await un(project.getRootItem())); } catch (e) { return ''; }
  }

  // Bin trực tiếp chứa item; null khi nằm ở gốc project (hoặc không đọc được).
  async function parentBinOf(pi, rootId) {
    try {
      var b = pi && typeof pi.getParentBin === 'function' ? await un(pi.getParentBin()) : null;
      if (!b) return null;
      if (rootId && (await binIdOf(b)) === rootId) return null;
      return b;
    } catch (e) { return null; }
  }

  // Đưa sequence mới về bin của nguồn. Trả tên bin nếu đã chuyển (hoặc vốn đã ở đó).
  async function moveToBin(project, seq, destBin, destBinId) {
    if (!destBin) return '';
    var pi = await projectItemOf(seq);
    if (!pi) return '';
    var cur = await parentBinOf(pi, '');
    if (cur && destBinId && (await binIdOf(cur)) === destBinId) return await nameOf(destBin);
    var folder = ppro.FolderItem.cast(destBin) || destBin;
    if (typeof folder.createMoveItemAction !== 'function') return '';
    await commit(project, function (ca) { ca.addAction(folder.createMoveItemAction(pi, folder)); }, 'Resize: vào bin');
    return await nameOf(destBin);
  }

  // Tên + matchName mọi component của clip (dùng để nhận diện graphic + chẩn đoán).
  async function componentsOf(clip) {
    var out = [];
    var chain = await un(clip.getComponentChain());
    if (!chain) return out;
    var n = await un(chain.getComponentCount());
    for (var i = 0; i < n; i++) {
      var c = await un(chain.getComponentAtIndex(i));
      if (!c) continue;
      var mn = '', dn = '';
      try { mn = String(await un(c.getMatchName()) || ''); } catch (e) {}
      try { dn = String(await un(c.getDisplayName()) || ''); } catch (e2) {}
      var params = [];
      if (/capsule/i.test(mn)) {          // MOGRT: tên param để biết có chữ không
        var pc = await un(c.getParamCount());
        for (var k = 0; k < pc; k++) {
          try { var p = await un(c.getParam(k)); if (p) params.push(await paramName(p)); } catch (e3) {}
        }
      }
      out.push({ comp: c, matchName: mn, displayName: dn, params: params });
    }
    return out;
  }

  async function paramName(p) {
    try {
      if (typeof p.getDisplayName === 'function') return String(await un(p.getDisplayName()) || '');
      return String(p.displayName || '');
    } catch (e) { return ''; }
  }

  // Motion > Position. Tìm component theo matchName/displayName "Motion" (không phải
  // "Vector Motion"), param theo tên "Position"; không đọc được tên thì lấy param 0.
  async function motionPositionOf(comps) {
    for (var i = 0; i < comps.length; i++) {
      var c = comps[i];
      var isMotion = /ADBE Motion$/i.test(c.matchName) || c.displayName === 'Motion';
      if (!isMotion) continue;
      var n = await un(c.comp.getParamCount());
      var first = null;
      for (var k = 0; k < n; k++) {
        var p = await un(c.comp.getParam(k));
        if (!p) continue;
        if (!first) first = p;
        if ((await paramName(p)) === 'Position') return p;
      }
      return first;
    }
    return null;
  }

  async function readPoint(param, atTime) {
    try {
      var v = await un(param.getValueAtTime(atTime));
      var val = v && v.value !== undefined ? v.value : v;
      if (val && val.length === 2) return [Number(val[0]), Number(val[1])];
      if (val && typeof val.x === 'number') return [val.x, val.y];
    } catch (e) {}
    try {
      var kf = await un(param.getStartValue());
      var sv = kf && kf.value;
      sv = sv && sv.value !== undefined ? sv.value : sv;
      if (sv && sv.length === 2) return [Number(sv[0]), Number(sv[1])];
      if (sv && typeof sv.x === 'number') return [sv.x, sv.y];
    } catch (e2) {}
    return null;
  }

  // Text/graphic/MOGRT giữ scale + X, chỉ đặt Y theo guide. Nền + logo để nguyên.
  // Position có keyframe thì bỏ qua (đè một giá trị sẽ phá animation) và đếm riêng.
  async function layoutClips(project, dup, bgTrack, guide, frameH) {
    var res = { moved: 0, keyframed: 0, failed: 0 };
    var n = await un(dup.getVideoTrackCount());
    var bgIndex = bgTrack - 1;
    if (bgIndex < 0 || bgIndex >= n) bgIndex = 0;   // track nền không có → coi V1 là nền
    for (var vt = 0; vt < n; vt++) {
      if (vt === bgIndex) continue;
      var track = await un(dup.getVideoTrack(vt));
      var clips = await getClipItems(track);
      for (var c = 0; c < clips.length; c++) {
        var clip = clips[c];
        rzStep('canh text V' + (vt + 1) + ' clip ' + (c + 1) + '/' + clips.length);
        try {
          if (RSZ.isLogoName(await nameOf(clip))) continue;
          var comps = await componentsOf(clip);
          if (!RSZ.isTextClip(comps)) continue;
          var pos = await motionPositionOf(comps);
          if (!pos) continue;
          if (pos.isTimeVarying && pos.isTimeVarying()) { res.keyframed++; continue; }
          var cur = await readPoint(pos, await un(clip.getInPoint()));
          if (!cur) { res.failed++; continue; }
          var y = RSZ.positionY(guide, cur, frameH);
          if (Math.abs(cur[1] - y) < 1e-6) continue;
          var kf = pos.createKeyframe(new ppro.PointF(cur[0], y));
          await commit(project, function (ca) { ca.addAction(pos.createSetValueAction(kf, true)); }, 'Resize: canh text');
          res.moved++;
        } catch (e) {
          res.failed++;
          console.warn('[Resize] canh clip lỗi:', e && e.message);
        }
      }
    }
    return res;
  }

  // Một bản: nhân bản → khung → tên → bin → canh clip. Lỗi chỉ hỏng dòng này.
  async function makeVariant(project, job, tgtRatio, platform, prefs) {
    var tgt = RSZ.RATIOS[tgtRatio];
    var name = RSZ.buildName(job.name, tgtRatio, platform);
    var out = { ratio: tgtRatio, src: job.name };
    var dup = null;
    try {
      rzStep(name + ' · nhân bản');
      dup = await cloneSequence(project, job.seq);
      if (!dup) { out.error = 'Không nhân bản được sequence'; return out; }
      // Đổi tên TRƯỚC để bản dở dang (nếu khung lỗi) vẫn mang tên dễ nhận ra.
      rzStep(name + ' · đổi tên');
      try { await renameSeq(project, dup, name); } catch (e) { console.warn('[Resize] đổi tên lỗi:', e && e.message); }
      out.name = name;
      rzStep(name + ' · đổi khung ' + tgt.w + '×' + tgt.h);
      if (!(await setFrameSize(project, dup, tgt.w, tgt.h))) {
        out.error = 'Premiere không nhận frame size ' + tgt.w + '×' + tgt.h;
        out.orphan = name;
        return out;
      }
      rzStep(name + ' · chuyển bin');
      try { out.bin = await moveToBin(project, dup, job.bin, job.binId); }
      catch (e2) { out.binError = e2 && e2.message; }
      var lay = await layoutClips(project, dup, prefs.bgTrack, prefs.guide[tgtRatio], tgt.h);
      out.moved = lay.moved; out.keyframed = lay.keyframed; out.layoutFailed = lay.failed;
      return out;
    } catch (e3) {
      out.error = String((e3 && e3.message) || e3);
      if (dup) out.orphan = out.name || (await nameOf(dup));
      return out;
    }
  }

  // Chụp danh tính mọi nguồn TRƯỚC khi nhân bản — clone làm project đổi, selection
  // ở Project panel có thể nhảy mất.
  async function snapshotJobs(project, seqs) {
    var jobs = [];
    var rootId = await rootIdOf(project);
    for (var i = 0; i < seqs.length; i++) {
      var seq = seqs[i];
      var g = await frameSizeOf(seq);
      var pi = await projectItemOf(seq);
      var bin = await parentBinOf(pi, rootId);
      jobs.push({ seq: seq, name: await nameOf(seq), width: g.w, height: g.h,
                  ratio: RSZ.detectRatio(g.w, g.h), bin: bin, binId: bin ? await binIdOf(bin) : '' });
    }
    return jobs;
  }

  // R3: lập kế hoạch (chưa đụng project) để xem trước + đánh dấu tên trùng.
  // seqs: danh sách Sequence truyền thẳng (tab Claude) — bỏ trống thì lấy selection / timeline.
  async function planResize(platform, wanted, seqs) {
    var project = await getActiveProject();
    var src = (seqs && seqs.length) ? { seqs: seqs, from: 'claude' } : await resolveSources(project);
    if (!src.seqs.length) return { ok: false, error: 'Chưa chọn hoặc mở sequence nào' };
    var jobs = await snapshotJobs(project, src.seqs);
    var plan = [];
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      if (platform !== 'PIN' && !j.ratio) {
        plan.push({ src: j.name, skip: 'ratio nguồn ' + j.width + '×' + j.height + ' không thuộc 9:16 / 4:5 / 1:1' }); continue;
      }
      if (platform === 'PIN' && RSZ.matchesRatio(j.width, j.height, '2-3')) {
        plan.push({ src: j.name, skip: 'nguồn đã là 2:3 — PIN không tạo thêm bản trùng' }); continue;
      }
      var targets = RSZ.targetsFor(platform, j.ratio, wanted);
      if (!targets.length) {
        plan.push({ src: j.name, skip: 'không còn size nào được tick cho nguồn này' }); continue;
      }
      for (var t = 0; t < targets.length; t++) {
        plan.push({ job: j, src: j.name, ratio: targets[t], name: RSZ.buildName(j.name, targets[t], platform) });
      }
    }
    var names = [];
    var all = await listSequences(project);
    for (var k = 0; k < all.length; k++) names.push(await nameOf(all[k]));
    return { ok: true, count: jobs.length, plan: RSZ.markPlanDuplicates(plan, names) };
  }

  var DUP_SKIP = 'đã có sequence cùng tên — bỏ qua (xoá bản cũ nếu muốn tạo lại)';

  function withWatchdog(work, p) {
    return new Promise(function (resolve) {
      var t = setInterval(function () {
        var waited = Date.now() - rzStepNow.since;
        if (waited < STEP_LIMIT_MS) return;
        clearInterval(t);
        console.warn('[Resize] KẸT ở bước "' + rzStepNow.step + '" sau ' + Math.round(waited / 1000) + 's');
        resolve({ src: p.src, ratio: p.ratio, name: p.name, hung: true, orphan: p.name,
                  error: 'Premiere không phản hồi ở bước "' + rzStepNow.step + '" (' + Math.round(waited / 1000) + 's) — đã dừng lượt; kiểm tra bản dở dang rồi chạy lại' });
      }, 1000);
      work.then(function (r) { clearInterval(t); resolve(r); },
                function (e) { clearInterval(t); resolve({ src: p.src, ratio: p.ratio, name: p.name, error: String((e && e.message) || e) }); });
    });
  }

  // opts.destBin (đường dẫn "Sequence / PIN / Order …"): bản mới vào bin này thay vì bin của nguồn.
  async function runResize(platform, plan, prefs, onRow, opts) {
    var project = await getActiveProject();
    if (opts && opts.destBin) {
      var dest = await ppGetOrCreateBin(project, opts.destBin);
      if (!dest) throw new Error('không tạo được bin ' + opts.destBin);
      var destId = await binIdOf(dest);
      plan.forEach(function (p) { if (p.job) { p.job.bin = dest; p.job.binId = destId; } });
    }
    var results = [];
    for (var i = 0; i < plan.length; i++) {
      var p = plan[i];
      if (p.skip) { results.push(p); onRow(p); continue; }
      if (p.exists || p.dupInPlan) {
        var rd = { src: p.src, ratio: p.ratio, name: p.name, skip: p.exists ? DUP_SKIP : 'trùng tên với bản khác trong lượt này — bỏ qua' };
        results.push(rd); onRow(rd); continue;
      }
      rzStep(p.name + ' · bắt đầu');
      var r = await withWatchdog(makeVariant(project, p.job, p.ratio, platform, prefs), p);
      results.push(r); onRow(r);
      if (r.hung) {                                  // Premiere kẹt → không chạy tiếp các bản sau
        for (var k = i + 1; k < plan.length; k++) {
          var q = plan[k], rs = { src: q.src, ratio: q.ratio, name: q.name, skip: 'chưa chạy — lượt dừng vì Premiere không phản hồi' };
          results.push(rs); onRow(rs);
        }
        break;
      }
    }
    rszState.seqByItemId = null;   // project vừa có thêm sequence
    return { ok: true, results: results };
  }

  // ── Nhận diện nguồn (hiện trên đầu tab) ─────────────────────────────────
  async function readSourceInfo() {
    var project = await getActiveProject();
    var src = await resolveSources(project);
    if (!src.seqs.length) return { from: 'none', count: 0 };
    var first = src.seqs[0];
    var g = await frameSizeOf(first);
    var ratios = [], seen = {};
    if (src.seqs.length <= 20) {
      for (var i = 0; i < src.seqs.length; i++) {
        var gg = i === 0 ? g : await frameSizeOf(src.seqs[i]);
        var rr = RSZ.detectRatio(gg.w, gg.h);
        if (rr && !seen[rr]) { seen[rr] = true; ratios.push(rr); }
      }
    }
    return { from: src.from, count: src.seqs.length, name: await nameOf(first),
             width: g.w, height: g.h, label: RSZ.describeRatio(g.w, g.h), ratios: ratios };
  }

  function paintSource(info) {
    var dot = $('rszDot'), st = $('rszState'), nm = $('rszSrcName');
    var ratio = $('rszRatio'), size = $('rszSize'), box = $('rszBox');
    var from = info ? info.from : 'none';
    dot.className = 'wf-dot' + (from === 'selection' ? ' ok' : from === 'active' ? ' pause' : ' err');
    st.textContent = from === 'selection' ? ('ĐÃ CHỌN' + (info.count > 1 ? ' · ' + info.count : ''))
                   : from === 'active' ? 'ĐANG MỞ (chưa chọn ở Project panel)'
                   : 'CHƯA CHỌN SEQUENCE';
    if (info && info.name) {
      nm.textContent = info.name + (info.count > 1 ? '  · +' + (info.count - 1) + ' sequence nữa' : '');
      nm.classList.remove('is-empty');
      ratio.textContent = info.label || '—';
      size.textContent = info.width + ' × ' + info.height;
      var h = 34, w = Math.round(h * (info.width / Math.max(1, info.height)));
      box.style.height = h + 'px';
      box.style.width = Math.max(10, Math.min(60, w)) + 'px';
      box.classList.remove('is-empty');
    } else {
      nm.textContent = 'Chọn sequence ở Project panel (chọn nhiều cũng được)';
      nm.classList.add('is-empty');
      ratio.textContent = '—';
      size.textContent = '';
      box.style.width = ''; box.style.height = '';
      box.classList.add('is-empty');
    }
  }

  async function refreshSource(force) {
    if (rszState.polling || rszState.busy) return;
    rszState.polling = true;
    try {
      var info = await readSourceInfo();
      var key = JSON.stringify(info);
      if (force || key !== rszState.lastInfoKey) {
        // Nguồn đổi sau khi xem trước → danh sách cũ không còn đúng (R3).
        if (key !== rszState.lastInfoKey && rszState.pending) {
          clearPending();
          setStatus('Nguồn đã đổi — bấm RESIZE để xem lại danh sách.');
        }
        rszState.lastInfoKey = key;
        paintSource(info);
        var seen = (info.ratios || []).join(',');
        if (seen !== rszState.srcRatios.join(',')) {
          rszState.srcRatios = info.ratios || [];
          renderChips();
        }
      }
    } catch (e) {
      if (force) paintSource(null);
    } finally {
      rszState.polling = false;
    }
  }

  function tabActive() {
    var p = $('tab-resize');
    return !!(p && p.classList.contains('active'));
  }

  function setAuto(on) {
    rszState.prefs.auto = !!on;
    savePrefs();
    if (rszState.pollTimer) { clearInterval(rszState.pollTimer); rszState.pollTimer = null; }
    if (on) {
      rszState.pollTimer = setInterval(function () { if (tabActive()) refreshSource(false); }, POLL_MS);
    }
    var b = $('rszAuto');
    b.textContent = on ? 'AUTO' : 'AUTO TẮT';
    b.classList.toggle('is-off', !on);
  }

  // ── Mode / chip ─────────────────────────────────────────────────────────
  function tickedTargets(mode) {
    var all = RSZ.PLATFORM_TARGETS[mode] || [];
    if (mode === 'PIN') return all.slice();
    var on = rszState.prefs.ratios;
    return all.filter(function (k) { return on[k] !== false; });
  }

  // Chip trùng ratio nguồn ẩn đi — trừ khi chọn nhiều nguồn khác ratio, vì ratio
  // là nguồn của sequence này vẫn là đích thật của sequence kia.
  function visibleTargets(mode) {
    var src = rszState.srcRatios;
    return (RSZ.PLATFORM_TARGETS[mode] || []).filter(function (k) {
      return !(src.length === 1 && src[0] === k);
    });
  }

  function renderChips() {
    var box = $('rszChips');
    var mode = rszState.prefs.mode;
    box.innerHTML = '';
    if (mode === 'PIN') { box.style.display = 'none'; return; }
    var all = visibleTargets(mode);
    box.style.display = all.length ? 'flex' : 'none';
    all.forEach(function (key) {
      var b = document.createElement('div');
      b.setAttribute('role', 'button');
      var on = rszState.prefs.ratios[key] !== false;
      b.className = 'rsz-chip' + (on ? ' on' : '');
      b.textContent = (on ? '✓ ' : '') + CHIP_LABEL[key];
      b.addEventListener('click', function () {
        rszState.prefs.ratios[key] = !on;
        savePrefs();
        clearPending();
        renderChips();
      });
      box.appendChild(b);
    });
  }

  function renderMode() {
    var mode = rszState.prefs.mode;
    if (rszState.pending) clearPending();
    document.querySelectorAll('#rszModes .rsz-seg').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-mode') === mode);
    });
    $('rszGoSub').textContent = MODE_SUB[mode];
    renderChips();
  }

  // ── Kết quả ─────────────────────────────────────────────────────────────
  function addRow(r) {
    var outs = $('rszOuts');
    var row = document.createElement('div');
    var ok = !r.error && !r.skip;
    if (r.preview) {
      // Dòng xem trước (R3): sẽ tạo / trùng tên bị bỏ qua.
      var willMake = !r.skip && !r.exists && !r.dupInPlan;
      row.className = 'rsz-row' + (willMake ? '' : ' is-skip');
      var pt = document.createElement('div');
      pt.className = 'rsz-row-head';
      var ptt = document.createElement('div'); ptt.className = 'rsz-row-title'; ptt.textContent = r.name || r.src || '';
      var pb = document.createElement('span'); pb.className = 'rsz-row-badge';
      pb.textContent = willMake ? 'SẼ TẠO' : 'BỎ QUA';
      pt.appendChild(ptt); pt.appendChild(pb);
      var ps = document.createElement('div'); ps.className = 'rsz-row-sub';
      ps.textContent = r.skip ? r.skip
        : (r.ratio ? CHIP_LABEL[r.ratio] + ' · ' : '') + 'từ ' + r.src
          + (r.exists ? ' · ' + DUP_SKIP : r.dupInPlan ? ' · trùng tên với bản khác trong lượt này' : '');
      row.appendChild(pt); row.appendChild(ps);
      outs.appendChild(row);
      return;
    }
    row.className = 'rsz-row' + (ok ? '' : r.skip ? ' is-skip' : ' is-err');
    var title = document.createElement('div');
    title.className = 'rsz-row-title';
    title.textContent = r.name || r.src || CHIP_LABEL[r.ratio] || '';
    var badge = document.createElement('span');
    badge.className = 'rsz-row-badge';
    badge.textContent = ok ? 'XONG' : r.skip ? 'BỎ QUA' : 'LỖI';
    var head = document.createElement('div');
    head.className = 'rsz-row-head';
    head.appendChild(title); head.appendChild(badge);
    var sub = document.createElement('div');
    sub.className = 'rsz-row-sub';
    var parts = [];
    if (r.ratio) parts.push(CHIP_LABEL[r.ratio]);
    if (ok) {
      parts.push(r.moved ? 'đã canh ' + r.moved + ' lớp text' : 'không có text cần canh');
      if (r.keyframed) parts.push(r.keyframed + ' lớp có keyframe Position — để nguyên');
      if (r.layoutFailed) parts.push(r.layoutFailed + ' lớp canh lỗi');
      parts.push(r.bin ? 'bin: ' + r.bin : (r.binError ? 'không chuyển được bin' : 'ở gốc project'));
    } else if (r.skip) {
      parts.push(r.skip);
    } else {
      parts.push(r.error);
      if (r.orphan) parts.push('bản dở dang: ' + r.orphan + ' — xoá tay');
    }
    sub.textContent = parts.join(' · ');
    row.appendChild(head); row.appendChild(sub);
    outs.appendChild(row);
  }

  function setStatus(msg) { $('rszStatus').textContent = msg || ''; }

  function setBusy(busy) {
    rszState.busy = busy;
    $('rszGo').classList.toggle('is-busy', busy);
    $('rszGoLabel').textContent = busy ? 'ĐANG RESIZE…' : 'RESIZE';
  }

  function clearPending() {
    if (rszState.pending && rszState.pending.timer) clearTimeout(rszState.pending.timer);
    rszState.pending = null;
    if (!rszState.busy) $('rszGoLabel').textContent = 'RESIZE';
  }

  // Bấm lần 1 = xem trước danh sách sẽ tạo (tên trùng bị bỏ qua); bấm lần 2 trong 30s
  // (cùng chế độ + size) mới tạo thật (R3).
  async function onGo() {
    if (rszState.busy) return;
    var mode = rszState.prefs.mode;
    var wanted = tickedTargets(mode);
    var pickable = visibleTargets(mode);
    var anyVisible = pickable.some(function (k) { return wanted.indexOf(k) !== -1; });
    if (!wanted.length || (pickable.length && !anyVisible)) { setStatus('Chưa tick size nào để tạo.'); return; }
    var sig = mode + '|' + wanted.join(',');
    var pend = rszState.pending;
    if (pend && pend.sig === sig) {
      clearPending();
      $('rszOuts').innerHTML = '';
      setStatus('Đang xử lý…');
      setBusy(true);
      try {
        var res = await runResize(mode, pend.plan, rszState.prefs, addRow);
        var made = res.results.filter(function (r) { return !r.error && !r.skip; }).length;
        var bad = res.results.length - made;
        setStatus(pend.count + ' sequence nguồn · tạo ' + made + ' bản' + (bad ? ' · ' + bad + ' lỗi/bỏ qua' : ''));
      } catch (e) {
        setStatus('Lỗi: ' + ((e && e.message) || e));
      } finally {
        setBusy(false);
        refreshSource(true);
      }
      return;
    }
    clearPending();
    $('rszOuts').innerHTML = '';
    setStatus('Đang lập danh sách…');
    setBusy(true);
    var pl;
    try { pl = await planResize(mode, wanted); }
    catch (e) { pl = { ok: false, error: 'Lỗi: ' + ((e && e.message) || e) }; }
    finally { setBusy(false); }
    if (!pl.ok) { setStatus(pl.error); return; }
    pl.plan.forEach(function (p) { var q = {}; for (var k in p) q[k] = p[k]; q.preview = true; addRow(q); });
    var n = pl.plan.filter(function (p) { return !p.skip && !p.exists && !p.dupInPlan; }).length;
    var dup = pl.plan.filter(function (p) { return p.exists || p.dupInPlan; }).length;
    if (!n) { setStatus('Không có bản nào để tạo' + (dup ? ' — ' + dup + ' bản đã có sequence cùng tên' : '') + '.'); return; }
    rszState.pending = { sig: sig, plan: pl.plan, count: pl.count,
      timer: setTimeout(function () { clearPending(); setStatus('Hết 30s — bấm RESIZE để xem lại danh sách.'); }, 30000) };
    $('rszGoLabel').textContent = 'TẠO ' + n + ' BẢN';
    setStatus('Xem trước: sẽ tạo ' + n + ' bản' + (dup ? ' · bỏ qua ' + dup + ' bản trùng tên' : '')
      + '. Bấm "TẠO ' + n + ' BẢN" để làm (trong 30s).');
  }

  // ── Cài đặt (tab Resize trong Settings dùng chung) ─────────────────────
  var GUIDE_RATIOS = ['9-16', '4-5', '1-1', '2-3'];
  var GUIDE_FRAME_H = 76;   // 4 khung cùng cao, rộng theo ratio → vừa settings box ~300px
  var BG_MAX = 20;

  function paintBg() { $('rszBgVal').textContent = 'V' + rszState.prefs.bgTrack; }
  function stepBg(d) {
    var v = rszState.prefs.bgTrack + d;
    rszState.prefs.bgTrack = v < 1 ? 1 : (v > BG_MAX ? BG_MAX : v);
    savePrefs();
    paintBg();
  }

  function paintGuide(ratio) {
    var card = document.querySelector('#rszGuides .rsz-gcard[data-ratio="' + ratio + '"]');
    if (!card) return;
    var v = rszState.prefs.guide[ratio];
    card.querySelector('.rsz-gline').style.top = (v * 100) + '%';
    card.querySelector('.rsz-gval').textContent = Math.round(v * 100) + '%';
  }

  function setGuide(ratio, v) {
    rszState.prefs.guide[ratio] = Math.round(clamp01(v) * 100) / 100;
    savePrefs();
    paintGuide(ratio);
  }

  // Mỗi ratio một khung: kéo trong khung đặt guide, −/+ chỉnh 1%.
  function buildGuides() {
    var box = $('rszGuides');
    box.innerHTML = '';
    GUIDE_RATIOS.forEach(function (ratio) {
      var dims = RSZ.RATIOS[ratio];
      var card = document.createElement('div');
      card.className = 'rsz-gcard';
      card.setAttribute('data-ratio', ratio);
      card.innerHTML =
        '<div class="rsz-gframe"><div class="rsz-gline"><div class="rsz-gtext"></div></div></div>' +
        '<div class="rsz-glabel">' + CHIP_LABEL[ratio] + '</div>' +
        '<div class="rsz-gstep">' +
          '<div class="rsz-step rsz-step-sm" role="button" data-d="-0.01">−</div>' +
          '<span class="rsz-gval"></span>' +
          '<div class="rsz-step rsz-step-sm" role="button" data-d="0.01">+</div>' +
        '</div>';
      var frame = card.querySelector('.rsz-gframe');
      frame.style.height = GUIDE_FRAME_H + 'px';
      frame.style.width = Math.round(GUIDE_FRAME_H * dims.w / dims.h) + 'px';

      var dragging = false;
      function at(e) {
        var rc = frame.getBoundingClientRect();
        if (rc.height > 0) setGuide(ratio, (e.clientY - rc.top) / rc.height);
      }
      frame.addEventListener('mousedown', function (e) { dragging = true; at(e); });
      frame.addEventListener('mousemove', function (e) { if (dragging) at(e); });
      frame.addEventListener('mouseleave', function () { dragging = false; });
      document.addEventListener('mouseup', function () { dragging = false; });

      card.querySelectorAll('.rsz-step').forEach(function (b) {
        b.addEventListener('click', function () {
          setGuide(ratio, rszState.prefs.guide[ratio] + parseFloat(b.getAttribute('data-d')));
        });
      });
      box.appendChild(card);
      paintGuide(ratio);
    });
  }

  // Loại giá trị đầu của một param (chỉ để chẩn đoán): MogrtText / số / chữ / điểm / màu…
  async function describeParamValue(prm) {
    var v;
    try { v = await un(prm.getStartValue()); } catch (e) { return 'getStartValue lỗi: ' + ((e && e.message) || e); }
    if (v === null || v === undefined) return 'null';
    try {
      if (typeof v.getText === 'function') {
        var t = String(v.getText() || '');
        var font = '';
        try { font = v.getFontName ? ' · font=' + v.getFontName() : ''; } catch (e2) { font = ' · font=(nhiều kiểu)'; }
        return 'MogrtText "' + (t.length > 40 ? t.slice(0, 40) + '…' : t) + '"' + font;
      }
      if (typeof v.red === 'number' && typeof v.green === 'number') return 'Color';
      var inner = v.value;
      if (inner && typeof inner === 'object' && 'value' in inner) inner = inner.value;
      if (inner !== undefined) {
        if (inner && inner.length === 2) return 'Point ' + JSON.stringify([Number(inner[0]), Number(inner[1])]);
        return (typeof inner) + ' ' + JSON.stringify(inner).slice(0, 40);
      }
      var keys = [];
      for (var k in v) keys.push(k);
      return 'object {' + keys.slice(0, 8).join(',') + '}';
    } catch (e3) { return 'không đọc được: ' + ((e3 && e3.message) || e3); }
  }

  // ── Chẩn đoán: in ra cấu trúc clip của sequence nguồn để dò API khi test ─
  async function runDiag() {
    var out = $('rszDiagOut');
    out.style.display = '';
    out.value = 'Đang đọc…';
    var lines = [];
    var L = function (s) { lines.push(s); };
    try {
      L('Plugin ' + (typeof PLUGIN_VERSION !== 'undefined' ? PLUGIN_VERSION : '?'));
      L('API: ProjectUtils.getSelection=' + !!(ppro.ProjectUtils && ppro.ProjectUtils.getSelection)
        + ' PointF=' + !!ppro.PointF);
      var project = await getActiveProject();
      var rootId = await rootIdOf(project);
      L('Gốc project: id=' + (rootId || '?'));
      var src = await resolveSources(project);
      L('Nguồn: ' + src.from + ' · ' + src.seqs.length + ' sequence');
      if (!src.seqs.length) { out.value = lines.join('\n'); return; }
      var seq = src.seqs[0];
      var g = await frameSizeOf(seq);
      var pi = await projectItemOf(seq);
      var bin = await parentBinOf(pi, rootId);
      L('Sequence: "' + (await nameOf(seq)) + '" ' + g.w + '×' + g.h + ' · ratio=' + RSZ.detectRatio(g.w, g.h)
        + ' · createCloneAction=' + (typeof seq.createCloneAction) + ' · bin=' + (bin ? '"' + (await nameOf(bin)) + '"' : '(gốc)'));
      var n = await un(seq.getVideoTrackCount());
      for (var vt = 0; vt < n; vt++) {
        var clips = await getClipItems(await un(seq.getVideoTrack(vt)));
        for (var c = 0; c < clips.length && c < 8; c++) {
          var clip = clips[c];
          var comps = await componentsOf(clip);
          var kind = RSZ.isLogoName(await nameOf(clip)) ? 'LOGO' : RSZ.isTextClip(comps) ? 'TEXT' : 'khác';
          L('V' + (vt + 1) + ' "' + (await nameOf(clip)) + '" → ' + kind);
          L('   components: ' + comps.map(function (x) { return x.displayName + ' [' + x.matchName + ']'; }).join(', '));
          var pos = await motionPositionOf(comps);
          if (pos) {
            var tv = pos.isTimeVarying ? pos.isTimeVarying() : '?';
            L('   Position (' + (await paramName(pos)) + ') = ' + JSON.stringify(await readPoint(pos, await un(clip.getInPoint())))
              + ' · keyframe=' + tv);
          } else {
            L('   Position: không tìm thấy');
          }
          // MOGRT (Capsule): liệt kê param + loại giá trị — dò xem có tách được
          // MOGRT có chữ (param MogrtText) với MOGRT không chữ (light leak…) không.
          for (var ci = 0; ci < comps.length; ci++) {
            if (!/capsule/i.test(comps[ci].matchName)) continue;
            L('   MOGRT params:');
            var pc = await un(comps[ci].comp.getParamCount());
            for (var pk = 0; pk < pc && pk < 30; pk++) {
              var prm = await un(comps[ci].comp.getParam(pk));
              if (!prm) continue;
              L('     ' + pk + '. "' + (await paramName(prm)) + '" → ' + (await describeParamValue(prm)));
            }
            if (pc > 30) L('     … còn ' + (pc - 30) + ' param');
          }
        }
      }
    } catch (e) {
      L('LỖI: ' + ((e && e.message) || e));
    }
    out.value = lines.join('\n');
  }

  // ── Khởi động ───────────────────────────────────────────────────────────
  function init() {
    if (!$('tab-resize') || typeof RSZ === 'undefined') return;
    rszState.prefs = loadPrefs();

    document.querySelectorAll('#rszModes .rsz-seg').forEach(function (el) {
      el.addEventListener('click', function () {
        rszState.prefs.mode = el.getAttribute('data-mode');
        savePrefs();
        renderMode();
      });
    });
    $('rszGo').addEventListener('click', onGo);
    $('rszRefresh').addEventListener('click', function () { refreshSource(true); });
    $('rszAuto').addEventListener('click', function () { setAuto(!rszState.prefs.auto); });

    $('rszOpenSettings').addEventListener('click', function (e) {
      e.stopPropagation();   // không để click lan ra document làm đóng settings vừa mở
      if (typeof openSettingsPanel === 'function') openSettingsPanel('resize');
    });
    paintBg();
    $('rszBgMinus').addEventListener('click', function () { stepBg(-1); });
    $('rszBgPlus').addEventListener('click', function () { stepBg(1); });
    buildGuides();
    $('rszGuideReset').addEventListener('click', function () {
      GUIDE_RATIOS.forEach(function (r) { setGuide(r, 0.5); });
    });
    $('rszDiagToggle').addEventListener('click', function () {
      var body = $('rszDiagBody'), open = body.style.display === 'none';
      body.style.display = open ? '' : 'none';
      $('rszDiagToggle').textContent = (open ? '▾' : '▸') + ' Dò lỗi';
    });
    $('rszDiagBtn').addEventListener('click', runDiag);
    // Ô kết quả chẩn đoán: giữ bàn phím để Cmd+A / Cmd+C copy được, không lọt phím tắt Premiere.
    $('rszDiagOut').addEventListener('focus', function () { if (window.claimKeyboard) window.claimKeyboard(); });
    $('rszDiagOut').addEventListener('blur', function () { if (window.releaseKeyboard) window.releaseKeyboard(); });

    var tabBtn = document.querySelector('.tab-btn[data-tab="resize"]');
    if (tabBtn) tabBtn.addEventListener('click', function () { refreshSource(true); });

    renderMode();
    paintSource(null);
    setAuto(rszState.prefs.auto);
  }

  init();

  // ── Cho tab Claude điều phối (claude-tab.js) ──────────────────────────
  // Cùng các bước của nút RESIZE: plan (xem trước, đánh dấu trùng tên) → run (tạo thật).
  // prefs (track nền, guide text) lấy theo cài đặt tab Resize hiện tại.
  window.ResizeAPI = {
    platforms: RSZ.PLATFORM_TARGETS,
    seqFromItem: async function (item) {
      var project = await getActiveProject(), cp = null;
      try { cp = ppro.ClipProjectItem.cast(item); } catch (e) {}
      return seqFromProjectItem(project, item, cp);
    },
    plan: function (platform, wanted, seqs) {
      if (!RSZ.PLATFORM_TARGETS[platform]) return Promise.resolve({ ok: false, error: 'nền tảng "' + platform + '" không có (GG / FB / PIN)' });
      return planResize(platform, wanted && wanted.length ? wanted : RSZ.PLATFORM_TARGETS[platform], seqs);
    },
    // Khối "Dựng bin" (binset.js): nhân bản seq → đổi tên → vào bin (đường dẫn, tạo nếu thiếu).
    // Có đồng hồ canh như resize: bước quá STEP_LIMIT_MS thì ném lỗi kèm tên bước.
    cloneInto: async function (seq, name, binPathStr) {
      var project = await getActiveProject();
      var work = (async function () {
        rzStep(name + ' · tạo bin ' + binPathStr);
        var bin = await ppGetOrCreateBin(project, binPathStr);
        if (!bin) throw new Error('không tạo được bin ' + binPathStr);
        rzStep(name + ' · nhân bản');
        var dup = await cloneSequence(project, seq);
        if (!dup) throw new Error('không nhân bản được sequence');
        rzStep(name + ' · đổi tên');
        await renameSeq(project, dup, name);
        rzStep(name + ' · chuyển bin');
        await moveToBin(project, dup, bin, await binIdOf(bin));
        return dup;
      })();
      var r = await withWatchdog(work.then(function (d) { return { dup: d }; }), { name: name });
      if (r.dup) return r.dup;
      throw new Error(r.error || 'lỗi không rõ');
    },
    // Khối "Tạo sequence": sequence RỖNG → đổi tên → chép cài đặt (khung, audio…) của opts.like
    // hoặc đặt khung opts.frame [w,h] → vào bin. fps theo mặc định project (UXP không đổi được sau khi tạo).
    makeSequence: async function (name, binPathStr, opts) {
      opts = opts || {};
      var project = await getActiveProject();
      var work = (async function () {
        rzStep(name + ' · tạo bin ' + binPathStr);
        var bin = binPathStr ? await ppGetOrCreateBin(project, binPathStr) : null;
        if (binPathStr && !bin) throw new Error('không tạo được bin ' + binPathStr);
        rzStep(name + ' · tạo sequence');
        if (typeof project.createSequence !== 'function') throw new Error('Premiere bản này không có createSequence');
        var seq = await un(project.createSequence(name));
        if (!seq) throw new Error('không tạo được sequence');
        await sleep(700);                                   // chờ Premiere ghi nhận sequence mới
        rzStep(name + ' · đổi tên');
        await renameSeq(project, seq, name);
        rzStep(name + ' · cài đặt');
        if (opts.like) {
          var st = await un(opts.like.getSettings());
          await commit(project, function (ca) { ca.addAction(seq.createSetSettingsAction(st)); }, 'Flow: chép cài đặt sequence');
        }
        if (opts.frame) {                                   // bộ frame: khung riêng từng video (sau khi chép cài đặt)
          if (!(await setFrameSize(project, seq, opts.frame[0], opts.frame[1]))) throw new Error('Premiere không nhận khung ' + opts.frame.join('×'));
        }
        if (bin) { rzStep(name + ' · chuyển bin'); await moveToBin(project, seq, bin, await binIdOf(bin)); }
        return seq;
      })();
      var r = await withWatchdog(work.then(function (q) { return { dup: q }; }), { name: name });
      if (r.dup) return r.dup;
      throw new Error(r.error || 'lỗi không rõ');
    },
    // Khối "Chuyển vào bin"
    moveInto: async function (seq, binPathStr) {
      var project = await getActiveProject();
      var bin = await ppGetOrCreateBin(project, binPathStr);
      if (!bin) throw new Error('không tạo được bin ' + binPathStr);
      await moveToBin(project, seq, bin, await binIdOf(bin));
      return true;
    },
    status: function () { return { busy: rszState.busy, step: rzStepNow.step, seconds: rzStepNow.since ? Math.round((Date.now() - rzStepNow.since) / 1000) : 0 }; },
    run: async function (platform, plan, onRow, opts) {
      if (rszState.busy) throw new Error('tab Resize đang chạy lượt khác');
      clearPending();
      setBusy(true);
      try { return await runResize(platform, plan, rszState.prefs, onRow || function () {}, opts); }
      finally { setBusy(false); refreshSource(true); }
    }
  };
})();
