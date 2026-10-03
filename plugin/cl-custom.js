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
  var STEP_TYPES = ['fix_voice_bins', 'resize', 'rawcut', 'open_tab', 'prompt'];

  function str(v, max) { return String(v == null ? '' : v).slice(0, max || 2000); }
  function uid() { return 'b' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

  function empty() { return { v: 1, buttons: [], notes: '' }; }

  function normStep(s) {
    if (!s || typeof s !== 'object' || STEP_TYPES.indexOf(s.type) < 0) return null;
    var scope = s.scope === 'set' ? 'set' : 'current';
    if (s.type === 'fix_voice_bins') return { type: 'fix_voice_bins' };
    if (s.type === 'resize') {
      if (PLATFORMS.indexOf(s.platform) < 0) return null;
      var rs = (Array.isArray(s.ratios) ? s.ratios : []).filter(function (r) { return RATIOS.indexOf(r) >= 0; });
      return { type: 'resize', platform: s.platform, ratios: rs, scope: scope };
    }
    if (s.type === 'rawcut') {
      if (RAW_MODES.indexOf(s.mode) < 0) return null;
      return { type: 'rawcut', mode: s.mode, scope: scope };
    }
    if (s.type === 'open_tab') return TABS.indexOf(s.tab) >= 0 ? { type: 'open_tab', tab: s.tab } : null;
    var t = str(s.text, 2000).trim();
    return t ? { type: 'prompt', text: t } : null;
  }

  function normButton(b) {
    if (!b || typeof b !== 'object') return null;
    var name = str(b.name, 24).trim();
    if (!name) return null;
    var out = { id: str(b.id, 40) || uid(), name: name, kind: b.kind === 'flow' ? 'flow' : 'prompt',
                mode: b.mode === 'free' ? 'free' : 'command', prompt: '', steps: [] };
    if (out.kind === 'flow') {
      out.steps = (Array.isArray(b.steps) ? b.steps : []).map(normStep).filter(Boolean).slice(0, MAX_STEPS);
      if (!out.steps.length) return null;
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
  // Sequence gốc của bộ: tên có vid{set}.N, không có đuôi ratio kiểu "4x5" (bản đã resize).
  function setRefs(items, set) {
    if (!set) return [];
    var re = new RegExp('vid\\s*' + set + '\\s*\\.\\s*\\d+(?!\\d)', 'i');
    return (items || []).filter(function (it) {
      return it && !it.isFolder && it.mediaType === 'sequence' && re.test(it.name) && !/\b\d+x\d+\b/i.test(it.name);
    }).map(function (it) { return (it.path || '') + ' ▸ ' + it.name; });
  }

  var RATIO_LABEL = { '9-16': '9:16', '4-5': '4:5', '1-1': '1:1', '2-3': '2:3' };
  var RAW_LABEL = { source: 'source (raw/)', render: 'render (edited/)', both: 'source + render' };
  var TAB_LABEL = { voicegen: 'Voice Gen', autocut: 'Autocut', subtext: 'Tạo Sub', unnest: 'Un-nest',
                    watch: 'Watch', resize: 'Resize', rawcut: 'RAW' };
  function stepLabel(s) {
    var sc = s.scope === 'set' ? ' · cả bộ {bộ}' : '';
    if (s.type === 'fix_voice_bins') return 'Soát bin voice';
    if (s.type === 'resize') return 'Resize · ' + s.platform + ' · ' + (s.ratios.length ? s.ratios.map(function (r) { return RATIO_LABEL[r]; }).join(', ') : 'mọi ratio') + sc;
    if (s.type === 'rawcut') return 'RAW · ' + RAW_LABEL[s.mode] + sc;
    if (s.type === 'open_tab') return 'Mở tab ' + TAB_LABEL[s.tab];
    return 'Hỏi Claude: ' + s.text;
  }

  // ctx = {vars, items}. → {action} | {prompt} | {error}
  function stepAction(s, ctx) {
    ctx = ctx || {};
    var v = ctx.vars || {};
    function refs() {
      if (s.scope !== 'set') return { items: [] };
      if (!v['bộ']) return { error: 'không biết bộ nào — mở một sequence của bộ trước (tên có vid{bộ}.N)' };
      var r = setRefs(ctx.items, v['bộ']);
      return r.length ? { items: r } : { error: 'không thấy sequence nào của bộ ' + v['bộ'] };
    }
    if (s.type === 'fix_voice_bins') return { action: { action: 'fix_voice_bins' } };
    if (s.type === 'open_tab') return { action: { action: 'open_tab', tab: s.tab } };
    if (s.type === 'resize' || s.type === 'rawcut') {
      var r = refs();
      if (r.error) return { error: r.error };
      if (s.type === 'resize') return { action: { action: 'resize', platform: s.platform, ratios: s.ratios.map(function (x) { return RATIO_LABEL[x]; }), items: r.items } };
      return { action: { action: 'rawcut', mode: s.mode, items: r.items } };
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
  var LEARN_ACTS = ['fix_voice_bins', 'resize', 'rawcut', 'move_items', 'open_tab'];
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
    var scope = a.items && a.items.length > 1 ? 'set' : 'current';
    if (a.action === 'resize') return { type: 'resize', platform: a.platform, ratios: (a.ratios || []).slice(), scope: scope };
    if (a.action === 'rawcut') return { type: 'rawcut', mode: a.mode, scope: scope };
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
      return x.type === 'fix_voice_bins' ? 'Voice' : x.type === 'resize' ? 'Resize ' + x.platform : x.type === 'rawcut' ? 'RAW' : TAB_LABEL[x.tab] || x.type;
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
    RATIO_LABEL: RATIO_LABEL, RAW_LABEL: RAW_LABEL, TAB_LABEL: TAB_LABEL,
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
