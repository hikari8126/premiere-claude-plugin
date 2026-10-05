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
      if (!d0.buttons.some(function (b) { return b.name === 'Resize GG' || b.name === 'GG'; })) {
        d0.buttons.unshift({ name: 'GG', kind: 'flow', steps: [
          { type: 'bin_set', platform: 'GG', seqs: [{ k: 'set' }] },
          { type: 'wait', text: 'Đặt video vào khung GG dọc / ngang / vuông bộ {bộ} rồi bấm Tiếp tục' }
        ] });
        CLSTORE.set(d0);
      }
      localStorage.setItem(SEED_KEY, '1');
    }
  } catch (e) {}
  // Đợt 2 (2026-10-05): RAW (Both, tự xuất), PIN theo đơn, APP (nhân bản template AppLovin bộ trước). Thêm một lần, không đè.
  var SEED2 = 'cl_seed_v2';
  try {
    if (!localStorage.getItem(SEED2)) {
      var d2 = CLSTORE.get(), have = d2.buttons.map(function (b) { return b.name; });
      [{ name: 'RAW', kind: 'flow', steps: [{ type: 'rawcut_export', mode: 'both', seqs: [{ k: 'set' }] }] },
       { name: 'PIN', kind: 'flow', steps: [{ type: 'pin_order', seqs: [{ k: 'set' }] }] },
       { name: 'APP', kind: 'flow', steps: [{ type: 'app_set', seqs: [{ k: 'set' }] }] }
      ].forEach(function (f) { if (have.indexOf(f.name) < 0) d2.buttons.push(f); });
      CLSTORE.set(d2);
      localStorage.setItem(SEED2, '1');
    }
  } catch (e) {}

  // Đợt 3: quy trình dựng sẵn "Resize GG" đổi tên thành "GG"; thứ tự GG · PIN · APP · RAW (RAW cuối).
  var SEED3 = 'cl_seed_v3';
  try {
    if (!localStorage.getItem(SEED3)) {
      var d3 = CLSTORE.get();
      d3.buttons.forEach(function (b) {
        var gg = b.kind === 'flow' && b.steps.length && b.steps[0].type === 'bin_set' && b.steps[0].platform === 'GG';
        if (gg && (b.name === 'Resize GG' || b.name === 'Resize')) b.name = 'GG';
      });
      var raw = d3.buttons.filter(function (b) { return b.name === 'RAW' && b.kind === 'flow'; });
      d3.buttons = d3.buttons.filter(function (b) { return raw.indexOf(b) < 0; }).concat(raw);
      CLSTORE.set(d3);
      localStorage.setItem(SEED3, '1');
    }
  } catch (e) {}

  // Đợt 4: khối gộp → chuỗi khối đơn (user: "dựng bin thì chỉ dựng bin"); thêm quy trình NAV.
  var SEED4 = 'cl_seed_v4';
  function chainFor(st) {
    var b1 = { k: 'step', n: 1 };
    if (st.type === 'bin_set' && st.platform === 'GG') return [
      { type: 'bin_make', bin: { k: 'tpl', text: 'Sequence / GG / {bộ}x / {bộ}.{số}' } },
      { type: 'seq_clone', src: { k: 'base' }, name: { k: 'tpl', text: '{bộ}.{số}' }, bin: b1 },
      { type: 'seq_resize', src: { k: 'step', n: 2 }, ratio: 'prev', platform: 'prev', bin: { k: 'src' } }
    ].concat(['GG Dọc', 'GG Ngang', 'GG Vuông'].map(function (t) {
      return { type: 'seq_clone', src: { k: 'prev', ref: { k: 'match', text: t } }, name: { k: 'learn', ref: { k: 'match', text: t } }, bin: b1 };
    }));
    if (st.type === 'pin_order') return [
      { type: 'bin_make', bin: { k: 'tpl', text: 'Sequence / PIN / ' + (st.text || 'Order {ngày}') } },
      { type: 'seq_resize', src: { k: 'base' }, ratio: '2-3', platform: 'PIN', bin: b1 }
    ];
    if (st.type === 'app_set') return [
      { type: 'bin_make', bin: { k: 'prev', ref: { k: 'match', text: 'AppLovin' } } },
      { type: 'seq_clone', src: { k: 'prev', ref: { k: 'match', text: 'AppLovin' } }, name: { k: 'learn', ref: { k: 'match', text: 'AppLovin' } }, bin: b1 }
    ];
    if (st.type === 'rawcut_export') return [{ type: 'raw_export', src: { k: 'base' }, mode: st.mode || 'both', auto: true }];
    return null;
  }
  try {
    if (!localStorage.getItem(SEED4)) {
      var d4 = CLSTORE.get();
      d4.buttons.forEach(function (b) {
        if (b.kind !== 'flow') return;
        // chỉ đổi quy trình 1 khối gộp (chuỗi bước sau "bước N" không lệch số)
        if (b.steps.length === 1 && chainFor(b.steps[0])) b.steps = chainFor(b.steps[0]);
      });
      if (!d4.buttons.some(function (b) { return b.name === 'NAV'; })) {
        d4.buttons.unshift({ name: 'NAV', kind: 'flow', steps: [
          { type: 'bin_make', bin: { k: 'prev', ref: { k: 'base' } } },
          { type: 'seq_make', name: { k: 'learn', ref: { k: 'base' } }, frame: 'prev', bin: { k: 'step', n: 1 } }
        ] });
      }
      CLSTORE.set(d4);
      localStorage.setItem(SEED4, '1');
    }
  } catch (e) { console.warn('[cl-dash] seed v4:', e && e.message); }

  // ── Project đã biết + hàng đợi nhiều project (cl-queue.js) ───────────────
  // Mỗi 4s xem project active: đổi thì ghi vào danh sách (đường dẫn + tên). Hàng đợi chạy lần lượt:
  // Project.open(path) (đang mở → chuyển ngay; đang đóng → mở ra) → quy trình chế độ tự chạy → việc kế;
  // hết hàng thì về project ban đầu.
  var PKEY = 'cl_projects_v1', QKEY = 'cl_queue_v1';
  function lsGet(k, d) { try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function projects() { return lsGet(PKEY, []); }
  function loadQ() { return CLQ.normQueue(lsGet(QKEY, [])); }
  function saveQ(q) { lsSet(QKEY, CLQ.normQueue(q)); }
  var activePath = '';
  async function activeProjectPath() {
    try { var p = await getActiveProject(); return (p && p.path) || ''; } catch (e) { return ''; }
  }
  async function pollProject() {
    var p = await activeProjectPath();
    if (p && p !== activePath) {
      activePath = p;
      lsSet(PKEY, CLQ.seeProject(projects(), p, Date.now()));
    }
  }
  pollProject();
  setInterval(pollProject, 4000);

  var qRun = null;   // { stop } khi hàng đợi đang chạy
  async function switchTo(path) {
    if ((await activeProjectPath()) === path) return;
    var ppro = require('premierepro');
    await ppro.Project.open(path);
    for (var t = 0; t < 360; t++) {                 // đang đóng → Premiere mở ra, chờ tối đa 3 phút
      if ((await activeProjectPath()) === path) { activePath = path; PTOOLS.invalidate(); return; }
      await new Promise(function (r) { setTimeout(r, 500); });
    }
    throw new Error('không mở / chuyển được sang project (Premiere có hộp thoại đang chờ?)');
  }
  async function runQueue() {
    if (qRun || T.busy()) return;
    qRun = { stop: false };
    saveQ(CLQ.recover(loadQ()));
    var orig = await activeProjectPath();
    render();
    try {
      while (!qRun.stop) {
        var it = CLQ.plan(loadQ())[0];
        if (!it) break;
        saveQ(CLQ.mark(loadQ(), it.id, 'run', 'đang chạy…')); render();
        var status = 'ok', msg = '';
        try {
          var b = CLSTORE.get().buttons.filter(function (x) { return x.id === it.flowId; })[0];
          if (!b) throw new Error('quy trình "' + it.flowName + '" đã bị xoá');
          await switchTo(it.path);
          var r = await T.runFlow(b, { set: it.set, idxs: it.idxs.length ? it.idxs : null, platform: it.platform, auto: true });
          if (!r || !r.ok) { status = 'error'; msg = (r && (r.error || r.detail)) || 'lỗi'; } else msg = r.detail || 'xong';
        } catch (e) { status = 'error'; msg = (e && e.message) || String(e); }
        saveQ(CLQ.mark(loadQ(), it.id, status, msg)); render();
      }
    } finally {
      if (orig) { try { await switchTo(orig); } catch (e) {} }
      qRun = null;
      T.showView('dash');
    }
  }
  function queueAdd(path, b, set, idxs, platform) {
    var r = CLQ.add(loadQ(), { path: path, name: CLQ.baseName(path), flowId: b.id, flowName: b.name, set: set, idxs: idxs || [], platform: platform || '' });
    saveQ(r.queue);
    return r.added;
  }

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
  function ago(t) {
    var m = Math.round((Date.now() - (t || Date.now())) / 60000);
    if (m < 1) return 'vừa xong';
    if (m < 60) return m + ' phút';
    if (m < 1440) return Math.round(m / 60) + ' giờ';
    return Math.round(m / 1440) + ' ngày';
  }
  function stepsText(b) {
    return b.kind === 'flow' ? b.steps.map(function (s) { return CLC.typeLabel(s.type); }).join(' → ') : b.prompt;
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
    var grid = el('div', 'cd-grid');                    // 2 cột (UXP không có CSS grid → flex-wrap 50%)
    dash.appendChild(grid);
    flows.forEach(function (b) {
      var c = el('div', 'cd-card');
      c.setAttribute('role', 'button');
      var h = el('div', 'cd-cardHd');
      h.appendChild(el('span', 'cd-name', b.name));
      h.appendChild(el('span', 'cd-dim', b.steps.length + ' bước'));
      c.appendChild(h);
      c.appendChild(el('div', 'cd-dim', stepsText(b)));
      c.addEventListener('click', function () { openSheet(b); });
      var cell = el('div', 'cd-cell'); cell.appendChild(c); grid.appendChild(cell);
    });
    var nw = el('div', 'cd-card cd-new', '+ Tạo quy trình');
    nw.setAttribute('role', 'button');
    nw.addEventListener('click', function () { window.ClaudeCustomUI.edit(null); });
    var nc = el('div', 'cd-cell'); nc.appendChild(nw); grid.appendChild(nc);

    // Hàng đợi nhiều project
    var q = loadQ();
    if (q.length || qRun) {
      var qb = el('div', 'cd-box');
      var qh2 = el('div', 'cd-boxHd');
      var nWait = q.filter(function (x) { return x.status === 'wait'; }).length;
      qh2.appendChild(el('span', 'cd-boxT', 'Hàng đợi' + (nWait ? ' · ' + nWait + ' việc chờ' : '')));
      if (q.some(function (x) { return x.status !== 'wait' && x.status !== 'run'; }) && !qRun) {
        var cd = el('span', 'cd-link cd-dimLink', 'Dọn xong');
        cd.setAttribute('role', 'button');
        cd.addEventListener('click', function () { saveQ(CLQ.clearDone(loadQ())); render(); });
        qh2.appendChild(cd);
      }
      qb.appendChild(qh2);
      CLQ.plan(q).concat(q.filter(function (x) { return x.status !== 'wait'; })).forEach(function (x) {
        var line = el('div', 'cd-qItem');
        line.appendChild(el('span', 'cd-dot is-' + x.status));
        var body = el('div', 'cd-qBody');
        body.appendChild(el('div', 'cd-qT', x.name + ' · ' + x.flowName + ' · ' + CLQ.targetText(x) + (x.platform ? ' · ' + x.platform : '')));
        if (x.msg) body.appendChild(el('div', 'cd-qMsg' + (x.status === 'error' ? ' is-bad' : ''), x.msg));
        line.appendChild(body);
        if (x.status !== 'run') {
          var rm = el('span', 'cd-x', '✕');
          rm.setAttribute('role', 'button');
          rm.addEventListener('click', function () { saveQ(CLQ.remove(loadQ(), x.id)); render(); });
          line.appendChild(rm);
        }
        qb.appendChild(line);
      });
      var qGo = el('div', 'cd-run cd-qRun' + (qRun ? ' is-stop' : (nWait ? '' : ' is-off')),
                   qRun ? '■  Dừng sau việc này' : (nWait ? '▶  Chạy hàng đợi (' + nWait + ')' : 'Không còn việc chờ'));
      qGo.setAttribute('role', 'button');
      qGo.addEventListener('click', function () {
        if (qRun) { qRun.stop = true; qGo.textContent = 'Sẽ dừng sau việc đang chạy…'; return; }
        if (nWait) runQueue();
      });
      qb.appendChild(qGo);
      dash.appendChild(qb);
    }

    // Lệnh nhanh: chip bấm → điền lệnh vào ô chat (Enter mới gửi)
    var prompts = d.buttons.filter(function (b) { return b.kind === 'prompt'; });
    var qs = el('div', 'cd-box');
    var qh = el('div', 'cd-boxHd');
    qh.appendChild(el('span', 'cd-boxT', 'Lệnh nhanh'));
    var addP = el('span', 'cd-link', '+ Thêm');
    addP.setAttribute('role', 'button');
    addP.addEventListener('click', function () { window.ClaudeCustomUI.edit(null, 'prompt'); });
    qh.appendChild(addP);
    qs.appendChild(qh);
    if (!prompts.length) qs.appendChild(el('div', 'cd-boxEmpty', 'Lưu câu lệnh hay gõ — bấm là điền sẵn vào ô chat.'));
    else {
      var pr = el('div', 'cu-chipRow');
      prompts.forEach(function (b) {
        var c = el('div', 'cu-chip par cd-prompt', '› ' + b.name);
        c.setAttribute('role', 'button');
        c.addEventListener('click', function () { T.runButton(b); });
        pr.appendChild(c);
      });
      qs.appendChild(pr);
    }
    dash.appendChild(qs);

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

    // Lệnh gần đây: dòng có chấm trạng thái + thời gian, bấm → mở lịch sử
    var h = T.history().slice(-4).reverse();
    var rs = el('div', 'cd-box');
    var rh = el('div', 'cd-boxHd');
    rh.appendChild(el('span', 'cd-boxT', 'Lệnh gần đây'));
    var all = el('span', 'cd-link', 'Lịch sử ›');
    all.setAttribute('role', 'button');
    all.addEventListener('click', function () { T.showView('log'); });
    rh.appendChild(all);
    rs.appendChild(rh);
    if (!h.length) rs.appendChild(el('div', 'cd-boxEmpty', 'Chưa có lệnh nào — gõ ở ô dưới, hoặc bấm một quy trình.'));
    h.forEach(function (r) {
      var bad = r.err || (r.acts || []).some(function (a) { return a.cls === 'is-error'; });
      var x = el('div', 'cd-recent');
      x.setAttribute('role', 'button');
      x.appendChild(el('span', 'cd-dot' + (bad ? ' is-bad' : '')));
      x.appendChild(el('span', 'cd-recentT', r.cmd.split('\n')[0].slice(0, 60)));
      x.appendChild(el('span', 'cd-recentAt', ago(r.at)));
      x.addEventListener('click', function () { T.showView('log'); });
      rs.appendChild(x);
    });
    dash.appendChild(rs);
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
    var st = { items: null, vids: [], targets: [], platform: '', add: '', addErr: '', search: '', ticks: {}, done: {},
               here: await activeProjectPath(), project: '', manual: '', manualErr: '', queued: '' };
    st.project = st.here;
    var usesSeq = b.steps.some(function (s) { return CLC.isEngine(s.type) || (s.seqs && s.seqs.length && s.seqs[0].k !== 'current'); });
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
      ttl.appendChild(el('div', 'cd-dim', b.steps.length + ' bước · ' + b.steps.map(function (s) { return CLC.typeLabel(s.type); }).join(' → ')));
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

      // Dự án: project đang mở (chạy ngay) hoặc project khác đã biết (chỉ thêm vào hàng đợi)
      var other = usesSeq && st.project && st.project !== st.here;
      if (usesSeq) {
        var known = projects(), pj = section('Dự án');
        var sel = el('select', 'cu-sel cd-projSel');
        [st.here].concat(known.map(function (p) { return p.path; }).filter(function (p) { return p !== st.here; })).forEach(function (p) {
          if (!p) return;
          var op = el('option', null, CLQ.baseName(p) + (p === st.here ? '  (đang mở)' : ''));
          op.value = p;
          if (p === st.project) op.selected = true;
          sel.appendChild(op);
        });
        sel.addEventListener('change', function () { st.project = sel.value; st.queued = ''; draw(); });
        pj.appendChild(sel);
        if (other) pj.appendChild(el('div', 'cd-dim cd-pad', 'Project khác → thêm vào hàng đợi; lúc chạy plugin tự mở / chuyển sang project này.'));
      }
      if (other) {
        var ms = section('Bộ / video');
        var mi = el('input', 'cu-in cd-search');
        mi.placeholder = 'vd 35  ·  35.0, 35.2';
        mi.value = st.manual;
        mi.addEventListener('focus', window.claimKeyboard);
        mi.addEventListener('blur', window.releaseKeyboard);
        mi.addEventListener('input', function () { st.manual = mi.value; st.manualErr = ''; });
        ms.appendChild(mi);
        if (st.manualErr) ms.appendChild(el('div', 'cu-err', st.manualErr));
      }
      if (usesSeq && !other) {
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
          var c = el('div', 'cu-chip seq cd-tgtChip' + (isDone(t) ? ' is-done' : ''), 'vid' + t.key + (t.fresh ? ' · mới' : isDone(t) ? ' · đã dựng' : '') + '  ✕');
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

      // Nền tảng cố định trong quy trình (GG / PIN…) — phiếu chạy không chọn lại (user 2026-10-05).

      var sets = groupSets();
      // Xem trước khối đơn cho bộ đầu tiên đã chọn (tính trên bản chụp project, chưa đụng Premiere)
      var preview = null;
      if (!other && st.items && sets.length && b.steps.some(function (x) { return CLC.isEngine(x.type); })) {
        try { preview = FLE.planFlow(st.items, b.steps, sets[0].idxs.map(function (n) { return { set: sets[0].set, idx: n }; })); } catch (e) { preview = null; }
      }
      var setText = sets.length ? sets.map(function (g) { return g.set; }).join(', ') : (v['bộ'] || '?');
      var ss = section('Sẽ chạy');
      b.steps.forEach(function (s, i) {
        var row = el('div', 'cu-chipRow cd-stepRow');
        row.appendChild(el('span', 'cu-stepN', String(i + 1)));
        CLC.chips(s).forEach(function (c) {
          var t = c.text;
          if (c.slot === 'platform' && st.platform) t = st.platform;
          if (c.kind === 'seq' && usesSeq && s.seqs && s.seqs[0].k !== 'current') { if (c.i) return; t = other ? 'bộ / video ở trên' : st.targets.length + ' video'; }
          row.appendChild(el('span', 'cu-chip ' + c.kind + ' cd-static', CLC.isEngine(s.type) ? t : t.replace(/\{bộ\}/g, setText)));   // khối đơn: tên thật ở dòng → bên dưới
        });
        ss.appendChild(row);
        // Xem trước khối đơn: tên / bin của video đầu + số đã có / lỗi
        var pv = preview && preview[i];
        if (pv && pv.rows && pv.rows.length) {
          var r0 = pv.rows.filter(function (r) { return !r.error; })[0];
          var nErr = pv.rows.filter(function (r) { return r.error; }).length, nHave = pv.rows.filter(function (r) { return r.exists; }).length;
          var txt = r0 ? '→ ' + (s.type === 'bin_make' ? r0.bin : s.type === 'raw_export' ? (r0.src && r0.src.name) : (r0.name || '') + (r0.bin ? '  ·  ' + r0.bin : '')) : '';
          if (pv.rows.length > 1 && r0) txt += '  (+' + (pv.rows.length - 1) + ' video)';
          if (nHave) txt += (txt ? ' · ' : '') + nHave + ' đã có';
          ss.appendChild(el('div', 'cd-pv', txt));
          if (nErr) ss.appendChild(el('div', 'cd-pv is-bad', nErr + ' lỗi: ' + pv.rows.filter(function (r) { return r.error; })[0].error));
        }
      });
      if (sets.length > 1) ss.appendChild(el('div', 'cd-dim cd-pad', 'Chạy lần lượt ' + sets.length + ' bộ: ' + setText + '.'));

      var n = st.targets.length, ready = !usesSeq || n > 0;
      var foot = el('div', 'cd-foot');
      if (st.queued) foot.appendChild(el('div', 'cd-queued', st.queued));
      if (other) {
        var qa = el('div', 'cd-run', '+  Thêm vào hàng đợi');
        qa.setAttribute('role', 'button');
        qa.addEventListener('click', function () {
          var t = CLQ.parseTargets(st.manual);
          if (t.error) { st.manualErr = t.error; draw(); return; }
          var ok = queueAdd(st.project, b, t.set, t.idxs, st.platform);
          st.queued = ok ? '✓ Đã thêm: ' + CLQ.baseName(st.project) + ' · ' + CLQ.targetText(t) : 'Việc này đã có trong hàng đợi';
          st.manual = ''; draw();
        });
        foot.appendChild(qa);
        sheet.appendChild(foot);
        return;
      }
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
      if (usesSeq && n && st.here) {
        var qh = el('div', 'cl-btn cd-qAdd', '+ Thêm vào hàng đợi');
        qh.setAttribute('role', 'button');
        qh.addEventListener('click', function () {
          var added = 0;
          sets.forEach(function (g) { if (queueAdd(st.here, b, g.set, g.idxs, st.platform)) added++; });
          st.queued = added ? '✓ Đã thêm ' + added + ' việc vào hàng đợi (' + CLQ.baseName(st.here) + ')' : 'Đã có trong hàng đợi';
          draw();
        });
        foot.appendChild(qh);
      }
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
        if (!list.length) {                         // bộ MỚI (chưa có sequence): video ảo .0 .1 .2 cho Tạo bin / Tạo sequence
          list = [0, 1, 2].map(function (n) { return { set: set, idx: n, name: 'bộ mới', key: set + '.' + n, fresh: true }; });
        }
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
