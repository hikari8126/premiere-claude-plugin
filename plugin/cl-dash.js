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

    // Lệnh nhanh (nút lệnh): bấm → điền lệnh vào ô chat, Enter mới gửi
    var prompts = d.buttons.filter(function (b) { return b.kind === 'prompt'; });
    var ph = el('div', 'cd-lbl cd-lblRow');
    ph.appendChild(el('span', null, 'Lệnh nhanh'));
    var addP = el('span', 'cd-link', '+ Thêm');
    addP.setAttribute('role', 'button');
    addP.addEventListener('click', function () { window.ClaudeCustomUI.edit(null, 'prompt'); });
    ph.appendChild(addP);
    dash.appendChild(ph);
    if (!prompts.length) dash.appendChild(el('div', 'cd-dim', 'Lưu câu lệnh hay gõ để bấm là điền sẵn.'));
    else {
      var pr = el('div', 'cu-chipRow');
      prompts.forEach(function (b) {
        var c = el('div', 'cu-chip par cd-prompt', b.name);
        c.setAttribute('role', 'button');
        c.addEventListener('click', function () { T.runButton(b); });
        pr.appendChild(c);
      });
      dash.appendChild(pr);
    }

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
  // Bước có sequence (khác "đang mở") → danh sách video đích: mặc định các video chưa dựng của bộ
  // đang mở; "+" thêm theo BỘ (gõ số bộ) hoặc theo VID (tìm + tick nhiều, mọi bộ trong project).
  // Nhiều bộ → chạy quy trình lần lượt từng bộ. Bước có nền tảng → chọn lại được.
  // Mọi video FB gốc trong project: [{set, idx, name, key:'40.1'}], sắp theo bộ rồi số.
  function allVids(items) {
    var sets = {};
    (items || []).forEach(function (it) {
      var m = !it.isFolder && it.mediaType === 'sequence' && String(it.name).match(/vid\s*(\d+)\s*\.\s*\d+/i);
      if (m) sets[m[1]] = 1;
    });
    var out = [];
    Object.keys(sets).forEach(function (set) {
      var src = BSC.fbSources(items, set);
      Object.keys(src).forEach(function (i) { out.push({ set: set, idx: Number(i), name: src[i].name, key: set + '.' + i }); });
    });
    return out.sort(function (a, c) { return (Number(a.set) - Number(c.set)) || (a.idx - c.idx); });
  }

  async function openSheet(b) {
    if (T.busy()) return;
    T.showView('sheet');
    var v = CLC.vars(T.seqName());
    var st = { items: null, vids: [], targets: [], platform: '', add: '', addErr: '', search: '', ticks: {}, done: {} };
    var usesSeq = b.steps.some(function (s) { return s.seqs && s.seqs.length && s.seqs[0].k !== 'current'; });
    var plats = {};
    b.steps.forEach(function (s) { if (s.platform) plats[s.platform] = 1; });
    st.platform = Object.keys(plats).length === 1 ? Object.keys(plats)[0] : '';
    var binStep = b.steps.filter(function (s) { return s.type === 'bin_set'; })[0];

    // Video đã dựng đủ bin (khối Dựng bin) của một bộ → {idx: true}; tính lại khi đổi nền tảng.
    function doneOf(set) {
      var key = set + '|' + (st.platform || (binStep && binStep.platform));
      if (st.done[key]) return st.done[key];
      var out = {};
      if (binStep && st.items) {
        var p = BSC.plan(st.items, { platform: st.platform || binStep.platform, set: set });
        (p.rows || []).forEach(function (r) {
          if (!r.error && r.res1.exists && r.res2.exists && r.targets.every(function (t) { return t.exists || !t.from; })) out[r.idx] = true;
        });
      }
      return (st.done[key] = out);
    }
    function isDone(t) { return !!doneOf(t.set)[t.idx]; }
    function addTargets(list) {
      var have = st.targets.map(function (t) { return t.key; });
      list.forEach(function (t) { if (have.indexOf(t.key) < 0) st.targets.push(t); });
      st.targets.sort(function (a, c) { return (Number(a.set) - Number(c.set)) || (a.idx - c.idx); });
    }
    async function load() {
      st.items = await PTOOLS.snapshot();
      st.vids = allVids(st.items);
      // mặc định: video chưa dựng của bộ đang mở (theo bước đầu nếu nó chỉ định vid .N)
      var first = b.steps.filter(function (s) { return s.seqs && s.seqs[0] && s.seqs[0].k === 'idx'; })[0];
      addTargets(st.vids.filter(function (x) {
        if (x.set !== v['bộ']) return false;
        return first ? first.seqs.some(function (q) { return q.n === x.idx; }) : !isDone(x);
      }));
    }

    function draw() {
      sheet.innerHTML = '';
      // Đầu trang: ‹ quay lại · tên quy trình · Sửa
      var hd = el('div', 'cd-sheetHd');
      var back = el('div', 'cd-back', '‹');
      back.setAttribute('role', 'button');
      back.addEventListener('click', function () { T.showView('dash'); });
      hd.appendChild(back);
      var ttl = el('div', 'cd-sheetTitle');
      ttl.appendChild(el('div', 'cd-sheetName', b.name));
      ttl.appendChild(el('div', 'cd-dim', b.steps.length + ' bước · ' + b.steps.map(function (s) { return CLC.SPEC[s.type].label; }).join(' → ')));
      hd.appendChild(ttl);
      var ed = el('div', 'cl-btn', '✎ Sửa');
      ed.setAttribute('role', 'button');
      ed.addEventListener('click', function () { window.ClaudeCustomUI.edit(b); });
      hd.appendChild(ed);
      sheet.appendChild(hd);

      var no = 0;
      function section(title, right) {
        var box = el('div', 'cd-sec');
        var h = el('div', 'cd-secHd');
        h.appendChild(el('span', 'cd-secNo', String(++no)));
        h.appendChild(el('span', 'cd-secT', title));
        if (right) h.appendChild(right);
        box.appendChild(h);
        sheet.appendChild(box);
        return box;
      }

      if (usesSeq) {
        var clr = null;
        if (st.targets.length) {
          clr = el('span', 'cd-link', 'Bỏ hết');
          clr.setAttribute('role', 'button');
          clr.addEventListener('click', function () { st.targets = []; draw(); });
        }
        var sq = section('Video' + (st.targets.length ? ' · ' + st.targets.length : ''), clr);
        if (!st.items) sq.appendChild(el('div', 'cd-dim cd-pad', 'Đang đọc project…'));
        else if (!st.targets.length) sq.appendChild(el('div', 'cd-empty', 'Chưa chọn video nào'));
        var chips = el('div', 'cu-chipRow cd-tgtChips');
        st.targets.forEach(function (t) {
          var c = el('div', 'cu-chip seq cd-tgtChip' + (isDone(t) ? ' is-done' : ''), 'vid' + t.key + (isDone(t) ? ' · đã dựng' : '') + '  ✕');
          c.setAttribute('role', 'button');
          c.addEventListener('click', function () { st.targets = st.targets.filter(function (o) { return o.key !== t.key; }); draw(); });
          chips.appendChild(c);
        });
        if (st.targets.length) sq.appendChild(chips);
        if (st.targets.some(isDone)) sq.appendChild(el('div', 'cd-dim cd-pad', 'Video đã dựng: chạy lại chỉ tạo phần còn thiếu.'));
        if (st.items) {
          var addRow = el('div', 'cd-addBtns');
          [['set', '+ Theo bộ'], ['vid', '+ Theo vid']].forEach(function (o) {
            var c = el('div', 'cl-btn cd-addBtn' + (st.add === o[0] ? ' is-on' : ''), o[1]);
            c.setAttribute('role', 'button');
            c.addEventListener('click', function () { st.add = st.add === o[0] ? '' : o[0]; st.addErr = ''; draw(); });
            addRow.appendChild(c);
          });
          sq.appendChild(addRow);
          if (st.add === 'set') sq.appendChild(addSetBox());
          if (st.add === 'vid') sq.appendChild(addVidBox());
        }
      }

      if (st.platform) {
        var opts = [];
        b.steps.forEach(function (s) { if (s.platform) CLC.slotOptions(s, 'platform').forEach(function (o) { if (opts.indexOf(o.value) < 0) opts.push(o.value); }); });
        var ps = section('Nền tảng');
        var pr = el('div', 'cd-seg');
        opts.forEach(function (p) {
          var c = el('div', 'cd-segOpt' + (p === st.platform ? ' is-on' : ''), p);
          c.setAttribute('role', 'button');
          c.addEventListener('click', function () { st.platform = p; draw(); });
          pr.appendChild(c);
        });
        ps.appendChild(pr);
      }

      var sets = groupSets();
      var setText = sets.length ? sets.map(function (g) { return g.set; }).join(', ') : (v['bộ'] || '?');
      var ss = section('Sẽ chạy');
      b.steps.forEach(function (s, i) {
        var row = el('div', 'cu-chipRow cd-stepRow');
        row.appendChild(el('span', 'cu-stepN', String(i + 1)));
        CLC.chips(s).forEach(function (c) {
          var t = c.text;
          if (c.slot === 'platform' && st.platform) t = st.platform;
          if (c.kind === 'seq' && usesSeq && s.seqs[0].k !== 'current') { if (c.i) return; t = st.targets.length + ' video'; }
          row.appendChild(el('span', 'cu-chip ' + c.kind + ' cd-static', t.replace(/\{bộ\}/g, setText)));
        });
        ss.appendChild(row);
      });
      if (sets.length > 1) ss.appendChild(el('div', 'cd-dim cd-pad', 'Chạy lần lượt ' + sets.length + ' bộ: ' + setText + '.'));

      var n = st.targets.length, ready = !usesSeq || n > 0;
      var foot = el('div', 'cd-foot');
      var go = el('div', 'cd-run' + (ready ? '' : ' is-off'), usesSeq ? (n ? '▶  Chạy cho ' + n + ' video' : 'Chọn ít nhất 1 video') : '▶  Chạy');
      go.setAttribute('role', 'button');
      go.addEventListener('click', async function () {
        if (!ready) return;
        if (!usesSeq) { T.runFlow(b, { platform: st.platform }); return; }
        for (var k = 0; k < sets.length; k++) {                        // từng bộ một
          await T.runFlow(b, { set: sets[k].set, idxs: sets[k].idxs, platform: st.platform });
          if (T.flowStopped && T.flowStopped()) break;
        }
      });
      foot.appendChild(go);
      sheet.appendChild(foot);
    }
    function groupSets() {
      var by = {}, order = [];
      st.targets.forEach(function (t) { if (!by[t.set]) { by[t.set] = []; order.push(t.set); } by[t.set].push(t.idx); });
      return order.map(function (s) { return { set: s, idxs: by[s] }; });
    }

    function addSetBox() {
      var box = el('div', 'cu-pop cd-addBox');
      var inp = el('input', 'cu-in cd-setIn');
      inp.placeholder = 'số bộ';
      inp.addEventListener('focus', window.claimKeyboard);
      inp.addEventListener('blur', window.releaseKeyboard);
      function go() {
        var set = String(inp.value || '').trim().replace(/x$/i, '');
        var list = st.vids.filter(function (x) { return x.set === set; });
        if (!/^\d+$/.test(set)) { st.addErr = 'Gõ số bộ, vd 35'; draw(); return; }
        if (!list.length) { st.addErr = 'Không thấy video FB gốc nào của bộ ' + set; draw(); return; }
        addTargets(list); st.add = ''; st.addErr = ''; draw();
      }
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
      box.appendChild(inp);
      box.appendChild(btn('Thêm cả bộ', 'cl-btn--primary', go));
      if (st.addErr) box.appendChild(el('div', 'cu-err cd-full', st.addErr));
      setTimeout(function () { try { inp.focus(); } catch (e) {} }, 0);
      return box;
    }
    function addVidBox() {
      var box = el('div', 'cu-pop cd-addBox cd-vidBox');
      var inp = el('input', 'cu-in cd-search');
      inp.placeholder = 'Tìm: 35, 35.1, tên sản phẩm…';
      inp.value = st.search;
      inp.addEventListener('focus', window.claimKeyboard);
      inp.addEventListener('blur', window.releaseKeyboard);
      box.appendChild(inp);
      var list = el('div', 'cd-vidList');
      box.appendChild(list);
      var foot = el('div', 'cd-vidFoot');
      var add = btn('', 'cl-btn--primary', function () {
        var pick = st.vids.filter(function (x) { return st.ticks[x.key]; });
        if (!pick.length) return;
        addTargets(pick); st.ticks = {}; st.search = ''; st.add = ''; draw();
      });
      foot.appendChild(add);
      box.appendChild(foot);
      var have = st.targets.map(function (t) { return t.key; });
      function paint() {
        list.innerHTML = '';
        var q = String(st.search || '').trim().toLowerCase().replace(/^vid\s*/, '');
        var hits = st.vids.filter(function (x) {
          if (!q) return true;
          if (/^\d+$/.test(q)) return x.set === q;                   // "35" → đúng bộ 35 (không ra 135, 3.5…)
          if (/^\d+\.\d*$/.test(q)) return x.key.indexOf(q) === 0;  // "35.1" / "35." → video của bộ 35
          return x.name.toLowerCase().indexOf(q) >= 0;
        });
        hits.slice(0, 60).forEach(function (x) {
          var already = have.indexOf(x.key) >= 0, on = !!st.ticks[x.key];
          var line = el('div', 'cl-mv' + (already ? ' is-bad' : on ? ' is-on' : ''));
          line.innerHTML = '<span class="cl-mvTick"></span><span class="cl-mvBody"><span class="cl-mvName"></span><span class="cl-mvPath"></span></span>';
          line.querySelector('.cl-mvName').textContent = 'vid' + x.key;
          line.querySelector('.cl-mvPath').textContent = already ? 'đã có trong danh sách' : (isDone(x) ? 'đã dựng · ' : '') + x.name.replace(/\s*\[[^\]]*\]/g, '');
          if (!already) line.addEventListener('click', function () { st.ticks[x.key] = !st.ticks[x.key]; paint(); });
          list.appendChild(line);
        });
        if (!hits.length) list.appendChild(el('div', 'cd-dim', 'Không có video nào khớp "' + st.search + '".'));
        else if (hits.length > 60) list.appendChild(el('div', 'cd-dim', '…còn ' + (hits.length - 60) + ' video — gõ cụ thể hơn.'));
        var n = Object.keys(st.ticks).filter(function (k) { return st.ticks[k]; }).length;
        add.textContent = 'Thêm ' + n + ' vid';
        add.classList.toggle('is-disabled', !n);
      }
      inp.addEventListener('input', function () { st.search = inp.value; paint(); });
      paint();
      setTimeout(function () { try { inp.focus(); } catch (e) {} }, 0);
      return box;
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
