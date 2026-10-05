// plugin/cl-dash.js — màn chính tab Claude = bảng điều khiển (global ClaudeDash).
//
// Bảng điều khiển: sản phẩm + bộ đang mở, thẻ quy trình của bro, gợi ý Claude học được
// (CLC.suggest), vài lệnh gần đây; ô lệnh vẫn ở đáy. Bấm thẻ quy trình → PHIẾU CHẠY: bộ (sửa
// được), tick video của bộ (video đã dựng xong bỏ tick sẵn), nền tảng, xem trước các bước →
// "Chạy cho N video" (ClaudeTab.runFlow với over {set, idxs, platform}). Không có gì tự chạy.
// Dùng global: CLC, BSC, CLSTORE, PTOOLS, ClaudeTab, ClaudeCustomUI.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var dash = $('clDash'), sheet = $('clSheet');
  if (!dash || !sheet || !window.ClaudeTab) return;
  var T = window.ClaudeTab;

  // Quy trình dựng sẵn (một lần / máy): "Resize GG" theo luồng user mô tả 2026-10-05.
  var SEED_KEY = 'cl_seed_v1';
  try {
    if (!localStorage.getItem(SEED_KEY)) {
      var d0 = CLSTORE.get();
      if (!d0.buttons.some(function (b) { return b.name === 'Resize GG'; })) {
        d0.buttons.unshift({ name: 'Resize GG', kind: 'flow', steps: [
          { type: 'bin_set', platform: 'GG', seqs: [{ k: 'set' }] },
          { type: 'wait', text: 'Đặt video vào khung GG dọc / ngang / vuông bộ {bộ} rồi bấm Tiếp tục' }
        ] });
        CLSTORE.set(d0);
      }
      localStorage.setItem(SEED_KEY, '1');
    }
  } catch (e) {}

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
  function stepsText(b) {
    return b.kind === 'flow' ? b.steps.map(function (s) { return CLC.SPEC[s.type].label; }).join(' → ') : b.prompt;
  }

  // ── Bảng điều khiển ───────────────────────────────────────────────────────
  function render() {
    dash.innerHTML = '';
    var v = CLC.vars(T.seqName());
    var top = el('div', 'cd-ctx');
    top.appendChild(el('span', 'cd-sp', v['sản phẩm'] ? v['sản phẩm'] + ' · bộ ' + v['bộ'] : 'Chưa mở sequence của bộ nào'));
    if (v['sequence']) top.appendChild(el('span', 'cd-dim', 'đang mở ' + (v['sequence'].match(/vid\s*\d+\.\d+/i) || [v['sequence']])[0]));
    dash.appendChild(top);

    var d = CLSTORE.get(), flows = d.buttons.filter(function (b) { return b.kind === 'flow'; });
    dash.appendChild(el('div', 'cd-lbl', 'Quy trình'));
    flows.forEach(function (b) {
      var c = el('div', 'cd-card');
      c.setAttribute('role', 'button');
      var h = el('div', 'cd-cardHd');
      h.appendChild(el('span', 'cd-name', b.name));
      h.appendChild(el('span', 'cd-dim', b.steps.length + ' bước'));
      c.appendChild(h);
      c.appendChild(el('div', 'cd-dim', stepsText(b)));
      c.addEventListener('click', function () { openSheet(b); });
      dash.appendChild(c);
    });
    var nw = el('div', 'cd-card cd-new', '+ Tạo quy trình mới');
    nw.setAttribute('role', 'button');
    nw.addEventListener('click', function () { window.ClaudeCustomUI.edit(null); });
    dash.appendChild(nw);

    // Gợi ý Claude học được (thói quen lặp lại)
    var sg = CLSTORE.learn().suggest ? CLC.suggest(CLSTORE.habits(), d) : null;
    if (sg) {
      dash.appendChild(el('div', 'cd-lbl', 'Claude gợi ý'));
      var g = el('div', 'cd-card cd-suggest');
      g.appendChild(el('div', 'cd-sgT', sg.kind === 'flow' ? 'Bro hay làm liền: ' + CLC.suggestName(sg) + ' (' + sg.n + ' lần)' : 'Bro gõ lệnh này ' + sg.n + ' lần'));
      g.appendChild(el('div', 'cd-dim', sg.kind === 'flow' ? sg.steps.map(CLC.stepLabel).join('  →  ') : sg.text));
      var row = el('div', 'cl-askBtns');
      row.appendChild(btn(sg.kind === 'flow' ? 'Lưu thành quy trình' : 'Lưu thành nút', 'cl-btn--primary', function () {
        var dd = CLSTORE.get();
        dd.buttons.push(sg.kind === 'flow' ? { name: CLC.suggestName(sg), kind: 'flow', steps: sg.steps }
                                           : { name: CLC.suggestName(sg), kind: 'prompt', mode: 'command', prompt: sg.text });
        CLSTORE.set(dd); T.saveSuggest(sg); render();
      }));
      row.appendChild(btn('Bỏ', '', function () { T.declineSuggest(sg); render(); }));
      g.appendChild(row);
      dash.appendChild(g);
    }

    // Lệnh gần đây → mở lịch sử
    var h = T.history().slice(-3).reverse();
    var lh = el('div', 'cd-lbl cd-lblRow');
    lh.appendChild(el('span', null, 'Lệnh gần đây'));
    var all = el('span', 'cd-link', 'Xem lịch sử ›');
    all.setAttribute('role', 'button');
    all.addEventListener('click', function () { T.showView('log'); });
    lh.appendChild(all);
    dash.appendChild(lh);
    if (!h.length) dash.appendChild(el('div', 'cd-dim', 'Chưa có lệnh nào — gõ ở ô dưới, hoặc bấm một quy trình.'));
    h.forEach(function (r) {
      var bad = r.err || (r.acts || []).some(function (a) { return a.cls === 'is-error'; });
      var x = el('div', 'cd-recent', '› ' + r.cmd.split('\n')[0].slice(0, 60) + (bad ? '  ✗' : '  ✓'));
      x.setAttribute('role', 'button');
      x.addEventListener('click', function () { T.showView('log'); });
      dash.appendChild(x);
    });
  }

  // ── Phiếu chạy ────────────────────────────────────────────────────────────
  // Bước có sequence (khác "đang mở") → chọn bộ + video; bước có nền tảng → chọn lại được.
  async function openSheet(b) {
    if (T.busy()) return;
    T.showView('sheet');
    var v = CLC.vars(T.seqName());
    var st = { set: v['bộ'], idxs: null, platform: '', items: null, rows: null };
    var usesSeq = b.steps.some(function (s) { return s.seqs && s.seqs.length && s.seqs[0].k !== 'current'; });
    var plats = {};
    b.steps.forEach(function (s) { if (s.platform) plats[s.platform] = 1; });
    st.platform = Object.keys(plats).length === 1 ? Object.keys(plats)[0] : '';
    var binStep = b.steps.filter(function (s) { return s.type === 'bin_set'; })[0];

    async function load() {
      st.items = st.items || await PTOOLS.snapshot();
      st.rows = null;
      if (!st.items || !/^\d+$/.test(String(st.set || ''))) return;
      var src = BSC.fbSources(st.items, st.set);
      var done = {};
      if (binStep) {                                   // video đã dựng đủ bin → bỏ tick sẵn
        var p = BSC.plan(st.items, { platform: st.platform || binStep.platform, set: st.set });
        (p.rows || []).forEach(function (r) {
          if (r.error) return;
          var ok = r.res1.exists && r.res2.exists && r.targets.every(function (t) { return t.exists || !t.from; });
          if (ok) done[r.idx] = 'đã dựng ' + (st.platform || binStep.platform);
        });
      }
      st.rows = Object.keys(src).map(Number).sort(function (a, c) { return a - c; }).map(function (n) {
        return { idx: n, name: src[n].name, done: done[n] || '' };
      });
      // video mặc định: theo bước đầu (vid .N cụ thể) hoặc mọi video chưa dựng
      var first = b.steps.filter(function (s) { return s.seqs && s.seqs[0] && s.seqs[0].k === 'idx'; })[0];
      st.idxs = st.rows.filter(function (r) {
        return first ? first.seqs.some(function (q) { return q.n === r.idx; }) : !r.done;
      }).map(function (r) { return r.idx; });
    }

    function draw() {
      sheet.innerHTML = '';
      var hd = el('div', 'cd-sheetHd');
      var back = el('div', 'cd-link', '‹ ' + b.name);
      back.setAttribute('role', 'button');
      back.addEventListener('click', function () { T.showView('dash'); });
      hd.appendChild(back);
      hd.appendChild(el('span', 'cd-grow'));
      var ed = el('span', 'cd-link cd-dim', 'Sửa quy trình');
      ed.setAttribute('role', 'button');
      ed.addEventListener('click', function () { window.ClaudeCustomUI.edit(b); });
      hd.appendChild(ed);
      sheet.appendChild(hd);

      if (usesSeq) {
        sheet.appendChild(el('div', 'cd-lbl', 'Bộ'));
        var row = el('div', 'cd-setRow');
        var inp = el('input', 'cu-in cd-setIn');
        inp.value = st.set || '';
        inp.placeholder = 'số bộ';
        inp.addEventListener('focus', window.claimKeyboard);
        inp.addEventListener('blur', window.releaseKeyboard);
        inp.addEventListener('change', async function () { st.set = inp.value.trim(); await load(); draw(); });
        row.appendChild(inp);
        row.appendChild(el('span', 'cd-dim', st.set === v['bộ'] ? 'bộ của sequence đang mở' : 'gõ số bộ rồi Enter'));
        sheet.appendChild(row);

        sheet.appendChild(el('div', 'cd-lbl', 'Video nào'));
        if (!st.rows) sheet.appendChild(el('div', 'cd-dim', st.set ? 'Đang đọc project…' : 'Mở một sequence vid{bộ}.N hoặc gõ số bộ.'));
        else if (!st.rows.length) sheet.appendChild(el('div', 'cd-dim', 'Không thấy sequence FB gốc nào của bộ ' + st.set + '.'));
        else st.rows.forEach(function (r) {
          var on = st.idxs.indexOf(r.idx) >= 0;
          var line = el('div', 'cl-mv' + (on ? ' is-on' : ''));
          line.innerHTML = '<span class="cl-mvTick"></span><span class="cl-mvBody"><span class="cl-mvName"></span><span class="cl-mvPath"></span></span>';
          line.querySelector('.cl-mvName').textContent = 'vid' + st.set + '.' + r.idx;
          line.querySelector('.cl-mvPath').textContent = r.done || r.name.replace(/\s*\[[^\]]*\]/g, '');
          line.addEventListener('click', function () {
            var i = st.idxs.indexOf(r.idx);
            if (i >= 0) st.idxs.splice(i, 1); else st.idxs.push(r.idx);
            draw();
          });
          sheet.appendChild(line);
        });
      }

      if (st.platform) {
        var opts = [];
        b.steps.forEach(function (s) { if (s.platform) CLC.slotOptions(s, 'platform').forEach(function (o) { if (opts.indexOf(o.value) < 0) opts.push(o.value); }); });
        sheet.appendChild(el('div', 'cd-lbl', 'Nền tảng'));
        var pr = el('div', 'cu-chipRow');
        opts.forEach(function (p) {
          var c = el('div', 'cu-chip par' + (p === st.platform ? '' : ' cd-off'), p);
          c.setAttribute('role', 'button');
          c.addEventListener('click', async function () { st.platform = p; await load(); draw(); });
          pr.appendChild(c);
        });
        sheet.appendChild(pr);
      }

      sheet.appendChild(el('div', 'cd-lbl', 'Các bước'));
      b.steps.forEach(function (s, i) {
        var t = CLC.stepLabel(s);
        if (st.platform && s.platform) t = t.replace(s.platform, st.platform);
        if (usesSeq && s.seqs && s.seqs.length && s.seqs[0].k !== 'current') t = t.replace(/(vid \.\d+( · )?)+|Cả bộ|Chọn lúc chạy/g, '').replace(/ · $/, '') + ' · video đã chọn';
        sheet.appendChild(el('div', 'cd-step', (i + 1) + ' · ' + t));
      });

      var n = usesSeq ? (st.idxs || []).length : 0;
      var foot = el('div', 'cd-foot');
      foot.appendChild(btn('Huỷ', '', function () { T.showView('dash'); }));
      foot.appendChild(el('span', 'cd-grow'));
      var go = btn(usesSeq ? 'Chạy cho ' + n + ' video' : 'Chạy', 'cl-btn--primary', function () {
        if (usesSeq && !n) return;
        T.runFlow(b, usesSeq ? { set: st.set, idxs: st.idxs.slice().sort(), platform: st.platform } : { platform: st.platform });
      });
      if (usesSeq && !n) go.classList.add('is-disabled');
      foot.appendChild(go);
      sheet.appendChild(foot);
    }

    draw();
    if (usesSeq) { await load(); draw(); }
  }

  var back = $('clBack');
  if (back) back.addEventListener('click', function () { T.showView('dash'); });
  CLSTORE.onChange(function () { render(); });

  window.ClaudeDash = { render: render, openSheet: openSheet };
  render();
})();
