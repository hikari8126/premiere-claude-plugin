// plugin/cl-custom.js — tuỳ biến tab Claude theo từng member (global CLC). Thuần, có test.
//
// Dữ liệu (localStorage cl_custom_v1, mỗi máy một bộ):
//   { v:1, buttons:[{id, name, kind:'prompt'|'flow', mode:'command'|'free', prompt, steps:[step]}], notes }
//   step = {type:'fix_voice_bins'} | {type:'resize', platform, ratios:[], scope} |
//          {type:'rawcut', mode, scope} | {type:'open_tab', tab} | {type:'prompt', text}
//   scope: 'current' (đang chọn / đang mở) | 'set' (cả bộ {bộ}: các sequence vid{bộ}.N gốc)
// Biến trong lệnh: {bộ} {sequence} {sản phẩm} — lấy từ tên sequence đang mở.
// Tự học: (1) habits — đếm lệnh gõ lặp / cặp action hay làm liền → gợi ý lưu nút/quy trình;
// (2) khối ```remember trong câu trả lời → bro bấm Nhớ thì thêm vào ghi chú;
// (3) projectFacts — đọc quy ước bin/tên từ bản chụp project, gửi kèm mỗi lệnh.

var CLC = (function () {
  var NOTES_MAX = 1500, MAX_BUTTONS = 40, MAX_STEPS = 12;
  var PLATFORMS = ['GG', 'FB', 'PIN'];
  var RATIOS = ['9-16', '4-5', '1-1', '2-3'];
  var RAW_MODES = ['source', 'render', 'both'];
  var TABS = ['voicegen', 'autocut', 'subtext', 'unnest', 'watch', 'resize', 'rawcut'];

  function str(v, max) { return String(v == null ? '' : v).slice(0, max || 2000); }
  function uid() { return 'b' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

  function empty() { return { v: 1, buttons: [], notes: '' }; }

  // ── Bước quy trình = khối (chip) ───────────────────────────────────────────
  // step = {type, platform?, ratios?, mode?, tab?, text?, seqs?:[seq]}
  // seq  = {k:'idx', n} (vid .N của bộ đang mở) | {k:'set'} (cả bộ) | {k:'current'} (đang chọn / mở)
  //        | {k:'pick'} (chọn lúc chạy)
  // Bản nháp (đang ráp) được thiếu tham số — problems() liệt kê; lưu nút thì phải đủ.
  var SPEC = {
    resize:         { label: 'Resize',        req: ['platform', 'seqs'], opt: ['ratios'], seqKinds: ['idx', 'set', 'current', 'pick'] },
    bin_set:        { label: 'Dựng bin',      req: ['platform', 'seqs'], opt: [], seqKinds: ['idx', 'set'] },
    rawcut:         { label: 'RAW',           req: ['mode', 'seqs'], opt: [], seqKinds: ['idx', 'set', 'current', 'pick'] },
    rawcut_export:  { label: 'Xuất RAW',      req: ['mode', 'seqs'], opt: [], seqKinds: ['idx', 'set', 'current', 'pick'] },
    pin_order:      { label: 'PIN theo đơn',  req: ['seqs'], opt: ['text'], seqKinds: ['idx', 'set'] },
    app_set:        { label: 'Dựng APP',      req: ['seqs'], opt: [], seqKinds: ['idx', 'set'] },
    fix_voice_bins: { label: 'Soát bin voice', req: [], opt: [] },
    open_tab:       { label: 'Mở tab',        req: ['tab'], opt: [] },
    prompt:         { label: 'Hỏi Claude',    req: ['text'], opt: [] },
    wait:           { label: 'Chờ bro',       req: [], opt: ['text'] }
  };
  var STEP_TYPES = Object.keys(SPEC);
  // Khối đơn (flow-engine.js): Tạo bin · Tạo sequence · Nhân bản · Resize · Chuyển vào bin · Xuất RAW.
  var FL = (typeof FLE !== 'undefined') ? FLE : (function () { try { return require('./flow-engine.js'); } catch (e) { return null; } })();
  // Danh sách khối khi ráp (khối gộp cũ bin_set / pin_order / app_set / resize / rawcut* vẫn chạy được
  // cho dữ liệu cũ nhưng không còn trong danh sách — đã đổi thành chuỗi khối đơn).
  var BUILDER_TYPES = ['bin_make', 'seq_make', 'seq_clone', 'seq_resize', 'seq_move', 'raw_export', 'fix_voice_bins', 'wait', 'prompt', 'open_tab'];
  function isEngine(t) { return !!(FL && FL.isType(t)); }
  function typeLabel(t) { return isEngine(t) ? FL.TYPES[t].label : (SPEC[t] ? SPEC[t].label : t); }
  function typeDesc(t) {
    if (isEngine(t)) return FL.TYPES[t].desc;
    return { fix_voice_bins: 'chuyển voice về đúng bin Voice Over / {bộ}x', wait: 'dừng chờ bro làm tay rồi bấm Tiếp tục',
             prompt: 'gửi một lệnh cho Claude', open_tab: 'mở một tab của plugin' }[t] || '';
  }
  var PLATFORM_OF = { resize: PLATFORMS, bin_set: ['GG', 'PIN'] };
  var SEQ_LABEL = { set: 'Cả bộ', current: 'Đang chọn / mở', pick: 'Chọn lúc chạy' };

  function normSeqs(arr, type) {
    var kinds = (SPEC[type] && SPEC[type].seqKinds) || [], out = [], seen = {};
    (Array.isArray(arr) ? arr : []).forEach(function (q) {
      if (!q || kinds.indexOf(q.k) < 0) return;
      var x = q.k === 'idx' ? { k: 'idx', n: Math.max(0, Math.min(99, parseInt(q.n, 10) || 0)) } : { k: q.k };
      var key = x.k + (x.n != null ? x.n : '');
      if (seen[key]) return;
      seen[key] = 1; out.push(x);
    });
    if (out.some(function (q) { return q.k !== 'idx'; })) out = out.filter(function (q) { return q.k !== 'idx'; }).slice(0, 1);
    return out.sort(function (a, b) { return (a.n || 0) - (b.n || 0); });
  }

  function normStep(s) {
    if (s && isEngine(s.type)) return FL.normStep(s);
    if (!s || typeof s !== 'object' || !SPEC[s.type]) return null;
    var t = s.type, out = { type: t };
    if (PLATFORM_OF[t]) out.platform = PLATFORM_OF[t].indexOf(s.platform) >= 0 ? s.platform : '';
    if (t === 'resize') out.ratios = (Array.isArray(s.ratios) ? s.ratios : []).filter(function (r, i, a) { return RATIOS.indexOf(r) >= 0 && a.indexOf(r) === i; });
    if (t === 'rawcut' || t === 'rawcut_export') out.mode = RAW_MODES.indexOf(s.mode) >= 0 ? s.mode : '';
    if (t === 'open_tab') out.tab = TABS.indexOf(s.tab) >= 0 ? s.tab : '';
    if (t === 'prompt' || t === 'wait') out.text = str(s.text, 2000).trim();
    if (t === 'pin_order') out.text = str(s.text, 60).trim();          // tên đơn — trống = "Order <hôm nay>"
    if (SPEC[t].seqKinds) {
      var seqs = s.seqs;
      if (!seqs && s.scope) seqs = [{ k: s.scope === 'set' ? 'set' : 'current' }];   // dữ liệu bản trước
      out.seqs = normSeqs(seqs, t);
    }
    return out;
  }
  // Tham số bắt buộc còn thiếu → ['platform', 'seqs', …]
  function problems(s) {
    if (s && isEngine(s.type)) return FL.problems(s);
    var sp = SPEC[s && s.type];
    if (!sp) return ['type'];
    return sp.req.filter(function (k) { return k === 'seqs' ? !(s.seqs && s.seqs.length) : !s[k]; });
  }

  function normButton(b) {
    if (!b || typeof b !== 'object') return null;
    var name = str(b.name, 24).trim();
    if (!name) return null;
    var out = { id: str(b.id, 40) || uid(), name: name, kind: b.kind === 'flow' ? 'flow' : 'prompt',
                mode: b.mode === 'free' ? 'free' : 'command', prompt: '', steps: [] };
    if (out.kind === 'flow') {
      out.steps = (Array.isArray(b.steps) ? b.steps : []).map(normStep).filter(Boolean).slice(0, MAX_STEPS);
      if (!out.steps.length || out.steps.some(function (st) { return problems(st).length; })) return null;
    } else {
      out.prompt = str(b.prompt, 4000).trim();
      if (!out.prompt) return null;
    }
    return out;
  }

  // Dữ liệu bất kỳ (localStorage / file nhập) → dạng chuẩn; mục hỏng bị bỏ.
  function normalize(d) {
    var out = empty();
    if (!d || typeof d !== 'object') return out;
    var seen = {};
    (Array.isArray(d.buttons) ? d.buttons : []).forEach(function (b) {
      var nb = normButton(b);
      if (!nb || out.buttons.length >= MAX_BUTTONS) return;
      if (seen[nb.id]) nb.id = uid();
      seen[nb.id] = 1;
      out.buttons.push(nb);
    });
    out.notes = str(d.notes, NOTES_MAX);
    return out;
  }

  // Chuyển dữ liệu nút lệnh cũ ([{name, prompt}] khoá 'claude-shortcuts') sang dạng mới.
  function fromLegacy(arr) {
    return normalize({ buttons: (Array.isArray(arr) ? arr : []).map(function (s) {
      return { name: s && s.name, kind: 'prompt', prompt: s && s.prompt };
    }) });
  }

  // ── Biến ────────────────────────────────────────────────────────────────────
  // "AeriSoft vid40.0 [c.a] [b]" → {bộ:'40', sequence:'AeriSoft vid40.0 [c.a] [b]', 'sản phẩm':'AeriSoft'}
  function vars(seqName) {
    var name = str(seqName, 300).trim(), m = name.match(/^(.*?)\s*vid\s*(\d+)\s*\.\s*\d+/i);
    return { 'bộ': m ? m[2] : '', 'sequence': name, 'sản phẩm': m ? m[1].trim() : '' };
  }
  function hasVars(text) { return /\{(bộ|sequence|sản phẩm)\}/.test(String(text || '')); }
  // → { text, missing:[tên biến chưa có giá trị] }
  function fill(text, v) {
    var missing = [];
    var out = String(text || '').replace(/\{(bộ|sequence|sản phẩm)\}/g, function (m, k) {
      var val = v && v[k];
      if (!val) { if (missing.indexOf(k) < 0) missing.push(k); return m; }
      return val;
    });
    return { text: out, missing: missing };
  }

  // ── Bước quy trình → action của tab Claude ────────────────────────────────
  // Sequence gốc của bộ: tên có vid{set}.N, không đuôi ratio (4x5…), không phải bản đích GG/PIN.
  // idxs (tuỳ chọn) chỉ lấy vid{set}.N với N trong danh sách.
  function setRefs(items, set, idxs) {
    if (!set) return [];
    var re = new RegExp('vid\\s*' + set + '\\s*\\.\\s*(\\d+)(?!\\d)', 'i');
    return (items || []).filter(function (it) {
      if (!it || it.isFolder || it.mediaType !== 'sequence') return false;
      var m = String(it.name).match(re);
      if (!m || /\b\d+x\d+\b/i.test(it.name) || /(^|\s)(GG|PIN)(\s|$)/.test(it.name)) return false;
      return !idxs || idxs.indexOf(Number(m[1])) >= 0;
    }).map(function (it) { return (it.path || '') + ' ▸ ' + it.name; });
  }

  var RATIO_LABEL = { '9-16': '9:16', '4-5': '4:5', '1-1': '1:1', '2-3': '2:3' };
  var RAW_LABEL = { source: 'source', render: 'render', both: 'source + render' };
  var TAB_LABEL = { voicegen: 'Voice Gen', autocut: 'Autocut', subtext: 'Tạo Sub', unnest: 'Un-nest',
                    watch: 'Watch', resize: 'Resize', rawcut: 'RAW' };
  var SLOT_HINT = { platform: 'nền tảng?', mode: 'chế độ?', tab: 'tab nào?', text: 'lệnh?', seqs: 'sequence?' };

  function seqText(q) { return q.k === 'idx' ? 'vid .' + q.n : SEQ_LABEL[q.k]; }

  // Chip của một bước: [{kind:'act'|'par'|'seq', slot, text, i?, missing?}]
  function chips(s) {
    if (isEngine(s.type)) return FL.chips(s).map(function (c, i) { c.slot = i ? 'form' : 'type'; return c; });
    var out = [{ kind: 'act', slot: 'type', text: SPEC[s.type].label }];
    function par(slot, text) { out.push({ kind: 'par', slot: slot, text: text || SLOT_HINT[slot], missing: !text }); }
    if (PLATFORM_OF[s.type]) par('platform', s.platform);
    if (s.type === 'resize' && s.ratios.length) out.push({ kind: 'par', slot: 'ratios', text: s.ratios.map(function (r) { return RATIO_LABEL[r]; }).join(' · ') });
    if (s.type === 'rawcut' || s.type === 'rawcut_export') par('mode', RAW_LABEL[s.mode]);
    if (s.type === 'pin_order') out.push({ kind: 'par', slot: 'text', text: s.text || 'đơn hôm nay' });
    if (s.type === 'open_tab') par('tab', TAB_LABEL[s.tab]);
    if (s.type === 'prompt') par('text', s.text);
    if (s.type === 'wait' && s.text) out.push({ kind: 'par', slot: 'text', text: s.text });
    if (SPEC[s.type].seqKinds) {
      if (!s.seqs.length) out.push({ kind: 'seq', slot: 'seqs', text: SLOT_HINT.seqs, missing: true });
      s.seqs.forEach(function (q, i) { out.push({ kind: 'seq', slot: 'seqs', i: i, text: seqText(q) }); });
    }
    return out;
  }

  // Lựa chọn cho một ô (popover "+" / bấm chip): [{value, text, on}]
  function slotOptions(s, slot) {
    if (slot === 'type') return BUILDER_TYPES.map(function (t) { return { value: t, text: typeLabel(t), desc: typeDesc(t), on: t === s.type }; });
    if (slot === 'platform') return PLATFORM_OF[s.type].map(function (p) { return { value: p, text: p, on: p === s.platform }; });
    if (slot === 'ratios') return RATIOS.map(function (r) { return { value: r, text: RATIO_LABEL[r], on: s.ratios.indexOf(r) >= 0 }; });
    if (slot === 'mode') return RAW_MODES.map(function (m) { return { value: m, text: RAW_LABEL[m], on: m === s.mode }; });
    if (slot === 'tab') return TABS.map(function (t) { return { value: t, text: TAB_LABEL[t], on: t === s.tab }; });
    if (slot === 'seqs') {
      var on = function (k, n) { return s.seqs.some(function (q) { return q.k === k && (n == null || q.n === n); }); };
      var opts = [0, 1, 2, 3, 4].map(function (n) { return { value: 'idx:' + n, text: 'vid .' + n, on: on('idx', n) }; });
      return opts.concat(SPEC[s.type].seqKinds.filter(function (k) { return k !== 'idx'; }).map(function (k) {
        return { value: k, text: SEQ_LABEL[k], on: on(k) };
      }));
    }
    return [];
  }
  // Ô có thể thêm bằng "+": tham số tuỳ chọn + sequence (chọn nhiều).
  function addable(s) {
    var out = [];
    if (isEngine(s.type)) return out;
    if (s.type === 'resize') out.push({ slot: 'ratios', text: 'Ratio' });
    if (SPEC[s.type].seqKinds) out.push({ slot: 'seqs', text: 'Sequence' });
    if (s.type === 'wait') out.push({ slot: 'text', text: 'Lời nhắc' });
    if (s.type === 'pin_order') out.push({ slot: 'text', text: 'Tên đơn' });
    return out;
  }
  // Chọn / bỏ một lựa chọn → bước mới (không sửa bước cũ).
  function toggle(s, slot, value) {
    var n = JSON.parse(JSON.stringify(s));
    if (slot === 'type') return isEngine(value) ? normStep({ type: value }) : normStep({ type: value, platform: n.platform, seqs: n.seqs });
    if (slot === 'ratios') { var i = n.ratios.indexOf(value); if (i >= 0) n.ratios.splice(i, 1); else n.ratios.push(value); }
    else if (slot === 'seqs') {
      var p = String(value).split(':'), q = p[0] === 'idx' ? { k: 'idx', n: Number(p[1]) } : { k: p[0] };
      var j = -1;
      n.seqs.forEach(function (x, k) { if (x.k === q.k && x.n === q.n) j = k; });
      if (j >= 0) n.seqs.splice(j, 1);
      else n.seqs = q.k === 'idx' ? n.seqs.filter(function (x) { return x.k === 'idx'; }).concat([q]) : [q];
    } else n[slot] = n[slot] === value ? '' : value;
    return normStep(n);
  }

  function stepLabel(s) {
    return chips(s).map(function (c) { return c.text; }).join(' · ');
  }

  // ctx = {vars, items}. → {action} | {prompt} | {wait} | {pick:{refs, step}} | {error}
  function stepAction(s, ctx) {
    ctx = ctx || {};
    if (isEngine(s.type)) return { engine: true };
    var v = ctx.vars || {}, miss = problems(s);
    if (miss.length) return { error: 'bước chưa đủ: ' + miss.map(function (k) { return SLOT_HINT[k] || k; }).join(', ') };
    var needSet = function () { return v['bộ'] ? null : { error: 'không biết bộ nào — mở một sequence của bộ trước (tên có vid{bộ}.N)' }; };
    var idxs = (s.seqs || []).filter(function (q) { return q.k === 'idx'; }).map(function (q) { return q.n; });
    var kind = s.seqs && s.seqs[0] && s.seqs[0].k;
    if (s.type === 'fix_voice_bins') return { action: { action: 'fix_voice_bins' } };
    if (s.type === 'open_tab') return { action: { action: 'open_tab', tab: s.tab } };
    if (s.type === 'wait') return { wait: fill(s.text || 'Bro làm xong phần tay rồi bấm Tiếp tục', v).text };
    if (s.type === 'app_set' || s.type === 'pin_order') {
      var e3 = needSet(); if (e3) return e3;
      var ax = { action: s.type, set: v['bộ'], idxs: kind === 'set' ? [] : idxs };
      if (s.type === 'pin_order' && s.text) ax.order = fill(s.text, v).text;
      return { action: ax };
    }
    if (s.type === 'bin_set') {
      var e = needSet(); if (e) return e;
      return { action: { action: 'bin_set', platform: s.platform, set: v['bộ'], idxs: kind === 'set' ? [] : idxs } };
    }
    if (s.type === 'resize' || s.type === 'rawcut' || s.type === 'rawcut_export') {
      var refs = [];
      if (kind === 'idx' || kind === 'set' || kind === 'pick') {
        var e2 = needSet(); if (e2) return e2;
        refs = setRefs(ctx.items, v['bộ'], kind === 'idx' ? idxs : null);
        if (!refs.length) return { error: 'không thấy sequence ' + (kind === 'idx' ? idxs.map(function (n) { return 'vid' + v['bộ'] + '.' + n; }).join(', ') : 'nào của bộ ' + v['bộ']) };
      }
      var act = s.type === 'resize'
        ? { action: 'resize', platform: s.platform, ratios: s.ratios.map(function (x) { return RATIO_LABEL[x]; }), items: refs }
        : { action: 'rawcut', mode: s.mode, items: refs, export: s.type === 'rawcut_export' };
      return kind === 'pick' ? { pick: { refs: refs, action: act } } : { action: act };
    }
    var f = fill(s.text, v);
    if (f.missing.length) return { error: 'thiếu ' + f.missing.map(function (k) { return '{' + k + '}'; }).join(', ') };
    return { prompt: f.text };
  }

  // ── Xuất / nhập (chia sẻ trong team) ───────────────────────────────────────
  function exportData(d, parts) {
    parts = parts || { buttons: true, notes: true };
    var n = normalize(d), out = { app: 'claude-tab-custom', v: 1 };
    if (parts.buttons) out.buttons = n.buttons;
    if (parts.notes) out.notes = n.notes;
    return JSON.stringify(out, null, 2);
  }
  // mode 'merge': thêm nút chưa có (trùng tên + nội dung thì bỏ), ghi chú nối thêm dòng chưa có.
  // mode 'replace': thay hẳn phần có trong file. → {data, added, error}
  function importData(cur, text, mode) {
    var p;
    try { p = JSON.parse(String(text || '')); } catch (e) { return { error: 'File không phải JSON' }; }
    if (!p || p.app !== 'claude-tab-custom') return { error: 'File không phải bộ tuỳ biến tab Claude' };
    var inc = normalize(p), base = normalize(cur);
    var hasB = Array.isArray(p.buttons), hasN = typeof p.notes === 'string';
    if (mode === 'replace') {
      return { data: { v: 1, buttons: hasB ? inc.buttons : base.buttons, notes: hasN ? inc.notes : base.notes },
               added: hasB ? inc.buttons.length : 0 };
    }
    var sig = function (b) { return b.name + '|' + b.kind + '|' + b.prompt + '|' + JSON.stringify(b.steps); };
    var have = base.buttons.map(sig), ids = base.buttons.map(function (b) { return b.id; }), added = 0;
    inc.buttons.forEach(function (b) {
      if (have.indexOf(sig(b)) >= 0 || base.buttons.length >= MAX_BUTTONS) return;
      if (ids.indexOf(b.id) >= 0) b.id = uid();
      base.buttons.push(b); added++;
    });
    if (hasN) inc.notes.split('\n').forEach(function (l) { base.notes = addNote(base.notes, l).notes; });
    return { data: base, added: added };
  }

  // ── Ghi chú ────────────────────────────────────────────────────────────────
  // Thêm một dòng (bỏ qua nếu đã có). → {notes, ok, error}
  function addNote(notes, line) {
    var l = str(line, 300).replace(/\s+/g, ' ').trim(), n = str(notes, NOTES_MAX);
    if (!l) return { notes: n, ok: false };
    var lines = n.split('\n').map(function (x) { return x.trim().toLowerCase(); });
    if (lines.indexOf(l.toLowerCase()) >= 0) return { notes: n, ok: false, error: 'đã có trong ghi chú' };
    var out = n.replace(/\s+$/, '') + (n.trim() ? '\n' : '') + l;
    if (out.length > NOTES_MAX) return { notes: n, ok: false, error: 'ghi chú đã đầy (' + NOTES_MAX + ' ký tự)' };
    return { notes: out, ok: true };
  }
  // Khối ```remember trong câu trả lời → các dòng Claude đề xuất nhớ.
  function parseRemember(text) {
    var out = [], re = /```remember\s*([\s\S]*?)```/g, m;
    while ((m = re.exec(String(text || ''))) !== null) {
      m[1].split('\n').forEach(function (l) {
        l = l.replace(/^\s*[-*•]\s*/, '').trim();
        if (l && out.indexOf(l) < 0) out.push(l.slice(0, 300));
      });
    }
    return out.slice(0, 3);
  }

  // ── Tự học (1): thói quen ──────────────────────────────────────────────────
  // h = {cmds:{key:{text,n,last}}, acts:[{a, p, at}] (20 gần nhất), pairs:{'a>b':{n, steps}}, no:[key bỏ qua]}
  var HABIT_N = 3, PAIR_GAP_MS = 45 * 60 * 1000;
  var LEARN_ACTS = ['fix_voice_bins', 'resize', 'rawcut', 'bin_set', 'open_tab'];
  function habitsEmpty() { return { cmds: {}, acts: [], pairs: {}, no: [] }; }
  function habitsNorm(h) {
    h = h && typeof h === 'object' ? h : {};
    return { cmds: h.cmds && typeof h.cmds === 'object' ? h.cmds : {}, acts: Array.isArray(h.acts) ? h.acts : [],
             pairs: h.pairs && typeof h.pairs === 'object' ? h.pairs : {}, no: Array.isArray(h.no) ? h.no : [] };
  }
  // Lệnh gõ tay: số bộ đang mở trong lệnh → {bộ}, để "resize bộ 39…" và "resize bộ 40…" là một.
  function cmdTemplate(cmd, v) {
    var t = String(cmd || '').replace(/\s+/g, ' ').trim();
    if (v && v['bộ']) t = t.replace(new RegExp('(^|\\D)' + v['bộ'] + '(?!\\d)', 'g'), '$1{bộ}');
    return t;
  }
  function cmdKey(t) { return 'c:' + t.toLowerCase().replace(/[.,!?…]+$/, ''); }
  function recordCmd(h, cmd, v, now) {
    h = habitsNorm(h);
    var t = cmdTemplate(cmd, v);
    if (t.length < 6 || t.length > 300) return h;
    var k = cmdKey(t), c = h.cmds[k] || { text: t, n: 0 };
    c.n++; c.last = now; c.text = t;
    h.cmds[k] = c;
    var keys = Object.keys(h.cmds);                          // giữ 60 lệnh gần nhất
    if (keys.length > 60) {
      keys.sort(function (a, b) { return h.cmds[a].last - h.cmds[b].last; });
      keys.slice(0, keys.length - 60).forEach(function (x) { delete h.cmds[x]; });
    }
    return h;
  }
  // Action đã chạy xong (ok). Action trước đó trong 45 phút → đếm cặp "trước>sau".
  function actionStep(a) {
    if (a.action === 'fix_voice_bins') return { type: 'fix_voice_bins' };
    if (a.action === 'open_tab') return { type: 'open_tab', tab: a.tab };
    if (a.action === 'bin_set') return { type: 'bin_set', platform: a.platform, seqs: a.idxs && a.idxs.length ? a.idxs.map(function (n) { return { k: 'idx', n: n }; }) : [{ k: 'set' }] };
    var seqs = [{ k: a.items && a.items.length > 1 ? 'set' : 'current' }];
    if (a.action === 'resize') return { type: 'resize', platform: a.platform, ratios: (a.ratios || []).map(function (r) { return String(r).replace(':', '-'); }), seqs: seqs };
    if (a.action === 'rawcut') return { type: 'rawcut', mode: a.mode, seqs: seqs };
    return null;
  }
  function recordAction(h, a, now) {
    h = habitsNorm(h);
    if (!a || LEARN_ACTS.indexOf(a.action) < 0) return h;
    var step = normStep(actionStep(a));
    if (!step) return h;
    var prev = h.acts[h.acts.length - 1];
    h.acts.push({ a: step.type, at: now, step: step });
    if (h.acts.length > 20) h.acts = h.acts.slice(-20);
    if (prev && prev.a !== step.type && now - prev.at < PAIR_GAP_MS) {
      var k = 'p:' + prev.a + '>' + step.type, p = h.pairs[k] || { n: 0 };
      p.n++; p.steps = [prev.step, step];
      h.pairs[k] = p;
    }
    return h;
  }
  function decline(h, key) { h = habitsNorm(h); if (h.no.indexOf(key) < 0) h.no.push(key); return h; }

  // Gợi ý lưu (chưa có nút tương tự, chưa bị bỏ qua). → {key, kind:'prompt', text} | {key, kind:'flow', steps} | null
  function suggest(h, d) {
    h = habitsNorm(h); d = normalize(d);
    var hasPrompt = function (t) { return d.buttons.some(function (b) { return b.kind === 'prompt' && cmdKey(b.prompt) === cmdKey(t); }); };
    var hasFlow = function (st) {
      var types = st.map(function (s) { return s.type; }).join('>');
      return d.buttons.some(function (b) {
        if (b.kind !== 'flow') return false;
        var bt = b.steps.map(function (s) { return s.type; }).join('>');
        return bt.indexOf(types) >= 0;
      });
    };
    var best = null;
    Object.keys(h.pairs).forEach(function (k) {
      var p = h.pairs[k];
      if (p.n >= HABIT_N && h.no.indexOf(k) < 0 && !hasFlow(p.steps) && (!best || p.n > best.n)) best = { key: k, kind: 'flow', steps: p.steps, n: p.n };
    });
    if (best) return best;
    Object.keys(h.cmds).forEach(function (k) {
      var c = h.cmds[k];
      if (c.n >= HABIT_N && h.no.indexOf(k) < 0 && !hasPrompt(c.text) && (!best || c.last > best.last)) best = { key: k, kind: 'prompt', text: c.text, n: c.n, last: c.last };
    });
    return best;
  }
  function suggestName(s) {
    if (s.kind === 'flow') return s.steps.map(function (x) {
      return x.type === 'fix_voice_bins' ? 'Voice' : x.type === 'resize' ? 'Resize ' + x.platform : x.type === 'bin_set' ? 'Bin ' + x.platform : x.type === 'rawcut' ? 'RAW' : TAB_LABEL[x.tab] || x.type;
    }).join(' → ').slice(0, 24);
    return s.text.replace(/\{bộ\}/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  }

  // ── Tự học (3): quy ước đọc từ project ─────────────────────────────────────
  // items: bản chụp PTOOLS.snapshot() [{name, path, isFolder, mediaType}]. → chuỗi ngắn (≤ 900 ký tự) hoặc ''.
  function projectFacts(items, seqName) {
    if (!Array.isArray(items) || !items.length) return '';
    var lines = [], v = vars(seqName);
    if (v['sản phẩm']) lines.push('- Sản phẩm (từ tên sequence đang mở): ' + v['sản phẩm'] + (v['bộ'] ? ', bộ ' + v['bộ'] : ''));
    function top(map, n) {
      return Object.keys(map).sort(function (a, b) { return map[b] - map[a]; }).slice(0, n);
    }
    // Bin chứa voice "N.x - …" và bin chứa sequence vidN.x — thay số bộ bằng {bộ}.
    var voiceBins = {}, seqBins = {}, sets = {}, seqNames = [];
    items.forEach(function (it) {
      if (!it || it.isFolder) return;
      var mv = String(it.name).match(/^(\d+)\.\d+\s*-\s*/);
      if (mv && it.mediaType !== 'sequence') {
        var vb = String(it.path || '(gốc)').replace(new RegExp('(^|\\D)' + mv[1] + '(?=x\\b|\\b)', 'g'), '$1{bộ}');
        voiceBins[vb] = (voiceBins[vb] || 0) + 1;
      }
      var ms = String(it.name).match(/vid\s*(\d+)\s*\.\s*\d+/i);
      if (ms && it.mediaType === 'sequence') {
        sets[ms[1]] = 1;
        var sb = String(it.path || '(gốc)').replace(new RegExp('(^|\\D)' + ms[1] + '(?=x\\b|\\b)', 'g'), '$1{bộ}');
        seqBins[sb] = (seqBins[sb] || 0) + 1;
        if (seqNames.length < 3 && !/\b\d+x\d+\b/i.test(it.name)) seqNames.push(it.name);
      }
    });
    var vb = top(voiceBins, 2), sb = top(seqBins, 3), st = Object.keys(sets).map(Number).sort(function (a, b) { return a - b; });
    if (vb.length) lines.push('- Voice ("N.x - <giọng>") nằm ở bin: ' + vb.join(' · '));
    if (sb.length) lines.push('- Sequence của bộ nằm ở bin: ' + sb.join(' · '));
    if (seqNames.length) lines.push('- Tên sequence mẫu: ' + seqNames.join(' · '));
    if (st.length) lines.push('- Các bộ đã có: ' + (st.length > 12 ? st.slice(0, 3).join(', ') + ' … ' + st.slice(-6).join(', ') : st.join(', ')));
    var out = lines.join('\n');
    return out.length > 900 ? out.slice(0, 900) : out;
  }

  return {
    NOTES_MAX: NOTES_MAX, STEP_TYPES: STEP_TYPES, PLATFORMS: PLATFORMS, RATIOS: RATIOS, RAW_MODES: RAW_MODES, TABS: TABS,
    RATIO_LABEL: RATIO_LABEL, RAW_LABEL: RAW_LABEL, TAB_LABEL: TAB_LABEL, SPEC: SPEC,
    problems: problems, chips: chips, isEngine: isEngine, typeLabel: typeLabel, typeDesc: typeDesc, BUILDER_TYPES: BUILDER_TYPES, slotOptions: slotOptions, addable: addable, toggle: toggle,
    empty: empty, normalize: normalize, normButton: normButton, normStep: normStep, fromLegacy: fromLegacy, uid: uid,
    vars: vars, hasVars: hasVars, fill: fill, setRefs: setRefs, stepLabel: stepLabel, stepAction: stepAction,
    exportData: exportData, importData: importData, addNote: addNote, parseRemember: parseRemember,
    habitsEmpty: habitsEmpty, habitsNorm: habitsNorm, cmdTemplate: cmdTemplate, recordCmd: recordCmd,
    recordAction: recordAction, decline: decline, suggest: suggest, suggestName: suggestName,
    projectFacts: projectFacts
  };
})();

(function (root) {
  if (root) { root.CLC = CLC; }
  if (typeof module !== "undefined" && module.exports) { module.exports = CLC; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
