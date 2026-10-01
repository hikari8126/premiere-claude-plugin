// plugin/rawcut-core.js — logic thuần của tab Raw-cutter: dựng dump sequence cho engine,
// fingerprint timeline, đọc manifest thành dòng clip, lọc clip sẽ xuất, danh sách cut cần
// Premiere render. Không đụng Premiere/DOM nên test được bằng Node
// (bridge/test/rawcut-core.test.js).
//
// Port từ Raw-cutter 3.93 của mill2nn (host.jsx dumpActiveSequence/activeSequenceStamp,
// main.js loadRows/pickedClips/renderSpec/renderMbps). Giữ ES5 (không let/const/arrow)
// cho khớp phần còn lại của plugin.

var RCC = (function () {
  var TPS = 254016000000;   // tick / giây của Premiere

  // Loại file không cắt được từ nguồn (AE comp, project…) — chip mặc định tắt.
  var DEAD_TYPES = { aep: 1, prproj: 1, psb: 1, c4d: 1, aet: 1, ppj: 1, fcpxml: 1, aegraphic: 1, mogrt: 1 };
  // Luôn hiện chip kể cả khi timeline không có — danh sách không đổi hình giữa các project.
  var ALWAYS_TYPES = ['mp4', 'mov', 'png'];
  // Bit/pixel của x264 theo CRF (đo trên footage thật, bảng BPP_INTER của bản gốc).
  var BPP_INTER = [[6, 0.759], [14, 0.290], [18, 0.144], [23, 0.066], [28, 0.032]];
  var RENDER_HEADROOM = 2;
  // Trạng thái clip coi là lỗi để Retry.
  var FAILED_STATUS = { failed: 1, no_render: 1, render_mismatch: 1, missing_source: 1 };
  // Lỗi do bản render → Retry phải render lại, không dùng render cũ.
  var RENDER_FAULTS = { no_render: 1, render_mismatch: 1, render_short: 1 };

  // ── Thời gian ───────────────────────────────────────────────────────────
  // Ticks luôn là CHUỖI: vượt độ chính xác của số thực.
  function tickStr(v) {
    if (v === null || v === undefined || v === '') return '0';
    if (typeof v === 'string') return /^-?\d+$/.test(v) ? v : String(Math.round(Number(v) || 0));
    return String(Math.round(Number(v) || 0));
  }
  function timeObj(ticks) {
    var t = tickStr(ticks);
    return { ticks: t, seconds: Number(t) / TPS };
  }
  // Sequence chưa đặt in/out → Premiere trả số âm rất lớn (-400000 giây).
  function pointOrNull(ticks) {
    if (ticks === null || ticks === undefined) return null;
    var t = tickStr(ticks);
    return Number(t) < 0 ? null : timeObj(t);
  }

  // ── Dump (schema format_version 1 — engine kiểm generator "xmlcut reader") ──
  function buildDump(info, clips) {
    info = info || {};
    var tb = tickStr(info.timebase);
    var out = {
      generator: 'xmlcut reader',
      format_version: 1,
      premiere_version: String(info.premiereVersion || ''),
      project_name: String(info.projectName || ''),
      project_path: String(info.projectPath || ''),
      sequence: {
        name: String(info.name || ''),
        id: String(info.id || ''),
        timebase_ticks_per_frame: tb,
        fps: Number(tb) > 0 ? TPS / Number(tb) : 0,
        frame_width: Number(info.width || 0),
        frame_height: Number(info.height || 0),
        end: timeObj(info.endTicks),
        in_point: pointOrNull(info.inTicks),
        out_point: pointOrNull(info.outTicks)
      },
      ticks_per_second: TPS,
      clips: []
    };
    for (var i = 0; i < (clips || []).length; i++) {
      var c = clips[i], pi = c.pi || {}, it = c.interp || {};
      var start = tickStr(c.startTicks), end = tickStr(c.endTicks);
      var rec = {
        track_index: Number(c.trackIndex || 1),
        track_type: c.trackType === 'audio' ? 'audio' : 'video',
        name: String(c.name || ''),
        media_type: c.trackType === 'audio' ? 'Audio' : 'Video',
        start: timeObj(start),
        end: timeObj(end),
        duration: timeObj(String(Number(end) - Number(start))),
        // Đơn vị TIMELINE (giống ExtendScript): engine nhân speed ra đoạn nguồn.
        in_point: timeObj(c.inTicks),
        out_point: timeObj(c.outTicks),
        speed: (typeof c.speed === 'number' && c.speed > 0) ? c.speed : null,
        reversed: !!c.reversed,
        disabled: !!c.disabled,
        selected: !!c.selected,
        is_adjustment_layer: !!c.adjustment,
        project_item: {
          name: String(pi.name || ''),
          node_id: String(pi.nodeId || ''),
          type: pi.type === undefined ? 1 : pi.type,
          media_path: String(pi.mediaPath || ''),
          is_sequence: !!pi.isSequence,
          is_offline: !!pi.isOffline,
          is_multicam: !!pi.isMulticam
        },
        interpretation: {
          frame_rate: (typeof it.frameRate === 'number') ? it.frameRate : null,
          pixel_aspect_ratio: (typeof it.par === 'number') ? it.par : null,
          field_type: (it.fieldType === undefined) ? null : it.fieldType,
          remove_pulldown: (it.removePulldown === undefined) ? null : it.removePulldown,
          alpha_usage: (it.alphaUsage === undefined) ? null : it.alphaUsage
        },
        components: (c.components || []).map(function (k) {
          return { displayName: String(k.displayName || ''), matchName: String(k.matchName || '') };
        }),
        has_keyframed_remap: !!c.keyframedRemap
      };
      if (c.error) rec.error = String(c.error);
      out.clips.push(rec);
    }
    return out;
  }

  // ── Fingerprint (activeSequenceStamp H682) ─────────────────────────────
  // Hash cuộn qua mute của từng track + vị trí/nguồn/bật-tắt của từng clip, nest đệ quy.
  // Đổi slip, đổi clip cùng độ dài, replace footage, tắt clip, sửa audio, tắt mắt track,
  // sửa trong nest → fingerprint đổi. Không gồm effect/transition/keyframe speed.
  function hashStr(s, h) {
    h = h || 0;
    s = String(s);
    for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return h;
  }
  function trackSig(tracks) {
    var parts = [];
    for (var i = 0; i < (tracks || []).length; i++) {
      var t = tracks[i];
      var m = (t.muted === true) ? '1' : (t.muted === false ? '0' : '?');
      parts.push(t.kind + t.index + 'm' + m + ';');
      for (var j = 0; j < (t.clips || []).length; j++) {
        var c = t.clips[j];
        parts.push(t.kind + t.index + ':' + j + ':' + c.start + ':' + c.end + ':' + c.inp + ':' + c.out + ':'
          + (c.on ? 'on' : 'off') + ':' + (c.nodeId || '') + ':' + (c.path || '')
          + (c.nest ? ':~' + c.nest : '') + ';');
      }
    }
    return parts.join('');
  }
  function fingerprint(tracks) {
    var videoClips = 0;
    for (var i = 0; i < (tracks || []).length; i++) {
      if (tracks[i].kind === 'v') videoClips += (tracks[i].clips || []).length;
    }
    return String(hashStr(trackSig(tracks))) + '.' + videoClips;
  }

  // ── Manifest → dòng clip (loadRows M7173) ──────────────────────────────
  function extOf(p) {
    var s = String(p || ''), slash = s.lastIndexOf('/'), dot = s.lastIndexOf('.');
    return (dot > slash + 1) ? s.substring(dot + 1).toLowerCase() : '(none)';
  }
  function clipKey(r) {
    if (r.cutId) return r.cutId;
    return r.trackType + ' ' + r.trackIndex + ' ' + r.tlIn + ' ' + r.tlOut;
  }
  function rowsFromManifest(manifest, half) {
    var clips = (manifest && manifest.clips) || [], rows = [];
    for (var i = 0; i < clips.length; i++) {
      var c = clips[i];
      var spd = Number(c.speed_percent || 100);
      var r = {
        half: half || 'source',
        cutId: String(c.cut_id || ''),
        trackType: String(c.track_type || 'video'),
        trackIndex: Number(c.track_index || 1),
        premTrack: Number(c.premiere_track || c.track_index || 1),
        tlIndex: Number(c.timeline_index || 0) || (i + 1),
        tlIn: Number(c.timeline_in_frames || 0),
        tlOut: Number(c.timeline_out_frames || 0),
        tc: String(c.timeline_in_tc || ''),
        clip: String(c.clip_name || ''),
        source: String(c.source_path || ''),
        ext: extOf(c.source_path),
        cuttable: c.cuttable === true,
        status: String(c.display_status || c.status || ''),
        engineStatus: String(c.status || ''),
        notes: String(c.display_notes || ''),
        kind: String(c.display_kind || '') || 'ok',
        speed: (Math.abs(spd - 100) > 0.01 || c.reversed) ? (Math.round(spd) + '%' + (c.reversed ? ' ⏪' : '')) : '',
        outputFile: String(c.output_file || ''),
        error: String(c.error || '')
      };
      r.key = clipKey(r);
      rows.push(r);
    }
    return rows;
  }

  // Các track video có clip cắt được (chọn master track cho Timeline Render).
  function videoTracksPresent(rows) {
    var seen = {}, out = [];
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      if (r.trackType !== 'video' || !r.cuttable) continue;
      seen[r.trackIndex] = (seen[r.trackIndex] || 0) + 1;
    }
    for (var k in seen) if (Object.prototype.hasOwnProperty.call(seen, k)) out.push({ index: Number(k), items: seen[k] });
    out.sort(function (a, b) { return a.index - b.index; });
    return out;
  }

  // Chip loại file: {ext, n, on, dead, always}. prefs = {ext: true|false} đã nhớ.
  function typeList(rows, prefs) {
    var count = {}, i, out = [];
    prefs = prefs || {};
    for (i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      if (r.ext === '(none)') continue;
      count[r.ext] = (count[r.ext] || 0) + 1;
    }
    for (i = 0; i < ALWAYS_TYPES.length; i++) if (!count[ALWAYS_TYPES[i]]) count[ALWAYS_TYPES[i]] = 0;
    for (var e in count) {
      if (!Object.prototype.hasOwnProperty.call(count, e)) continue;
      var on = Object.prototype.hasOwnProperty.call(prefs, e) ? !!prefs[e] : !DEAD_TYPES[e];
      out.push({ ext: e, n: count[e], on: on, dead: !!DEAD_TYPES[e], always: ALWAYS_TYPES.indexOf(e) !== -1 });
    }
    out.sort(function (a, b) { return (b.n - a.n) || (a.ext < b.ext ? -1 : 1); });
    return out;
  }
  // Mọi loại có mặt đều đang tắt → bật lại hết (panel không mở ra trong trạng thái không cắt được gì).
  function typesWithFallback(list) {
    var present = list.filter(function (t) { return t.n > 0; });
    if (present.length && !present.some(function (t) { return t.on; })) {
      present.forEach(function (t) { t.on = true; });
      return { list: list, reset: true };
    }
    return { list: list, reset: false };
  }

  // Clip sẽ xuất (pickedClips M7473).
  // opt = {half:'source'|'render', typesOn:{ext:bool}, unpicked:{key:true}, master:N, audioCut:[n]|null}
  function pickRows(rows, opt) {
    opt = opt || {};
    var out = [];
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      if (!r.cuttable) continue;
      if (opt.unpicked && opt.unpicked[r.key]) continue;
      if (opt.half !== 'render' && r.ext !== '(none)' && opt.typesOn && opt.typesOn[r.ext] === false) continue;
      if (opt.half === 'render' && r.trackType === 'video' && opt.master && r.trackIndex !== Number(opt.master)) continue;
      if (r.trackType === 'audio' && opt.audioCut && opt.audioCut.indexOf(r.premTrack) === -1) continue;
      out.push(r);
    }
    return out;
  }

  // Danh sách --pick: clip được chọn + mọi dòng không cắt được (để cảnh báo vẫn vào manifest).
  // null = chọn hết → không gửi --pick.
  function pickKeys(rows, picked) {
    var cuttable = (rows || []).filter(function (r) { return r.cuttable; });
    if (picked.length === cuttable.length) return null;
    var keys = picked.map(function (r) { return r.key; });
    (rows || []).forEach(function (r) { if (!r.cuttable) keys.push(r.key); });
    return keys;
  }

  // ── Timeline Render ────────────────────────────────────────────────────
  // Nhãn = tên file engine tìm trong --render-dir (render_name, xmlcut.py ~6510).
  function renderLabel(r) { return r.trackType + '-' + r.trackIndex + '-' + r.tlIn + '-' + r.tlOut; }
  // retry = {key: engineStatus} khi Retry; kept = {label: true} render còn trong cache.
  function renderRanges(picked, master, retry, kept) {
    var out = [], reused = 0;
    for (var i = 0; i < (picked || []).length; i++) {
      var r = picked[i];
      if (r.trackType !== 'video') continue;
      if (master && r.trackIndex !== Number(master)) continue;
      if (!(r.tlOut > r.tlIn)) continue;
      var label = renderLabel(r);
      if (retry) {
        if (!Object.prototype.hasOwnProperty.call(retry, r.key)) continue;
        if (!RENDER_FAULTS[retry[r.key]] && kept && kept[label]) { reused++; continue; }
      }
      out.push({ label: label, inF: r.tlIn, outF: r.tlOut, key: r.key });
    }
    return { ranges: out, reused: reused };
  }

  function lerp(tbl, x) {
    if (x <= tbl[0][0]) return tbl[0][1];
    var last = tbl[tbl.length - 1];
    if (x >= last[0]) return last[1];
    for (var i = 0; i < tbl.length - 1; i++) {
      var a = tbl[i], b = tbl[i + 1];
      if (x >= a[0] && x <= b[0]) return a[1] + (x - a[0]) / (b[0] - a[0]) * (b[1] - a[1]);
    }
    return last[1];
  }
  // Bitrate render Premiere theo CRF đã chọn. Kẹp 41.7 vì 41.7×1.2 = 50, trần của preset
  // "Match Source - High bitrate". 0 = thiếu size/fps → dùng preset gốc.
  function renderMbps(crf, w, h, fps) {
    if (!(w > 0 && h > 0 && fps > 0)) return 0;
    var bits = lerp(BPP_INTER, crf || 1) * w * h * fps * RENDER_HEADROOM;
    return Math.max(4, Math.min(41.7, bits / 1e6));
  }

  // ── Kết quả ────────────────────────────────────────────────────────────
  function summarize(manifest) {
    var c = (manifest && manifest.counts) || {};
    return {
      ok: Number(c.ok || 0), failed: Number(c.failed || 0), skipped: Number(c.skipped_existing || 0),
      missing: Number(c.missing_sources || 0), unsupported: Number(c.unsupported || 0),
      noRender: Number(c.no_render || 0), mismatch: Number(c.render_mismatch || 0),
      // Mất nguồn ĐẾM THEO CLIP đã xuất (counts.missing_sources gồm cả dòng không chọn và .aep).
      missingPicked: ((manifest && manifest.clips) || []).filter(function (k) { return k.status === 'missing_source'; }).length
    };
  }
  // {key: status} của clip lỗi trong manifest (cho Retry).
  function failedKeys(manifest) {
    var out = {}, any = false;
    var rows = rowsFromManifest(manifest, '');
    for (var i = 0; i < rows.length; i++) {
      var stt = rows[i].engineStatus;
      if (!FAILED_STATUS[stt]) continue;
      // Render ngắn hơn cut → phải render lại, không dùng bản cũ trong cache (main.js:10248 bản gốc).
      if (stt === 'failed' && /the RENDER came up short/i.test(rows[i].error)) stt = 'render_short';
      out[rows[i].key] = stt; any = true;
    }
    return any ? out : null;
  }

  return {
    TPS: TPS, DEAD_TYPES: DEAD_TYPES, ALWAYS_TYPES: ALWAYS_TYPES,
    tickStr: tickStr, timeObj: timeObj, pointOrNull: pointOrNull, buildDump: buildDump,
    hashStr: hashStr, fingerprint: fingerprint,
    extOf: extOf, clipKey: clipKey, rowsFromManifest: rowsFromManifest, videoTracksPresent: videoTracksPresent,
    typeList: typeList, typesWithFallback: typesWithFallback, pickRows: pickRows, pickKeys: pickKeys,
    renderLabel: renderLabel, renderRanges: renderRanges, lerp: lerp, renderMbps: renderMbps,
    summarize: summarize, failedKeys: failedKeys
  };
})();

(function (root) {
  if (root) { root.RCC = RCC; }
  if (typeof module !== "undefined" && module.exports) { module.exports = RCC; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
