// plugin/cl-custom-ui.js — trang "Tuỳ biến" của tab Claude + kho dữ liệu (global CLSTORE).
//
// Kho (localStorage, mỗi máy một bộ): cl_custom_v1 (nút, quy trình, ghi chú — dạng CLC.normalize),
// cl_habits_v1 (thói quen, CLC.recordCmd/recordAction), cl_learn_v1 ({suggest, facts} bật/tắt tự học).
// Nút lệnh cũ (khoá 'claude-shortcuts') được chuyển sang một lần. Trang mở bằng nút ⚙ cạnh
// "Lệnh | Hỏi tự do"; claude-tab.js nghe CLSTORE.onChange để vẽ lại hàng nút.
var CLSTORE = (function () {
  var KEY = 'cl_custom_v1', HKEY = 'cl_habits_v1', LKEY = 'cl_learn_v1', LEGACY = 'claude-shortcuts';
  var subs = [];
  function read(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var data = read(KEY);
  if (!data) {
    data = CLC.fromLegacy(read(LEGACY) || []);
    write(KEY, data);
  }
  data = CLC.normalize(data);

  return {
    get: function () { return CLC.normalize(data); },
    set: function (d) { data = CLC.normalize(d); write(KEY, data); subs.forEach(function (f) { try { f(data); } catch (e) {} }); },
    onChange: function (f) { subs.push(f); },
    habits: function () { return CLC.habitsNorm(read(HKEY)); },
    setHabits: function (h) { write(HKEY, h); },
    clearHabits: function () { write(HKEY, CLC.habitsEmpty()); },
    learn: function () { var l = read(LKEY) || {}; return { suggest: l.suggest !== false, facts: l.facts !== false }; },
    setLearn: function (l) { write(LKEY, l); }
  };
})();
window.CLSTORE = CLSTORE;

(function () {
  var $ = function (id) { return document.getElementById(id); };
  var page = $('clCustom'), gear = $('clGear');
  if (!page || !gear) return;
  var tab = $('tab-claude');
  var editing = null;       // bản nháp nút đang sửa {…, _new}
  var pop = null;           // ô chip đang mở lựa chọn (trình ráp quy trình)
  var ioMode = '';          // '' | 'export' | 'import'
  var ioMsg = '';
  var pendingImport = '';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(text, cls, onClick) {
    var b = el('div', 'cl-btn' + (cls ? ' ' + cls : ''), text);
    b.setAttribute('role', 'button');
    b.addEventListener('click', onClick);
    return b;
  }
  function kb(input) {
    input.addEventListener('focus', window.claimKeyboard);
    input.addEventListener('blur', window.releaseKeyboard);
    return input;
  }
  function select(opts, val) {
    var s = el('select', 'cu-sel');
    opts.forEach(function (o) {
      var op = el('option', null, o[1]);
      op.value = o[0];
      if (o[0] === val) op.selected = true;
      s.appendChild(op);
    });
    return s;
  }

  function open() {
    editing = null; pop = null; ioMode = ''; ioMsg = '';
    tab.classList.add('is-custom');
    page.hidden = false;
    render();
  }
  function close() {
    tab.classList.remove('is-custom');
    page.hidden = true;
  }
  gear.addEventListener('click', function () { if (page.hidden) open(); else close(); });

  // ── Vẽ trang ──────────────────────────────────────────────────────────────
  function render() {
    var keep = page.scrollTop;
    page.innerHTML = '';
    var d = CLSTORE.get();

    var hd = el('div', 'cu-hd');
    var back = el('div', 'cu-back', '‹ Cài đặt');
    back.setAttribute('role', 'button');
    back.addEventListener('click', close);
    hd.appendChild(back);
    hd.appendChild(el('div', 'cu-sp'));
    hd.appendChild(btn('Nhập', ioMode === 'import' ? 'is-on' : '', function () { ioMode = ioMode === 'import' ? '' : 'import'; ioMsg = ''; pendingImport = ''; render(); }));
    hd.appendChild(btn('Xuất', ioMode === 'export' ? 'is-on' : '', function () { ioMode = ioMode === 'export' ? '' : 'export'; ioMsg = ''; render(); }));
    page.appendChild(hd);
    if (ioMode) page.appendChild(ioBox(d));
    else if (ioMsg) page.appendChild(el('div', 'cu-msg', ioMsg));

    // Thêm mới ở trên — danh sách đã tạo ở dưới (sửa một mục thì mở ngay tại dòng đó)
    var sec = el('div', 'cu-sec');
    sec.appendChild(el('div', 'cu-lbl', 'Thêm mới'));
    if (editing && editing._new) sec.appendChild(editor(d));
    else {
      var add = el('div', 'cu-row-btns cu-addRow');
      add.appendChild(btn('+ Quy trình', 'cu-addBig', function () { pop = null; editing = { id: CLC.uid(), name: '', kind: 'flow', mode: 'command', prompt: '', steps: [], _new: true }; render(); }));
      add.appendChild(btn('+ Lệnh nhanh', 'cu-addBig', function () { pop = null; editing = { id: CLC.uid(), name: '', kind: 'prompt', mode: 'command', prompt: '', steps: [], _new: true }; render(); }));
      sec.appendChild(add);
    }
    page.appendChild(sec);
    sec = el('div', 'cu-sec');
    sec.appendChild(el('div', 'cu-lbl', 'Đã tạo · ' + d.buttons.length));
    if (!d.buttons.length) sec.appendChild(el('div', 'cu-hint', 'Chưa có gì.'));
    d.buttons.forEach(function (b, i) {
      if (editing && editing.id === b.id && !editing._new) { sec.appendChild(editor(d)); return; }
      sec.appendChild(buttonRow(d, b, i));
    });
    page.appendChild(sec);

    page.appendChild(notesSec(d));
    page.appendChild(learnSec());
    page.scrollTop = keep;
  }

  function buttonRow(d, b, i) {
    var row = el('div', 'cu-item');
    row.appendChild(el('span', 'cu-ic' + (b.kind === 'flow' ? ' is-flow' : ''), b.kind === 'flow' ? '▸▸' : '›'));
    var body = el('div', 'cu-body');
    body.appendChild(el('div', 'cu-name', b.name + (b.mode === 'free' ? '  · Hỏi tự do' : '')));
    body.appendChild(el('div', 'cu-sub', b.kind === 'flow' ? b.steps.map(CLC.stepLabel).join('  →  ') : b.prompt));
    row.appendChild(body);
    var tools = el('div', 'cu-tools');
    function move(dir) {
      var j = i + dir;
      if (j < 0 || j >= d.buttons.length) return;
      var t = d.buttons[i]; d.buttons[i] = d.buttons[j]; d.buttons[j] = t;
      CLSTORE.set(d); render();
    }
    [['↑', function () { move(-1); }], ['↓', function () { move(1); }],
     ['✎', function () { pop = null; editing = JSON.parse(JSON.stringify(b)); render(); }]].forEach(function (t) {
      var x = el('div', 'cu-tool', t[0]); x.setAttribute('role', 'button'); x.addEventListener('click', t[1]); tools.appendChild(x);
    });
    var del = el('div', 'cu-tool', '✕'); del.setAttribute('role', 'button');
    var armT = null;
    del.addEventListener('click', function () {
      if (!del.classList.contains('is-armed')) {
        del.classList.add('is-armed'); del.textContent = 'Xoá?';
        armT = setTimeout(function () { del.classList.remove('is-armed'); del.textContent = '✕'; }, 3000);
        return;
      }
      clearTimeout(armT);
      d.buttons.splice(i, 1); CLSTORE.set(d); render();
    });
    tools.appendChild(del);
    row.appendChild(tools);
    return row;
  }

  // ── Trình sửa một nút ─────────────────────────────────────────────────────
  function editor(d) {
    var e = editing, box = el('div', 'cu-edit');
    box.appendChild(el('div', 'cu-lbl', (e._new ? 'Thêm ' : 'Sửa ') + (e.kind === 'flow' ? 'quy trình' : 'nút lệnh')));
    var name = kb(el('input', 'cu-in'));
    name.placeholder = e.kind === 'flow' ? 'Tên nút, vd: Chốt bộ {bộ}' : 'Tên nút, vd: Resize 4x5';
    name.maxLength = 24;
    name.value = e.name;
    name.addEventListener('input', function () { e.name = name.value; });
    box.appendChild(name);

    if (e.kind === 'prompt') {
      var md = select([['command', 'Chế độ Lệnh'], ['free', 'Chế độ Hỏi tự do']], e.mode);
      md.addEventListener('change', function () { e.mode = md.value; });
      box.appendChild(md);
      var pr = kb(el('textarea', 'cu-ta'));
      pr.rows = 3;
      pr.placeholder = 'vd: resize bộ {bộ} sang 4x5 FB — {bộ} {sequence} {sản phẩm} tự điền';
      pr.value = e.prompt;
      pr.addEventListener('input', function () { e.prompt = pr.value; });
      box.appendChild(pr);
    } else {
      if (!e.steps.length) box.appendChild(el('div', 'cu-hint', 'Thêm khối hành động, rồi bấm chip để chọn tham số.'));
      e.steps.forEach(function (s, i) { box.appendChild(stepRow(e, s, i)); });
      var addRow = el('div', 'cu-chipRow');
      addRow.appendChild(chip('+ Khối hành động', 'add' + (pop && pop.step === 'new' ? ' is-open' : ''), function () { pop = pop && pop.step === 'new' ? null : { step: 'new' }; render(); }));
      box.appendChild(addRow);
      if (pop && pop.step === 'new') box.appendChild(popBox(CLC.BUILDER_TYPES.map(function (t) { return { value: t, text: CLC.typeLabel(t), desc: CLC.typeDesc(t) }; }), function (v) {
        e.steps.push(CLC.normStep({ type: v }));
        var ns = e.steps[e.steps.length - 1], miss = CLC.problems(ns);
        pop = CLC.isEngine(v) ? { step: e.steps.length - 1, slot: 'form' }          // khối đơn: mở luôn bảng setting
            : miss.length ? { step: e.steps.length - 1, slot: miss[0] } : null;   // mở luôn ô bắt buộc đầu tiên
        render();
      }));
    }

    var err = el('div', 'cu-err');
    var acts = el('div', 'cu-row-btns cu-right');
    acts.appendChild(btn('Huỷ', '', function () { editing = null; render(); }));
    acts.appendChild(btn('Lưu', 'cl-btn--primary', function () {
      var nb = CLC.normButton(e);
      if (!String(e.name || '').trim()) { err.textContent = 'Đặt tên nút trước.'; return; }
      if (e.kind === 'flow') {
        var badStep = -1;
        e.steps.forEach(function (st, k) { if (badStep < 0 && CLC.problems(st).length) badStep = k; });
        if (badStep >= 0) { err.textContent = 'Bước ' + (badStep + 1) + ' chưa đủ (chip viền đỏ).'; return; }
      }
      if (!nb) { err.textContent = e.kind === 'flow' ? 'Quy trình cần ít nhất một bước.' : 'Nhập lệnh cho nút.'; return; }
      var dd = CLSTORE.get(), idx = -1;
      dd.buttons.forEach(function (b, i) { if (b.id === nb.id) idx = i; });
      if (idx >= 0) dd.buttons[idx] = nb; else dd.buttons.push(nb);
      CLSTORE.set(dd);
      editing = null; render();
    }));
    box.appendChild(err);
    box.appendChild(acts);
    return box;
  }

  // ── Trình ráp chip ────────────────────────────────────────────────────────
  // pop = ô đang mở lựa chọn: {step: i | 'new', slot: 'type'|'platform'|…|'+'}
  var MULTI = { ratios: 1, seqs: 1 };
  function chip(text, cls, onClick) {
    var c = el('div', 'cu-chip ' + (cls || ''), text);
    c.setAttribute('role', 'button');
    c.addEventListener('click', onClick);
    return c;
  }
  function popBox(opts, onPick, multi) {
    var p = el('div', 'cu-pop' + (opts.some(function (o) { return o.desc; }) ? ' cu-popList' : ''));
    opts.forEach(function (o) {
      if (o.desc) {                                   // danh sách khối: tên + mô tả ngắn từng khối
        var r = el('div', 'cu-typeOpt' + (o.on ? ' is-on' : ''));
        r.setAttribute('role', 'button');
        r.appendChild(el('span', 'cu-chip act', o.text));
        r.appendChild(el('span', 'cu-typeDesc', o.desc));
        r.addEventListener('click', function () { onPick(o.value); });
        p.appendChild(r);
        return;
      }
      p.appendChild(chip(o.text, (o.kind || 'par') + (o.on ? ' is-on' : ''), function () { onPick(o.value); }));
    });
    if (multi) p.appendChild(chip('Xong', 'done', function () { pop = null; render(); }));
    return p;
  }
  // ── Bảng setting của khối đơn (flow-engine.js) ─────────────────────────────
  // Mỗi dòng: nhãn + ô chọn (+ ô gõ khi cần). Đổi gì cũng chuẩn hoá lại bằng FLE.normStep.
  function engineForm(e, i, s) {
    var f = el('div', 'cu-pop cu-form');
    function set(patch) { var n = JSON.parse(JSON.stringify(s)); for (var k in patch) n[k] = patch[k]; e.steps[i] = FLE.normStep(n); render(); }
    function row(label, ctl, extra) {
      var r = el('div', 'cu-fRow');
      r.appendChild(el('span', 'cu-fLbl', label));
      var c = el('div', 'cu-fCtl');
      c.appendChild(ctl);
      if (extra) c.appendChild(extra);
      r.appendChild(c);
      f.appendChild(r);
    }
    function sel(opts, val, onChange) {
      var x = select(opts, val);
      x.addEventListener('change', function () { onChange(x.value); });
      return x;
    }
    function txt(val, ph, onChange) {
      var x = kb(el('input', 'cu-in'));
      x.value = val || ''; x.placeholder = ph || '';
      x.addEventListener('change', function () { onChange(x.value); });
      return x;
    }
    var prevSteps = [];
    for (var k = 1; k <= i; k++) prevSteps.push(['step:' + k, 'Kết quả bước ' + k]);
    var binSteps = prevSteps.map(function (p) { return [p[0], 'Bin bước ' + p[0].split(':')[1]]; });
    function refBox(ref, onChange) { return txt(ref.k === 'match' ? ref.text : '', 'loại, vd GG Dọc — trống = FB gốc', function (v) { onChange(v.trim() ? { k: 'match', text: v.trim() } : { k: 'base' }); }); }

    if (s.type === 'platform') {
      row('Nền tảng', sel([['FB', 'FB'], ['GG', 'GG'], ['PIN', 'PIN'], ['APP', 'APP']], s.p, function (v) { set({ p: v }); }));
      if (s.p === 'FB') row('Chế độ', sel([['new', 'Tạo mới (NAV — bộ frame)'], ['resize', 'Resize 9:16 ⇄ 4:5']], s.mode, function (v) { set({ mode: v }); }));
      if (s.p === 'FB' && s.mode === 'new') row('FPS', sel([['30', '30 fps (mặc định)'], ['project', 'Theo project']], s.fps, function (v) { set({ fps: v }); }));
      f.appendChild(el('div', 'cu-hint cu-fHint', 'Khối phía sau để "Theo nền tảng" là tự đọc bin, tên, khung, ratio của nền tảng này từ bộ trước.'));
      return f;
    }
    if (s.src) {
      var sv = s.src.k === 'step' ? 'step:' + s.src.n : s.src.k;
      row('Nguồn', sel((s.type === 'seq_clone' ? [['plat', 'Khung theo nền tảng (bộ trước)']] : s.type === 'render' ? [['video', 'Mọi bản của video mà bộ trước đã render']] : []).concat([['base', 'FB gốc của video'], ['prev', 'Bản cùng loại ở bộ trước'], ['current', 'Đang chọn / mở']]).concat(prevSteps), sv, function (v) {
        set({ src: v.indexOf('step:') === 0 ? { k: 'step', n: Number(v.split(':')[1]) } : v === 'prev' ? { k: 'prev', ref: { k: 'match', text: '' } } : { k: v } });   // plat / base / current
      }), s.src.k === 'prev' ? refBox(s.src.ref, function (r) { set({ src: { k: 'prev', ref: r } }); }) : null);
    }
    if (s.name) {
      row('Tên', sel([['plat', 'Theo nền tảng'], ['learn', 'Học theo loại ở bộ trước'], ['tpl', 'Mẫu tự gõ']], s.name.k, function (v) {
        set({ name: v === 'tpl' ? { k: 'tpl', text: '{SP} vid{bộ}.{số} [{CO}] [{ED}]' } : v === 'plat' ? { k: 'plat' } : { k: 'learn', ref: { k: 'base' } } });
      }), s.name.k === 'tpl'
        ? txt(s.name.text, '{SP} vid{bộ}.{số} [{CO}] [{ED}]', function (v) { set({ name: { k: 'tpl', text: v } }); })
        : s.name.k === 'learn' ? refBox(s.name.ref, function (r) { set({ name: { k: 'learn', ref: r } }); }) : null);
    }
    if (s.type === 'seq_make') {
      row('Khung', sel([['set', 'Theo bộ frame (chọn lúc chạy)'], ['prev', 'Như bộ trước (chép cài đặt)'], ['9-16', '9:16'], ['4-5', '4:5'], ['1-1', '1:1'], ['16-9', '16:9'], ['2-3', '2:3']], s.frame, function (v) { set({ frame: v }); }));
    }
    if (s.type === 'seq_resize') {
      row('Ratio', sel([['plat', 'Theo nền tảng'], ['other', 'Ratio còn lại (9:16 ⇄ 4:5)'], ['prev', 'Như bộ trước'], ['9-16', '9:16'], ['4-5', '4:5'], ['1-1', '1:1'], ['2-3', '2:3']], s.ratio, function (v) { set({ ratio: v }); }));
      row('Nhãn', sel([['plat', 'Theo nền tảng'], ['GG', 'GG'], ['FB', 'FB'], ['PIN', 'PIN'], ['prev', 'Như bộ trước']], s.platform, function (v) { set({ platform: v }); }));
    }
    if (s.type === 'raw_export') {
      row('Chế độ', sel([['both', 'Source + Render'], ['source', 'Source (raw/)'], ['render', 'Render (edited/)']], s.mode, function (v) { set({ mode: v }); }));
      row('Xuất', sel([['1', 'Tự xuất'], ['0', 'Chỉ chuẩn bị tab RAW']], s.auto ? '1' : '0', function (v) { set({ auto: v === '1' }); }));
    }
    if (s.bin) {
      var bv = s.bin.k === 'step' ? 'step:' + s.bin.n : s.bin.k;
      var bopts = [['plat', 'Theo nền tảng'], ['tpl', 'Mẫu tự gõ'], ['prev', 'Như bộ trước']].concat(binSteps);
      if (s.type !== 'bin_make' && s.type !== 'seq_make') bopts.push(['src', 'Cùng bin nguồn']);
      row('Bin', sel(bopts, bv, function (v) {
        set({ bin: v.indexOf('step:') === 0 ? { k: 'step', n: Number(v.split(':')[1]) } : v === 'tpl' ? { k: 'tpl', text: 'Sequence / FB / {bộ}x' } : v === 'prev' ? { k: 'prev', ref: { k: 'base' } } : v === 'plat' ? { k: 'plat' } : { k: 'src' } });
      }), s.bin.k === 'tpl' ? txt(s.bin.text, 'Sequence / GG / {bộ}x / {bộ}.{số}', function (v) { set({ bin: { k: 'tpl', text: v } }); })
        : s.bin.k === 'prev' ? refBox(s.bin.ref, function (r) { set({ bin: { k: 'prev', ref: r } }); }) : null);
    }
    f.appendChild(el('div', 'cu-hint cu-fHint', 'Biến: {bộ} {số} {SP} {CO} {ED} {ngày} — CO / ED / SP lấy từ bộ trước. Bấm chip để đóng.'));
    return f;
  }

  function textPop(e, i, s) {
    var p = el('div', 'cu-pop');
    var inp = kb(el('input', 'cu-in'));
    inp.placeholder = s.type === 'wait' ? 'vd: đặt video bộ {bộ} vào khung rồi bấm Tiếp tục'
                    : s.type === 'pin_order' ? 'tên đơn, vd Order Oct 05 26 — trống = hôm nay' : 'vd: soát lại tên voice bộ {bộ}';
    inp.value = s.text || '';
    p.appendChild(inp);
    p.appendChild(chip('OK', 'done', function () { e.steps[i] = CLC.normStep(Object.assign({}, s, { text: inp.value })); pop = null; render(); }));
    return p;
  }
  function stepRow(e, s, i) {
    var wrap = el('div', 'cu-stepBox');
    var row = el('div', 'cu-chipRow');
    row.appendChild(el('span', 'cu-stepN', (i + 1) + ''));
    var miss = CLC.problems(s);
    CLC.chips(s).forEach(function (c) {
      var open = pop && pop.step === i && pop.slot === c.slot;
      row.appendChild(chip(c.text, c.kind + (c.missing ? ' is-missing' : '') + (open ? ' is-open' : ''), function () {
        pop = open ? null : { step: i, slot: c.slot }; render();
      }));
    });
    if (CLC.addable(s).length) {
      var openAdd = pop && pop.step === i && pop.slot === '+';
      row.appendChild(chip('+', 'add' + (openAdd ? ' is-open' : ''), function () { pop = openAdd ? null : { step: i, slot: '+' }; render(); }));
    }
    var tools = el('span', 'cu-stepTools');
    [['↑', -1], ['↓', 1]].forEach(function (t) {
      tools.appendChild(chip(t[0], 'tool', function () {
        var j = i + t[1];
        if (j < 0 || j >= e.steps.length) return;
        var tmp = e.steps[i]; e.steps[i] = e.steps[j]; e.steps[j] = tmp; pop = null; render();
      }));
    });
    tools.appendChild(chip('✕', 'tool', function () { e.steps.splice(i, 1); pop = null; render(); }));
    row.appendChild(tools);
    wrap.appendChild(row);
    if (miss.length) wrap.appendChild(el('div', 'cu-miss', 'Thiếu: ' + miss.map(function (k) { return { platform: 'nền tảng', seqs: 'sequence', mode: 'chế độ', tab: 'tab', text: 'lệnh' }[k] || k; }).join(', ')));
    if (pop && pop.step === i) {
      if (pop.slot === '+') {
        wrap.appendChild(popBox(CLC.addable(s).map(function (a) { return { value: a.slot, text: a.text }; }), function (v) { pop = { step: i, slot: v }; render(); }));
      } else if (pop.slot === 'form') {
        wrap.appendChild(engineForm(e, i, s));
      } else if (pop.slot === 'text') {
        wrap.appendChild(textPop(e, i, s));
      } else {
        var opts = CLC.slotOptions(s, pop.slot).map(function (o) { o.kind = pop.slot === 'seqs' ? 'seq' : pop.slot === 'type' ? 'act' : 'par'; return o; });
        wrap.appendChild(popBox(opts, function (v) {
          e.steps[i] = CLC.toggle(s, pop.slot, v);
          if (!MULTI[pop.slot]) {                       // chọn một → mở ô bắt buộc kế tiếp (nếu còn)
            var m = CLC.problems(e.steps[i]);
            pop = m.length ? { step: i, slot: m[0] } : null;
          }
          render();
        }, !!MULTI[pop.slot]));
      }
    }
    return wrap;
  }

  // ── Ghi chú ──────────────────────────────────────────────────────────────
  function notesSec(d) {
    var sec = el('div', 'cu-sec');
    sec.appendChild(el('div', 'cu-lbl', 'Ghi chú cho Claude'));
    var ta = kb(el('textarea', 'cu-ta cu-notes'));
    ta.rows = 5;
    ta.maxLength = CLC.NOTES_MAX;
    ta.placeholder = 'Vd: Mình làm AeriSoft. Voice hay dùng Audrey. Resize xong luôn RAW cả 2 bản.';
    ta.value = d.notes;
    var cnt = el('div', 'cu-count', d.notes.length + '/' + CLC.NOTES_MAX);
    var t = null;
    ta.addEventListener('input', function () {
      cnt.textContent = ta.value.length + '/' + CLC.NOTES_MAX;
      clearTimeout(t);
      t = setTimeout(function () { var dd = CLSTORE.get(); dd.notes = ta.value; CLSTORE.set(dd); }, 400);
    });
    sec.appendChild(ta);
    sec.appendChild(cnt);
    return sec;
  }

  // ── Tự học ───────────────────────────────────────────────────────────────
  function learnSec() {
    var sec = el('div', 'cu-sec'), l = CLSTORE.learn();
    sec.appendChild(el('div', 'cu-lbl', 'Tự học'));
    function toggle(key, label, sub) {
      var row = el('div', 'cu-tog' + (l[key] ? ' is-on' : ''));
      row.setAttribute('role', 'button');
      row.appendChild(el('span', 'cl-mvTick'));
      var b = el('span', 'cu-body');
      b.appendChild(el('span', 'cu-name', label));
      b.appendChild(el('span', 'cu-sub', sub));
      row.appendChild(b);
      row.addEventListener('click', function () { l[key] = !l[key]; CLSTORE.setLearn(l); render(); });
      sec.appendChild(row);
    }
    toggle('suggest', 'Gợi ý lưu khi lặp lại', 'lặp 3 lần → hỏi lưu thành nút / quy trình');
    toggle('facts', 'Đọc quy ước project', 'bin voice, bin sequence, tên mẫu');
    var h = CLSTORE.habits(), n = Object.keys(h.cmds).length + Object.keys(h.pairs).length;
    var row = el('div', 'cu-row-btns');
    row.appendChild(el('span', 'cu-hint cu-grow', 'Đã ghi ' + n + ' thói quen.'));
    if (n || h.no.length) row.appendChild(btn('Quên hết', '', function () { CLSTORE.clearHabits(); render(); }));
    sec.appendChild(row);
    return sec;
  }

  // ── Xuất / nhập ──────────────────────────────────────────────────────────
  function ioBox(d) {
    var box = el('div', 'cu-io');
    var err = el('div', 'cu-err');
    if (ioMode === 'export') {
      var parts = { buttons: true, notes: true };
      [['buttons', 'Nút và quy trình (' + d.buttons.length + ')'], ['notes', 'Ghi chú']].forEach(function (p) {
        var r = el('div', 'cu-tog is-on'); r.setAttribute('role', 'button');
        r.appendChild(el('span', 'cl-mvTick')); r.appendChild(el('span', 'cu-name', p[1]));
        r.addEventListener('click', function () { parts[p[0]] = !parts[p[0]]; r.classList.toggle('is-on', parts[p[0]]); });
        box.appendChild(r);
      });
      box.appendChild(btn('Lưu file .json', 'cl-btn--primary', async function () {
        if (!parts.buttons && !parts.notes) { err.textContent = 'Chọn ít nhất một phần.'; return; }
        try {
          var lfs = require('uxp').storage.localFileSystem;
          var f = await lfs.getFileForSaving('claude-tuy-bien.json', { types: ['json'] });
          if (!f) return;
          await f.write(CLC.exportData(CLSTORE.get(), parts));
          ioMode = ''; ioMsg = '✓ Đã xuất ' + (f.name || 'file') + ' — gửi file này cho member khác bấm Nhập.'; render();
        } catch (e) { err.textContent = 'Không lưu được: ' + e.message; }
      }));
    } else {
      if (!pendingImport) {
        box.appendChild(el('div', 'cu-hint', 'Chọn file .json do member khác xuất.'));
        box.appendChild(btn('Chọn file…', 'cl-btn--primary', async function () {
          try {
            var lfs = require('uxp').storage.localFileSystem;
            var f = await lfs.getFileForOpening({ types: ['json'] });
            if (!f) return;
            pendingImport = await f.read();
            var test = CLC.importData(CLSTORE.get(), pendingImport, 'merge');
            if (test.error) { pendingImport = ''; err.textContent = test.error; return; }
            render();
          } catch (e) { err.textContent = 'Không đọc được file: ' + e.message; }
        }));
      } else {
        box.appendChild(el('div', 'cu-hint', 'Gộp: thêm nút chưa có, nối ghi chú. Thay thế: bỏ bộ đang có, dùng bộ trong file.'));
        var row = el('div', 'cu-row-btns');
        function apply(mode) {
          var r = CLC.importData(CLSTORE.get(), pendingImport, mode);
          if (r.error) { err.textContent = r.error; return; }
          CLSTORE.set(r.data);
          pendingImport = ''; ioMode = '';
          ioMsg = '✓ Đã ' + (mode === 'merge' ? 'gộp thêm ' : 'thay bằng ') + r.added + ' nút.';
          render();
        }
        row.appendChild(btn('Gộp thêm', 'cl-btn--primary', function () { apply('merge'); }));
        var rep = btn('Thay thế', '', function () {
          if (!rep.classList.contains('is-armed')) { rep.classList.add('is-armed'); rep.textContent = 'Bấm lại để thay'; return; }
          apply('replace');
        });
        row.appendChild(rep);
        row.appendChild(btn('Huỷ', '', function () { pendingImport = ''; ioMode = ''; render(); }));
        box.appendChild(row);
      }
    }
    box.appendChild(err);
    return box;
  }

  // Mở thẳng trình sửa: b = quy trình có sẵn (Sửa), null = quy trình mới (từ bảng điều khiển).
  function edit(b, kind) {
    open();
    pop = null;
    editing = b ? JSON.parse(JSON.stringify(b)) : { id: CLC.uid(), name: '', kind: kind === 'prompt' ? 'prompt' : 'flow', mode: 'command', prompt: '', steps: [], _new: true };
    render();
  }
  window.ClaudeCustomUI = { open: open, close: close, render: render, edit: edit };
})();
