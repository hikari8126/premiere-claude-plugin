// plugin/claude-tab.js — tab Claude: ô lệnh + nhật ký lệnh + Clawd.
//
// Người dùng gõ lệnh → bridge /chat (SSE) → Claude trả lời ngắn + khối ```actions →
// ppExecuteAction (main.js) cho các tab làm việc. Mỗi lệnh là một mục trong nhật ký:
// "› lệnh", câu trả lời, kết quả từng action. Lưu 20 lệnh gần nhất (localStorage
// cl_history_v1) làm ngữ cảnh + để mở lại panel vẫn thấy. Hàm thuần ở claude-log.js
// và clawd-pixel.js (có test); whitelist action ở claude-actions.js (CLA). Dùng global của main.js: BRIDGE_URL, CLAUDE_MODEL,
// ANTHROPIC_KEY, timelineContext, ppExecuteAction, refreshTimeline, BRIDGE_OFFLINE_MSG,
// pluginIconSVG.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var logEl = $('clLog'), emptyEl = $('clEmpty'), input = $('message-input'), sendEl = $('send-btn');
  var stateEl = $('clState'), seqEl = $('clSeqName'), clearEl = $('clClear');
  if (!logEl || !input || !sendEl) return;

  var HISTORY_KEY = 'cl_history_v1', MODE_KEY = 'cl_mode';

  // ── Chế độ: 'command' (Lệnh — giao việc, ngắn) | 'free' (Hỏi tự do — research) ─────
  var mode = 'command';
  try { if (localStorage.getItem(MODE_KEY) === 'free') mode = 'free'; } catch (e) {}
  var PLACEHOLDER = { command: 'Gõ lệnh… (Enter để gửi)', free: 'Hỏi gì cũng được… (Enter để gửi)' };
  function setMode(m) {
    mode = m === 'free' ? 'free' : 'command';
    try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}
    document.querySelectorAll('#clMode .cl-modeOpt').forEach(function (o) { o.classList.toggle('is-on', o.getAttribute('data-mode') === mode); });
    input.setAttribute('placeholder', PLACEHOLDER[mode]);
  }
  document.querySelectorAll('#clMode .cl-modeOpt').forEach(function (o) {
    o.addEventListener('click', function () { setMode(o.getAttribute('data-mode')); });
  });

  // Công cụ Claude đang dùng → chữ trạng thái + đếm cho dòng phụ của mục lệnh.
  function toolStatus(name, detail) {
    name = String(name || '').replace(/^mcp__premiere__/, '');
    if (detail && typeof detail === 'object') detail = detail.path || detail.text || '';
    var d = detail ? ': ' + String(detail).slice(0, 40) : '';
    if (name === 'project_bins') return 'Đang xem cây bin…';
    if (name === 'list_bin')     return 'Đang xem bin' + (d || ' gốc');
    if (name === 'find_items')   return 'Đang tìm item' + d;
    if (name === 'WebSearch') return 'Đang tìm trên web' + d;
    if (name === 'WebFetch')  return 'Đang đọc trang' + (detail ? ': ' + String(detail).replace(/^https?:\/\/(www\.)?/, '').split('/')[0] : '');
    if (name === 'Read')      return 'Đang đọc file' + d;
    if (name === 'Glob' || name === 'Grep') return 'Đang tìm file…';
    return 'Đang dùng ' + name + '…';
  }
  function metaText(m, tools) {
    var parts = [];
    if (tools && tools.proj) parts.push('xem project ' + tools.proj + ' lần');
    if (tools && tools.web) parts.push('tìm web ' + tools.web + ' lần');
    if (tools && tools.page) parts.push('đọc ' + tools.page + ' trang');
    if (tools && tools.find) parts.push('tìm file ' + tools.find + ' lần');
    if (tools && tools.file) parts.push('đọc ' + tools.file + ' file');
    return { mode: m === 'free' ? 'Hỏi tự do' : '', tools: parts.join(' · ') };
  }
  function setMeta(entry, m, tools) {
    var mt = metaText(m, tools);
    if (!mt.mode && !mt.tools) { entry.meta.hidden = true; return; }
    entry.meta.hidden = false;
    entry.meta.innerHTML = (mt.mode ? '<span class="cl-metaMode">' + mt.mode + '</span>' : '') +
      (mt.mode && mt.tools ? ' · ' : '') + CLLOG.esc(mt.tools);
  }

  async function projectPath() {
    try { var p = await getActiveProject(); return (p && typeof p.path === 'string') ? p.path : ''; }
    catch (e) { return ''; }
  }

  // ── Clawd: icon tab (khung cắt), đậu trên ô lệnh, giữa màn trống ──────────────
  // Cảnh: idle (thở + chớp mắt) · think (chờ Claude) · work (chạy action) · done · fail.
  var clawd = { scene: 'idle', tick: 0, until: 0, drawn: {} };
  function drawInto(id, scene, frameIdx, width, crop) {
    var el = $(id);
    if (!el) return;
    var frames = CLAWD.frames(scene), key = scene + ':' + (frameIdx % frames.length);
    if (clawd.drawn[id] === key) return;          // khung không đổi → không vẽ lại DOM
    clawd.drawn[id] = key;
    el.innerHTML = CLAWD.toSvg(frames[frameIdx % frames.length], width, crop);
  }
  function drawClawd() {
    var sc = clawd.scene, i = clawd.tick;
    drawInto('clawdTabIcon', sc, i, 28, CLAWD.TAB_CROP);
    drawInto('clawdDock', sc, i, 32);
    if (emptyEl && !emptyEl.hidden) drawInto('clawdHero', sc, i, 88);
  }
  setInterval(function () {
    clawd.tick++;
    if (clawd.until && Date.now() > clawd.until) { clawd.until = 0; setClawd('idle'); return; }
    drawClawd();
  }, 250);

  // scene: idle | think | work | done | fail. done/fail diễn hết ~2 vòng rồi về idle.
  function setClawd(scene, text, cls) {
    if (clawd.scene !== scene) clawd.tick = 0;    // cảnh mới chạy từ khung đầu (vd nhún lấy đà trước khi nhảy)
    clawd.scene = scene;
    clawd.until = (scene === 'done' || scene === 'fail') ? Date.now() + CLAWD.frames(scene).length * 250 * 2 : 0;
    if (stateEl) {
      stateEl.textContent = text || (scene === 'idle' ? 'Sẵn sàng' : stateEl.textContent);
      stateEl.className = 'cl-state' + (cls ? ' ' + cls : '');
    }
    drawClawd();
  }

  // ── Sequence đang mở (main.js gọi khi timeline đổi) ─────────────────────────
  window.ClaudeTabSetSeq = function (d) {
    if (seqEl) seqEl.textContent = CLLOG.seqLabel(d && d.sequenceName, d && d.durationSec);
    if (window.ClaudeDash && view === 'dash') window.ClaudeDash.render();
  };

  // ── Lịch sử ─────────────────────────────────────────────────────────────────
  function loadHistory() {
    try { var h = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); return Array.isArray(h) ? h : []; }
    catch (e) { return []; }
  }
  function saveHistory() {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (e) {}
  }
  var history = loadHistory();

  function syncEmpty() {
    var has = !!logEl.querySelector('.cl-entry');
    emptyEl.hidden = has;
    if (clearEl) clearEl.hidden = !has;
    clawd.drawn.clawdHero = null;
    drawClawd();
  }

  // ── Một mục nhật ký ─────────────────────────────────────────────────────────
  function makeEntry(cmd, past) {
    var root = document.createElement('div');
    root.className = 'cl-entry' + (past ? ' is-past' : '');
    var c = document.createElement('div');
    c.className = 'cl-cmd';
    c.innerHTML = '<span class="cl-chev">›</span><span class="cl-cmdText"></span>';
    c.querySelector('.cl-cmdText').textContent = cmd;
    var meta = document.createElement('div');
    meta.className = 'cl-meta';
    meta.hidden = true;
    var reply = document.createElement('div');
    reply.className = 'cl-reply';
    var result = document.createElement('div');
    result.className = 'cl-result';
    root.appendChild(c); root.appendChild(meta); root.appendChild(reply); root.appendChild(result);
    logEl.appendChild(root);
    return { root: root, meta: meta, reply: reply, result: result };
  }
  function addAct(entry, cls, text) {
    var row = document.createElement('div');
    row.className = 'cl-act ' + cls;
    row.textContent = text;
    entry.result.appendChild(row);
    return row;
  }
  function scrollEnd() { logEl.scrollTop = logEl.scrollHeight; }

  function renderPast() {
    history.forEach(function (h) {
      var e = makeEntry(h.cmd, true);
      setMeta(e, h.mode, h.tools);
      if (h.err) { e.reply.className = 'cl-reply is-error'; e.reply.textContent = h.err; }
      else e.reply.innerHTML = CLLOG.renderReply(h.raw) || '';
      (h.acts || []).forEach(function (a) {
        // Việc còn chờ xác nhận lúc đóng panel → coi như đã bỏ qua, không hỏi lại.
        if (a.cls === 'is-ask') addAct(e, 'is-skip', a.text + ' — bỏ qua');
        else addAct(e, a.cls, a.text);
      });
    });
    syncEmpty();
    scrollEnd();
  }

  // ── Action trong câu trả lời ────────────────────────────────────────────────
  // Mỗi action qua whitelist CLA.check. mode 'confirm' (gen tốn credit) → hỏi ngay trong
  // mục lệnh; bấm nút nào thì cập nhật dòng kết quả + lịch sử (rec.acts[i]).
  async function runOne(row, a) {
    row.className = 'cl-act is-run';
    row.textContent = a.action + '…';
    var r;
    try { r = await ppExecuteAction(a); } catch (e) { r = { ok: false, error: e.message }; }
    if (r && r.ok) { row.className = 'cl-act is-ok'; row.textContent = (r.data && r.data.message) || a.action; learnAct(a); }
    else { row.className = 'cl-act is-error'; row.textContent = a.action + ': ' + ((r && r.error) || 'lỗi'); }
    return { cls: row.className.replace('cl-act ', ''), text: row.textContent };
  }

  function askLabel(a) {
    var what = a.action === 'voicegen_sfx' ? 'SFX' : 'voice';
    return { q: 'Gen ' + what + ' luôn? Tốn credit ElevenLabs.', yes: 'Gen luôn', no: a.action === 'voicegen_sfx' ? 'Chỉ đẩy prompt' : 'Chỉ đẩy script' };
  }

  // Thẻ xem trước chuyển item: mỗi dòng "tên / bin cũ → bin mới", bấm dòng để bỏ chọn; dòng
  // lỗi (không còn trong project, trùng tên, đã đúng bin) hiện mờ kèm lý do, không chuyển.
  function askMoves(entry, rec, idx, a) {
    var voice = a.action === 'fix_voice_bins';
    var row = addAct(entry, 'is-run', voice ? 'Đang soát bin voice…' : 'Đang đối chiếu với project…');
    var box = document.createElement('div');
    box.className = 'cl-moves';
    entry.result.appendChild(box);
    function save(cls, text) { rec.acts[idx] = { cls: cls, text: text }; saveHistory(); }
    (voice ? PTOOLS.planVoice() : PTOOLS.resolve(a.moves)).then(function (res) {
      var rows = res.rows;
      if (!rows.length) {
        box.remove(); row.className = 'cl-act is-ok';
        row.textContent = voice ? 'Không có voice nào nằm sai bin' : 'Không có gì cần chuyển';
        save('is-ok', row.textContent); setClawd('done', 'Xong', 'is-done');
        return;
      }
      var good = rows.filter(function (r) { return !r.error; }).length;
      row.className = 'cl-act is-ask';
      row.textContent = good ? 'Chuyển ' + good + ' item? Bấm dòng để bỏ chọn.' : 'Không chuyển được item nào (xem lý do bên dưới).';
      save('is-ask', row.textContent);
      rows.forEach(function (r) {
        var line = document.createElement('div');
        line.className = 'cl-mv' + (r.error ? ' is-bad' : ' is-on');
        line.innerHTML = '<span class="cl-mvTick"></span><span class="cl-mvBody"><span class="cl-mvName"></span><span class="cl-mvPath"></span></span>';
        line.querySelector('.cl-mvName').textContent = r.name;
        line.querySelector('.cl-mvPath').textContent = r.error ? r.from + ' — ' + r.error : r.from + '  →  ' + r.to;
        if (!r.error) line.addEventListener('click', function () { line.classList.toggle('is-on'); syncBtn(); });
        r._line = line;
        box.appendChild(line);
      });
      var btns = document.createElement('div');
      btns.className = 'cl-askBtns';
      btns.innerHTML = '<div class="cl-btn cl-btn--primary" role="button"></div><div class="cl-btn" role="button">Bỏ qua</div>';
      var go = btns.children[0];
      box.appendChild(btns);
      function picked() { return rows.filter(function (r) { return !r.error && r._line.classList.contains('is-on'); }); }
      function syncBtn() { var n = picked().length; go.textContent = 'Chuyển ' + n + ' item'; go.classList.toggle('is-disabled', !n); }
      syncBtn();
      if (!good) go.remove();
      setClawd('idle', 'Chờ bro xác nhận');
      go.addEventListener('click', function () {
        var sel = picked();
        if (!sel.length) return;
        btns.remove();
        box.querySelectorAll('.cl-mv').forEach(function (l) { l.style.pointerEvents = 'none'; });
        setClawd('work', 'Đang chuyển…');
        learnAct(a);
        PTOOLS.move(res.items, sel, function (i, n) { row.textContent = 'Đang chuyển ' + (i + 1) + '/' + n + '…'; }).then(function (out) {
          var bad = out.failed.length;
          row.className = 'cl-act ' + (bad ? 'is-error' : 'is-ok');
          row.textContent = 'Đã chuyển ' + out.done + '/' + sel.length + ' item' + (bad ? ' — lỗi: ' + out.failed.join('; ') : '');
          save(bad ? 'is-error' : 'is-ok', row.textContent);
          setClawd(bad ? 'fail' : 'done', bad ? 'Có item lỗi' : 'Xong', bad ? 'is-error' : 'is-done');
        });
      });
      btns.children[1].addEventListener('click', function () {
        box.remove(); row.className = 'cl-act is-skip'; row.textContent = 'Đã bỏ qua — không chuyển gì';
        save('is-skip', row.textContent); setClawd('idle');
      });
      scrollEnd();
    }).catch(function (e) {
      box.remove(); row.className = 'cl-act is-error'; row.textContent = 'Không đọc được project: ' + e.message;
      save('is-error', row.textContent); setClawd('fail', 'Lỗi', 'is-error');
    });
    setClawd('think', voice ? 'Đang soát bin voice…' : 'Đang đối chiếu…');
    return { cls: 'is-ask', text: voice ? 'Soát bin voice' : 'Chuyển item' };
  }

  // ── Thẻ chung: danh sách dòng (bấm để bỏ chọn) + nút chính / Bỏ qua ───────────────
  // lines: [{name, sub, bad}] — dòng bad hiện mờ, không chọn được. Trả { picked(), go, btns }.
  function pickList(box, lines, goLabel, onGo, onSkip) {
    lines.forEach(function (ln) {
      var line = document.createElement('div');
      line.className = 'cl-mv' + (ln.bad ? ' is-bad' : ' is-on');
      line.innerHTML = '<span class="cl-mvTick"></span><span class="cl-mvBody"><span class="cl-mvName"></span><span class="cl-mvPath"></span></span>';
      line.querySelector('.cl-mvName').textContent = ln.name;
      line.querySelector('.cl-mvPath').textContent = ln.sub || '';
      if (!ln.bad) line.addEventListener('click', function () { line.classList.toggle('is-on'); sync(); });
      ln._line = line;
      box.appendChild(line);
    });
    var btns = document.createElement('div');
    btns.className = 'cl-askBtns';
    btns.innerHTML = '<div class="cl-btn cl-btn--primary" role="button"></div><div class="cl-btn" role="button">Bỏ qua</div>';
    var go = btns.children[0];
    box.appendChild(btns);
    function picked() { return lines.filter(function (ln) { return !ln.bad && ln._line.classList.contains('is-on'); }); }
    function sync() { var n = picked().length; go.textContent = goLabel(n); go.classList.toggle('is-disabled', !n); }
    sync();
    if (!lines.some(function (ln) { return !ln.bad; })) go.remove();
    if (autoRun) {                                   // hàng đợi: tự chọn mọi dòng hợp lệ và chạy
      setTimeout(function () {
        var sel = picked();
        btns.remove();
        box.querySelectorAll('.cl-mv').forEach(function (l) { l.style.pointerEvents = 'none'; });
        if (sel.length) onGo(sel); else { box.remove(); onSkip(); }
      }, 0);
      return;
    }
    go.addEventListener('click', function () {
      var sel = picked();
      if (!sel.length) return;
      btns.remove();
      box.querySelectorAll('.cl-mv').forEach(function (l) { l.style.pointerEvents = 'none'; });
      onGo(sel);
    });
    btns.children[1].addEventListener('click', function () { box.remove(); onSkip(); });
    scrollEnd();
  }

  // Resize: xem trước đúng như nút RESIZE của tab Resize (tên bản mới, trùng tên bỏ qua) → Tạo.
  function askResize(entry, rec, idx, a) {
    var row = addAct(entry, 'is-run', 'Đang lập danh sách resize ' + a.platform + '…');
    var box = document.createElement('div');
    box.className = 'cl-moves';
    entry.result.appendChild(box);
    function save(cls, text) { rec.acts[idx] = { cls: cls, text: text }; saveHistory(); }
    function fail(msg) { box.remove(); row.className = 'cl-act is-error'; row.textContent = msg; save('is-error', msg); setClawd('fail', 'Lỗi', 'is-error'); }
    if (!window.ResizeAPI) { fail('Tab Resize chưa sẵn sàng'); return { cls: 'is-error', text: 'Tab Resize chưa sẵn sàng' }; }
    PTOOLS.sequencesFor(a.items).then(async function (src) {
      if (a.items.length && !src.seqs.length) return fail('Không tìm thấy sequence: ' + src.rows.map(function (r) { return r.name + ' (' + r.error + ')'; }).join('; '));
      var pl = await window.ResizeAPI.plan(a.platform, a.ratios, src.seqs);
      if (!pl.ok) return fail(pl.error);
      var lines = src.rows.filter(function (r) { return r.error; }).map(function (r) { return { name: r.name, sub: r.error, bad: true }; });
      pl.plan.forEach(function (p) {
        if (p.skip) lines.push({ name: p.src, sub: p.skip, bad: true });
        else if (p.exists || p.dupInPlan) lines.push({ name: p.name, sub: p.exists ? 'đã có sequence cùng tên — bỏ qua' : 'trùng tên trong lượt này', bad: true });
        else lines.push({ name: p.name, sub: 'từ ' + p.src, plan: p });
      });
      var n = lines.filter(function (l) { return !l.bad; }).length;
      row.className = 'cl-act is-ask';
      row.textContent = n ? 'Resize ' + a.platform + ': tạo ' + n + ' bản? Bấm dòng để bỏ chọn.' : 'Không có bản nào để tạo.';
      save('is-ask', row.textContent);
      setClawd('idle', 'Chờ bro xác nhận');
      pickList(box, lines, function (k) { return 'Tạo ' + k + ' bản'; }, async function (sel) {
        var keep = sel.map(function (l) { return l.plan; });
        var plan = pl.plan.map(function (p) {
          if (p.skip || p.exists || p.dupInPlan || keep.indexOf(p) >= 0) return p;
          var q = {}; for (var k in p) q[k] = p[k]; q.skip = 'bỏ chọn'; return q;
        });
        setClawd('work', 'Đang resize…');
        row.className = 'cl-act is-run'; row.textContent = 'Đang resize 0/' + keep.length + '…';
        learnAct(a);
        var done = 0;
        try {
          var res = await window.ResizeAPI.run(a.platform, plan, function (r) { if (!r.skip && !r.error) row.textContent = 'Đã tạo ' + (++done) + '/' + keep.length + '…'; else if (r.hung) row.textContent = r.error; });
          var made = res.results.filter(function (r) { return !r.error && !r.skip; }).length;
          var errs = res.results.filter(function (r) { return r.error; });
          row.className = 'cl-act ' + (errs.length ? 'is-error' : 'is-ok');
          row.textContent = 'Đã tạo ' + made + ' bản ' + a.platform + (errs.length ? ' — lỗi: ' + errs.map(function (r) { return r.name + ': ' + r.error; }).join('; ') : '');
        } catch (e) { row.className = 'cl-act is-error'; row.textContent = 'Resize lỗi: ' + e.message; }
        save(row.className.replace('cl-act ', ''), row.textContent);
        var bad = row.classList.contains('is-error');
        setClawd(bad ? 'fail' : 'done', bad ? 'Có bản lỗi' : 'Xong', bad ? 'is-error' : 'is-done');
      }, function () { row.className = 'cl-act is-skip'; row.textContent = 'Đã bỏ qua — không resize'; save('is-skip', row.textContent); setClawd('idle'); });
    }).catch(function (e) { fail('Resize lỗi: ' + e.message); });
    setClawd('think', 'Đang lập danh sách…');
    return { cls: 'is-ask', text: 'Resize ' + a.platform };
  }

  // RAW: chuẩn bị tab RAW (mode + sequence) — nút XUẤT vẫn để người dùng bấm trong tab RAW.
  function askRaw(entry, rec, idx, a) {
    var modeName = (window.RawcutAPI && window.RawcutAPI.modes[a.mode]) || a.mode;
    var row = addAct(entry, 'is-run', 'Đang tìm sequence cho RAW…');
    var box = document.createElement('div');
    box.className = 'cl-moves';
    entry.result.appendChild(box);
    function save(cls, text) { rec.acts[idx] = { cls: cls, text: text }; saveHistory(); }
    function fail(msg) { box.remove(); row.className = 'cl-act is-error'; row.textContent = msg; save('is-error', msg); setClawd('fail', 'Lỗi', 'is-error'); }
    if (!window.RawcutAPI) { fail('Tab RAW chưa sẵn sàng'); return { cls: 'is-error', text: 'Tab RAW chưa sẵn sàng' }; }
    PTOOLS.sequencesFor(a.items).then(async function (src) {
      var seqs = src.seqs;
      if (!a.items.length) {                        // không chỉ định → đang chọn ở Project panel, rồi timeline
        try { seqs = await RCP.selectedSequences(); } catch (e) { seqs = []; }
        if (!seqs.length) { try { var s = await getActiveSequence(); if (s) seqs = [s]; } catch (e2) {} }
      }
      if (!seqs.length) return fail(a.items.length ? 'Không tìm thấy sequence: ' + src.rows.map(function (r) { return r.name + ' (' + r.error + ')'; }).join('; ') : 'Chưa chọn / mở sequence nào');
      var lines = seqs.map(function (q) { return { name: String(q.name || ''), sub: modeName, seq: q }; })
        .concat(src.rows.filter(function (r) { return r.error; }).map(function (r) { return { name: r.name, sub: r.error, bad: true }; }));
      row.className = 'cl-act is-ask';
      row.textContent = a.export ? 'Xuất RAW · ' + modeName + ' · ' + seqs.length + ' sequence — bấm để tự đọc + xuất.'
                                 : 'RAW · ' + modeName + ' · ' + seqs.length + ' sequence. Mở tab RAW đọc sẵn, bro xem rồi bấm XUẤT.';
      save('is-ask', row.textContent);
      setClawd('idle', 'Chờ bro xác nhận');
      pickList(box, lines, function (k) { return (a.export ? 'Xuất RAW (' : 'Chuẩn bị RAW (') + k + ')'; }, async function (sel) {
        setClawd('work', a.export ? 'Đang xuất RAW…' : 'Đang đọc timeline…');
        learnAct(a);
        if (a.export) {                                // quy trình "RAW": đọc + tự xuất, chờ xong
          row.className = 'cl-act is-run'; row.textContent = 'Đang xuất RAW ' + sel.length + ' sequence (' + modeName + ')… xem tiến trình ở tab RAW';
          try {
            var ex = await window.RawcutAPI.exportSeqs(sel.map(function (l) { return l.seq; }), a.mode);
            var bad = ex.failed.length || ex.cancelled;
            row.className = 'cl-act ' + (bad ? 'is-error' : 'is-ok');
            row.textContent = (ex.cancelled ? 'Đã dừng — ' : '') + 'Xuất RAW ' + ex.done + '/' + ex.count + ' sequence · ' + ex.clips + ' clip' + (ex.failed.length ? ' — lỗi: ' + ex.failed.join('; ') : '');
            setClawd(bad ? 'fail' : 'done', bad ? 'Có sequence lỗi' : 'Xong', bad ? 'is-error' : 'is-done');
          } catch (e) { row.className = 'cl-act is-error'; row.textContent = 'RAW lỗi: ' + e.message; setClawd('fail', 'Lỗi', 'is-error'); }
          save(row.className.replace('cl-act ', ''), row.textContent);
          return;
        }
        try {
          var r = await window.RawcutAPI.prepare(sel.map(function (l) { return l.seq; }), a.mode);
          row.className = 'cl-act is-ok';
          row.textContent = 'Đã chuẩn bị tab RAW (' + modeName + ', ' + r.count + ' sequence' + (r.ready != null && r.ready < r.count ? ', ' + (r.count - r.ready) + ' chưa xuất được' : '') + ') — bấm XUẤT trong tab RAW';
          setClawd('done', 'Xong', 'is-done');
        } catch (e) { row.className = 'cl-act is-error'; row.textContent = 'RAW lỗi: ' + e.message; setClawd('fail', 'Lỗi', 'is-error'); }
        save(row.className.replace('cl-act ', ''), row.textContent);
      }, function () { row.className = 'cl-act is-skip'; row.textContent = 'Đã bỏ qua'; save('is-skip', row.textContent); setClawd('idle'); });
    }).catch(function (e) { fail('RAW lỗi: ' + e.message); });
    setClawd('think', 'Đang tìm sequence…');
    return { cls: 'is-ask', text: 'RAW ' + modeName };
  }

  // Dựng bin GG / PIN: xem trước từng sequence sẽ tạo (đã có / chưa có nguồn hiện mờ) → Tạo.
  function askBinSet(entry, rec, idx, a) {
    var set = a.set || CLC.vars(seqNameNow())['bộ'];
    var row = addAct(entry, 'is-run', 'Đang lập danh sách bin ' + a.platform + (set ? ' bộ ' + set : '') + '…');
    var box = document.createElement('div');
    box.className = 'cl-moves';
    entry.result.appendChild(box);
    function save(cls, text) { rec.acts[idx] = { cls: cls, text: text }; saveHistory(); }
    function fail(msg) { box.remove(); row.className = 'cl-act is-error'; row.textContent = msg; save('is-error', msg); setClawd('fail', 'Lỗi', 'is-error'); }
    BINSET.plan(a.platform, set, a.idxs).then(function (p) {
      if (!p.ok) return fail('Dựng bin: ' + p.error);
      var lines = [];
      p.rows.forEach(function (r) {
        if (r.error) { lines.push({ name: set + '.' + r.idx, sub: r.error, bad: true }); return; }
        var bin = r.bin.split(' / ').slice(-2).join(' / ');
        lines.push(r.res1.exists ? { name: r.res1.name, sub: bin + ' — đã có', bad: true }
                                 : { name: r.res1.name, sub: bin + ' — bản sao ' + r.src.name, obj: r.res1 });
        lines.push(r.res2.exists ? { name: r.res2.name, sub: 'đã có', bad: true }
                                 : { name: r.res1.name + ' ' + (r.res2.spec.ratios.length ? r.res2.spec.ratios.map(function (x) { return x.replace('-', 'x'); }).join(' + ') : 'resize') + ' ' + r.res2.spec.platform,
                                     sub: r.res2.spec.from ? 'resize như bộ ' + r.res2.spec.from : 'resize sang ratio còn lại (9:16 ⇄ 4:5)', obj: r.res2 });
        r.targets.forEach(function (t) {
          if (t.exists) lines.push({ name: t.name, sub: 'đã có', bad: true });
          else if (!t.from) lines.push({ name: t.name || (a.platform + ' ' + t.label), sub: 'chưa có template / bản cũ cho ' + a.platform + ' ' + t.label, bad: true });
          else lines.push({ name: t.name, sub: t.from.kind === 'template' ? 'từ template' : 'từ bộ ' + t.from.set, obj: t });
        });
      });
      var n = lines.filter(function (l) { return !l.bad; }).length, sm = BSC.summary(p);
      row.className = 'cl-act is-ask';
      row.textContent = n ? 'Dựng bin ' + a.platform + ' bộ ' + p.set + ': tạo ' + n + ' sequence' + (sm.missing ? ', ' + sm.missing + ' chưa có nguồn' : '') + '? Bấm dòng để bỏ chọn.'
                          : 'Bin ' + a.platform + ' bộ ' + p.set + ' không còn gì để tạo.';
      save('is-ask', row.textContent);
      setClawd('idle', 'Chờ bro xác nhận');
      pickList(box, lines, function (k) { return 'Tạo ' + k + ' sequence'; }, async function (sel) {
        lines.forEach(function (l) { if (l.obj) l.obj.skip = sel.indexOf(l) < 0; });
        setClawd('work', 'Đang dựng bin…');
        learnAct(a);
        row.className = 'cl-act is-run';
        try {
          var out = await BINSET.run(p.rows, function (text) { row.textContent = text; });
          row.className = 'cl-act ' + (out.failed.length ? 'is-error' : 'is-ok');
          row.textContent = 'Đã tạo ' + out.made + ' sequence trong bin ' + a.platform + ' bộ ' + p.set + (out.failed.length ? ' — lỗi: ' + out.failed.join('; ') : '');
        } catch (e) { row.className = 'cl-act is-error'; row.textContent = 'Dựng bin lỗi: ' + e.message; }
        save(row.className.replace('cl-act ', ''), row.textContent);
        var bad = row.classList.contains('is-error');
        setClawd(bad ? 'fail' : 'done', bad ? 'Có bước lỗi' : 'Xong', bad ? 'is-error' : 'is-done');
      }, function () { row.className = 'cl-act is-skip'; row.textContent = 'Đã bỏ qua — không dựng bin'; save('is-skip', row.textContent); setClawd('idle'); });
    }).catch(function (e) { fail('Dựng bin lỗi: ' + e.message); });
    setClawd('think', 'Đang đọc project…');
    return { cls: 'is-ask', text: 'Dựng bin ' + a.platform };
  }

  // APP / PIN theo đơn: xem trước từng sequence sẽ tạo (đã có → mờ, kèm chỗ đang nằm) → Tạo.
  function askAppPin(entry, rec, idx, a) {
    var pin = a.action === 'pin_order', what = pin ? 'PIN' : 'APP';
    var set = a.set || CLC.vars(seqNameNow())['bộ'];
    var row = addAct(entry, 'is-run', 'Đang lập danh sách ' + what + (set ? ' bộ ' + set : '') + '…');
    var box = document.createElement('div');
    box.className = 'cl-moves';
    entry.result.appendChild(box);
    function save(cls, text) { rec.acts[idx] = { cls: cls, text: text }; saveHistory(); }
    function fail(msg) { box.remove(); row.className = 'cl-act is-error'; row.textContent = msg; save('is-error', msg); setClawd('fail', 'Lỗi', 'is-error'); }
    (pin ? BINSET.planPin(set, a.idxs, a.order) : BINSET.planApp(set, a.idxs)).then(function (p) {
      if (!p.ok) return fail(what + ': ' + p.error);
      var lines = p.rows.map(function (r) {
        if (r.error) return { name: set + '.' + r.idx, sub: r.error, bad: true };
        if (r.exists) return { name: r.name, sub: pin ? 'đã có' + (r.where ? ' ở ' + r.where.split(' / ').pop() : '') : 'đã có', bad: true };
        if (!pin && !r.from) return { name: r.name, sub: 'chưa có template / bản AppLovin cũ để nhân bản', bad: true };
        return { name: r.name, sub: pin ? 'resize 2:3 từ ' + r.src.name + ' → ' + p.bin.split(' / ').pop()
                                       : (r.from.kind === 'template' ? 'từ template' : 'khung từ bộ ' + r.from.set) + ' → ' + r.bin, r: r };
      });
      var n = lines.filter(function (l) { return !l.bad; }).length;
      row.className = 'cl-act is-ask';
      row.textContent = n ? what + ' bộ ' + p.set + (pin ? ' · ' + p.order : '') + ': tạo ' + n + ' sequence? Bấm dòng để bỏ chọn.' : what + ' bộ ' + p.set + ': không còn gì để tạo.';
      save('is-ask', row.textContent);
      setClawd('idle', 'Chờ bro xác nhận');
      pickList(box, lines, function (k) { return 'Tạo ' + k + ' sequence'; }, async function (sel) {
        lines.forEach(function (l) { if (l.r) l.r.skip = sel.indexOf(l) < 0; });
        setClawd('work', 'Đang tạo ' + what + '…');
        learnAct(a);
        row.className = 'cl-act is-run';
        try {
          var out = pin ? await BINSET.runPin(p, p.rows, function (t) { row.textContent = t; })
                        : await BINSET.runApp(p.rows, function (t) { row.textContent = t; });
          row.className = 'cl-act ' + (out.failed.length ? 'is-error' : 'is-ok');
          row.textContent = 'Đã tạo ' + out.made + ' sequence ' + what + ' bộ ' + p.set + (pin ? ' vào ' + p.order : '') + (out.failed.length ? ' — lỗi: ' + out.failed.join('; ') : '');
        } catch (e) { row.className = 'cl-act is-error'; row.textContent = what + ' lỗi: ' + e.message; }
        save(row.className.replace('cl-act ', ''), row.textContent);
        var bad = row.classList.contains('is-error');
        setClawd(bad ? 'fail' : 'done', bad ? 'Có bước lỗi' : 'Xong', bad ? 'is-error' : 'is-done');
      }, function () { row.className = 'cl-act is-skip'; row.textContent = 'Đã bỏ qua — không tạo ' + what; save('is-skip', row.textContent); setClawd('idle'); });
    }).catch(function (e) { fail(what + ' lỗi: ' + e.message); });
    setClawd('think', 'Đang đọc project…');
    return { cls: 'is-ask', text: what };
  }

  function askConfirm(entry, rec, idx, a) {
    if (a.action === 'move_items' || a.action === 'fix_voice_bins') return askMoves(entry, rec, idx, a);
    if (a.action === 'resize') return askResize(entry, rec, idx, a);
    if (a.action === 'rawcut') return askRaw(entry, rec, idx, a);
    if (a.action === 'bin_set') return askBinSet(entry, rec, idx, a);
    if (a.action === 'app_set' || a.action === 'pin_order') return askAppPin(entry, rec, idx, a);
    var lb = askLabel(a);
    var row = addAct(entry, 'is-ask', lb.q);
    var btns = document.createElement('div');
    btns.className = 'cl-askBtns';
    btns.innerHTML = '<div class="cl-btn cl-btn--primary" role="button"></div><div class="cl-btn" role="button"></div>';
    btns.children[0].textContent = lb.yes;
    btns.children[1].textContent = lb.no;
    entry.result.appendChild(btns);
    setClawd('idle', 'Chờ bro xác nhận');
    function pick(gen) {
      btns.remove();
      var run = {}; for (var k in a) run[k] = a[k];
      run.autoGenerate = gen;
      setClawd('work', 'Đang làm…');
      runOne(row, run).then(function (res) {
        rec.acts[idx] = res;
        saveHistory();
        setClawd(res.cls === 'is-error' ? 'fail' : 'done', res.cls === 'is-error' ? 'Lỗi' : 'Xong', res.cls === 'is-error' ? 'is-error' : 'is-done');
      });
    }
    btns.children[0].addEventListener('click', function () { pick(true); });
    btns.children[1].addEventListener('click', function () { pick(false); });
    return { cls: 'is-ask', text: lb.q };
  }

  // Trả về true nếu còn việc chờ xác nhận (Clawd đứng chờ thay vì báo Xong).
  async function runActions(entry, actions, rec) {
    var waiting = false;
    for (var i = 0; i < actions.length; i++) {
      var chk = CLA.check(actions[i]);
      if (!chk.ok) {
        addAct(entry, 'is-error', chk.error);
        rec.acts.push({ cls: 'is-error', text: chk.error });
      } else if (chk.mode === 'confirm') {
        rec.acts.push(askConfirm(entry, rec, rec.acts.length, chk.action));
        waiting = true;
      } else {
        var row = addAct(entry, 'is-run', chk.action.action + '…');
        scrollEnd();
        rec.acts.push(await runOne(row, chk.action));
      }
      scrollEnd();
    }
    return waiting;
  }

  // ── Gói Claude tạm hết lượt ─────────────────────────────────────────────────
  function showRateLimit(entry, resetAt) {
    entry.reply.className = 'cl-reply';
    entry.reply.innerHTML = '<div class="cl-rate">Gói Claude tạm hết lượt' +
      (resetAt ? ' — thử lại sau <span class="cl-rateCd">--:--</span>' : '') +
      '. Hoặc điền ANTHROPIC_API_KEY trong ⚙ Settings để chạy bằng API.</div>';
    if (!resetAt) return;
    var cd = entry.reply.querySelector('.cl-rateCd');
    var t = setInterval(function () {
      var left = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
      if (cd) cd.textContent = CLLOG.fmtDur(left);
      if (!left || !document.body.contains(cd)) clearInterval(t);
    }, 1000);
  }

  // ── Gửi lệnh ────────────────────────────────────────────────────────────────
  var busy = null;   // { xhr, aborted, timer }

  function voiceContextFor(text) {
    if (!/voice|giọng|đọc|narrat|speak|lồng tiếng/i.test(text)) return null;
    if (typeof window.VoiceGenGetVoices !== 'function') return null;
    var list = window.VoiceGenGetVoices().filter(function (v) { return !v.isSep; });
    return list.length ? list.map(function (v) { return v.voice_id + ': ' + v.label; }).join('\n') : null;
  }

  // opts: {text, mode, via:'button'|'flow'} — bấm nút / bước quy trình gửi thẳng, không qua ô lệnh.
  // Trả Promise → rec của lệnh khi xong (quy trình chờ để chạy bước tiếp).
  function send(opts) {
    opts = opts || {};
    var cmd = String(opts.text != null ? opts.text : (input.value || '')).trim();
    if (!cmd || busy || (flow && opts.via !== 'flow')) return Promise.resolve(null);
    if (opts.text == null) { input.value = ''; resizeInput(); }
    var doneCb, donePromise = new Promise(function (r) { doneCb = r; });
    if (!opts.via) learnCmd(cmd, CLC.vars(seqNameNow()));

    showView('log');
    var entry = makeEntry(cmd, false), sentMode = opts.mode || mode, tools = { proj: 0, web: 0, page: 0, find: 0, file: 0 };
    setMeta(entry, sentMode, tools);
    entry.reply.className = 'cl-reply is-pending';
    entry.reply.textContent = sentMode === 'free' ? 'Đang tìm hiểu…' : 'Đang hiểu ý…';
    syncEmpty();
    scrollEnd();

    var startAt = Date.now();
    setClawd('think', CLLOG.thinkingText(0));
    var xhr = new XMLHttpRequest();
    busy = { xhr: xhr, aborted: false };
    var toolUsed = function () { return tools.proj + tools.web + tools.page + tools.find + tools.file > 0; };
    busy.timer = setInterval(function () {
      // Đang dùng tool thì giữ chữ "Đang tìm trên web…"; chưa thì đếm giây.
      if (stateEl && clawd.scene === 'think' && !toolUsed()) stateEl.textContent = CLLOG.thinkingText((Date.now() - startAt) / 1000);
    }, 1000);
    setSendMode();

    var fullText = '', lastLen = 0, errText = '', rate = null, finished = false;

    // Chỉ xử lý tới hết dòng cuối đã đủ — dòng SSE bị cắt giữa hai lần nhận phải chờ lần sau
    // (bỏ đi là mất cả sự kiện — chữ trả lời, tool, lỗi).
    function parseSSE() {
      var text = xhr.responseText || '';
      var end = text.lastIndexOf('\n');
      if (end < lastLen) return;
      var chunk = text.slice(lastLen, end + 1);
      lastLen = end + 1;
      chunk.split('\n').forEach(function (line) {
        if (line.indexOf('data: ') !== 0) return;
        var raw = line.slice(6);
        if (raw === '[DONE]') return;
        var ev;
        try { ev = JSON.parse(raw); } catch (e) { return; }
        if (ev.type === 'text') {
          fullText += ev.content;
          var html = CLLOG.renderReply(fullText);
          if (html) { entry.reply.className = 'cl-reply'; entry.reply.innerHTML = html; }
          scrollEnd();
        } else if (ev.type === 'tool_use') {
          if (/^mcp__premiere__/.test(ev.name)) tools.proj++;   // bridge trả lời từ bản chụp gửi kèm
          else if (ev.name === 'WebSearch') tools.web++;
          else if (ev.name === 'WebFetch') tools.page++;
          else if (ev.name === 'Read') tools.file++;
          else if (ev.name === 'Glob' || ev.name === 'Grep') tools.find++;
          setMeta(entry, sentMode, tools);
          setClawd('think', toolStatus(ev.name, ev.detail));
        } else if (ev.type === 'rate_limit') {
          rate = { resetAt: ev.resetAt || null };   // CLI hay tự thử lại — chỉ hiện nếu không có chữ nào
          if (ev.resetAt) RATE_LIMIT_UNTIL = ev.resetAt;
        } else if (ev.type === 'error') {
          errText = ev.content || 'Lỗi không rõ';
        }
      });
    }

    async function finish() {
      if (finished) return;
      finished = true;
      clearInterval(busy.timer);
      var aborted = busy.aborted;
      busy = null;
      setSendMode();

      var rec = { cmd: cmd, raw: '', acts: [], at: Date.now(), mode: sentMode, tools: tools };
      if (aborted) {
        entry.reply.className = 'cl-reply is-pending';
        entry.reply.textContent = 'Đã dừng.';
        rec.err = 'Đã dừng.';
        setClawd('idle');
      } else if (!fullText && rate) {
        showRateLimit(entry, rate.resetAt);
        rec.err = 'Gói Claude tạm hết lượt.';
        setClawd('fail', 'Hết lượt — thử lại sau', 'is-error');
      } else if (!fullText) {
        var msg = errText || (xhr.status === 0 ? BRIDGE_OFFLINE_MSG : 'Bridge trả về lỗi HTTP ' + xhr.status);
        entry.reply.className = 'cl-reply is-error';
        entry.reply.textContent = msg;
        rec.err = msg;
        setClawd('fail', 'Lỗi', 'is-error');
      } else {
        rec.raw = fullText;
        if (!CLLOG.renderReply(fullText)) entry.reply.textContent = '';
        var actions = CLA.parse(fullText), waiting = false;
        if (actions.length) {
          setClawd('work', 'Đang làm…');
          waiting = await runActions(entry, actions, rec);
          if (typeof refreshTimeline === 'function') refreshTimeline();
        }
        var failed = rec.acts.some(function (a) { return a.cls === 'is-error'; });
        if (failed) setClawd('fail', 'Có bước lỗi', 'is-error');
        else if (!waiting) setClawd('done', 'Xong', 'is-done');
      }
      if (!aborted && fullText) showRemember(entry, rec, CLC.parseRemember(fullText));
      history = CLLOG.pushHistory(history, rec);
      saveHistory();
      if (!opts.via) maybeSuggest(entry);
      scrollEnd();
      doneCb(rec);
    }

    xhr.open('POST', BRIDGE_URL + '/chat', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = sentMode === 'free' ? 600000 : 300000;     // research có thể tìm web vài phút
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 3 || xhr.readyState === 4) parseSSE();
      if (xhr.readyState === 4) finish();
    };
    xhr.onerror = finish;
    xhr.ontimeout = function () { errText = 'Bridge không trả lời sau ' + (sentMode === 'free' ? 10 : 5) + ' phút.'; finish(); };
    xhr.onabort = finish;
    // Kèm đường dẫn project (cho đọc file) + bản chụp bin/item (cho tool đọc project — bridge trả
    // lời từ đây, không hỏi ngược plugin giữa chừng: UXP kẹt request khi stream /chat còn mở).
    Promise.all([projectPath(), PTOOLS.snapshot()]).then(function (got) {
      var pp = got[0], snap = got[1], learn = CLSTORE.learn();
      if (busy && busy.aborted) return;
      xhr.send(JSON.stringify({
        messages: CLLOG.toMessages(history).concat([{ role: 'user', content: cmd }]),
        mode: sentMode,
        project: snap || undefined,
        projectPath: pp || undefined,
        timelineContext: timelineContext,
        model: CLAUDE_MODEL,
        apiKey: ANTHROPIC_KEY || undefined,
        voiceContext: voiceContextFor(cmd) || undefined,
        notes: CLSTORE.get().notes || undefined,
        projectFacts: (learn.facts && snap) ? (CLC.projectFacts(snap, seqNameNow()) || undefined) : undefined
      }));
    });
    return donePromise;
  }

  function stop() {
    if (flow) flow.aborted = true;
    if (!busy) return;
    busy.aborted = true;
    try { busy.xhr.abort(); } catch (e) {}
  }

  // ── Ô lệnh ──────────────────────────────────────────────────────────────────
  // Chiều cao ô = div #clSizer chứa cùng chữ (kiểu Voice Gen) — UXP không chịu height
  // của textarea. Dòng cuối rỗng (vừa Shift+Enter) thêm ' ' để sizer tính cả dòng đó.
  var sizerEl = $('clSizer'), fieldEl = $('clField');
  function resizeInput() {
    var v = String(input.value || '');
    sizerEl.textContent = (v || ' ') + (/\n$/.test(v) ? ' ' : '');
    // UXP đôi khi vẽ textarea tuyệt đối lệch tới khi có relayout — ép relayout như vgReflow.
    fieldEl.style.display = 'none'; void fieldEl.offsetHeight; fieldEl.style.display = '';
    setSendMode();
  }
  function setSendMode() {
    if (busy || flow) {
      sendEl.className = 'cl-send is-stop';
      sendEl.setAttribute('aria-label', 'Dừng');
      sendEl.innerHTML = pluginIconSVG('stop', 11, '#e5e5e5');
    } else {
      sendEl.className = 'cl-send' + (String(input.value || '').trim() ? '' : ' is-empty');
      sendEl.setAttribute('aria-label', 'Gửi');
      sendEl.innerHTML = pluginIconSVG('arrow_right', 14, '#ffffff');
    }
  }
  input.addEventListener('input', resizeInput);
  input.addEventListener('focus', window.claimKeyboard);
  input.addEventListener('blur', window.releaseKeyboard);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  sendEl.addEventListener('click', function () { if (busy || flow) stop(); else send(); });

  function fill(text) {
    input.value = text;
    resizeInput();
    input.focus();
  }
  // Lệnh mẫu ở màn trống + link trong câu trả lời (mở trình duyệt qua bridge /open-url)
  logEl.addEventListener('click', function (e) {
    var t = e.target;
    var link = t && t.closest ? t.closest('.cl-link') : null;
    if (link) {
      var x = new XMLHttpRequest();
      x.open('POST', BRIDGE_URL + '/open-url', true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.send(JSON.stringify({ url: link.getAttribute('data-href') }));
      return;
    }
    var ex = t && t.closest ? t.closest('[data-fill]') : null;
    if (ex) fill(ex.getAttribute('data-fill'));
  });

  // ── Xoá nhật ký: bấm 2 lần ──────────────────────────────────────────────────
  var clearTimer = null;
  if (clearEl) clearEl.addEventListener('click', function () {
    if (!clearEl.classList.contains('is-armed')) {
      clearEl.classList.add('is-armed');
      clearEl.textContent = 'Bấm lại để xoá';
      clearTimer = setTimeout(function () { clearEl.classList.remove('is-armed'); clearEl.textContent = 'Xoá'; }, 3000);
      return;
    }
    clearTimeout(clearTimer);
    clearEl.classList.remove('is-armed');
    clearEl.textContent = 'Xoá';
    stop();
    history = [];
    saveHistory();
    logEl.querySelectorAll('.cl-entry').forEach(function (n) { n.remove(); });
    syncEmpty();
    setClawd('idle');
  });

  // ── Tự học: thói quen + gợi ý lưu nút, Claude đề xuất ghi nhớ ────────────────
  function seqNameNow() { return (timelineContext && timelineContext.sequenceName) || ''; }
  function learnCmd(cmd, v) {
    if (!CLSTORE.learn().suggest) return;
    CLSTORE.setHabits(CLC.recordCmd(CLSTORE.habits(), cmd, v, Date.now()));
  }
  function learnAct(a) {
    if (!CLSTORE.learn().suggest || (flow && !flow.learn)) return;   // quy trình đã lưu → không học lại
    CLSTORE.setHabits(CLC.recordAction(CLSTORE.habits(), a, Date.now()));
  }
  var shownSuggest = {};
  function learnCard(entry, title, text, yes, onYes, onNo) {
    var box = document.createElement('div');
    box.className = 'cl-learn';
    box.appendChild(document.createTextNode(title));
    var t = document.createElement('div');
    t.className = 'cl-learnText';
    t.textContent = text;
    box.appendChild(t);
    var btns = document.createElement('div');
    btns.className = 'cl-askBtns';
    btns.innerHTML = '<div class="cl-btn cl-btn--primary" role="button"></div><div class="cl-btn" role="button">Thôi</div>';
    btns.children[0].textContent = yes;
    btns.children[0].addEventListener('click', function () { box.textContent = onYes(); box.className = 'cl-act is-ok'; });
    btns.children[1].addEventListener('click', function () { box.remove(); if (onNo) onNo(); });
    box.appendChild(btns);
    entry.result.appendChild(box);
    scrollEnd();
  }
  function maybeSuggest(entry) {
    if (!CLSTORE.learn().suggest) return;
    var sg = CLC.suggest(CLSTORE.habits(), CLSTORE.get());
    if (!sg || shownSuggest[sg.key]) return;
    shownSuggest[sg.key] = 1;
    var isFlow = sg.kind === 'flow';
    learnCard(entry,
      isFlow ? 'Gợi ý: bro hay làm liền mấy việc này (' + sg.n + ' lần). Lưu thành quy trình một nút?'
             : 'Gợi ý: bro gõ lệnh này ' + sg.n + ' lần rồi. Lưu thành nút?',
      isFlow ? sg.steps.map(CLC.stepLabel).join('  →  ') : sg.text,
      isFlow ? 'Lưu quy trình' : 'Lưu nút',
      function () {
        var d = CLSTORE.get();
        d.buttons.push(isFlow ? { name: CLC.suggestName(sg), kind: 'flow', steps: sg.steps }
                              : { name: CLC.suggestName(sg), kind: 'prompt', mode: 'command', prompt: sg.text });
        CLSTORE.set(d);
        return 'Đã lưu nút “' + CLC.suggestName(sg) + '” — đổi tên / sửa ở ⚙';
      },
      function () { CLSTORE.setHabits(CLC.decline(CLSTORE.habits(), sg.key)); });
  }
  function showRemember(entry, rec, lines) {
    lines.forEach(function (line) {
      learnCard(entry, 'Claude muốn nhớ vào ghi chú của bro:', line, 'Nhớ', function () {
        var d = CLSTORE.get(), r = CLC.addNote(d.notes, line);
        if (r.ok) { d.notes = r.notes; CLSTORE.set(d); }
        var msg = r.ok ? 'Đã nhớ: ' + line : 'Không nhớ được: ' + (r.error || 'trống');
        rec.acts.push({ cls: r.ok ? 'is-ok' : 'is-error', text: msg });
        saveHistory();
        return msg;
      });
    });
  }

  // ── Quy trình: chạy lần lượt các bước, bước cần xác nhận thì chờ bro bấm ─────
  var flow = null;   // { aborted, learn }
  var autoRun = false;  // hàng đợi đang chạy quy trình: thẻ xác nhận tự chọn hết + chạy
  var lastFlowStopped = false;
  function waitAsk(rec, idx) {
    return new Promise(function (res) {
      var t = setInterval(function () {
        var a = rec.acts[idx];
        if ((flow && flow.aborted) || !a || a.cls !== 'is-ask') { clearInterval(t); res(a ? a.cls : 'is-skip'); }
      }, 300);
    });
  }
  function askWait(entry, rec, idx, text) {
    if (autoRun) { addAct(entry, 'is-skip', text + ' — hàng đợi tự đi tiếp'); rec.acts[idx] = { cls: 'is-ok', text: text }; saveHistory(); return; }
    var row = addAct(entry, 'is-ask', text);
    var btns = document.createElement('div');
    btns.className = 'cl-askBtns';
    btns.innerHTML = '<div class="cl-btn cl-btn--primary" role="button">Tiếp tục</div><div class="cl-btn" role="button">Dừng quy trình</div>';
    entry.result.appendChild(btns);
    setClawd('idle', 'Chờ bro làm tay');
    function done(ok) { btns.remove(); row.className = 'cl-act ' + (ok ? 'is-ok' : 'is-skip'); rec.acts[idx] = { cls: ok ? 'is-ok' : 'is-skip', text: text }; saveHistory(); }
    btns.children[0].addEventListener('click', function () { done(true); });
    btns.children[1].addEventListener('click', function () { done(false); });
    scrollEnd();
  }
  // → Promise<[ref đã chọn]> | null (bỏ qua)
  function askPick(entry, rec, idx, label, refs) {
    if (autoRun) { rec.acts[idx] = { cls: 'is-ok', text: label + ': ' + refs.length + ' sequence (hàng đợi)' }; return Promise.resolve(refs); }
    return new Promise(function (resolve) {
      var row = addAct(entry, 'is-ask', label + ': chọn sequence');
      var box = document.createElement('div');
      box.className = 'cl-moves';
      entry.result.appendChild(box);
      setClawd('idle', 'Chờ bro chọn sequence');
      var lines = refs.map(function (r) { var p = r.split(' ▸ '); return { name: p.pop(), sub: p.join(' ▸ '), ref: r }; });
      pickList(box, lines, function (k) { return 'Chạy với ' + k + ' sequence'; }, function (sel) {
        box.remove(); row.className = 'cl-act is-ok'; row.textContent = label + ': ' + sel.length + ' sequence';
        rec.acts[idx] = { cls: 'is-ok', text: row.textContent }; saveHistory();
        resolve(sel.map(function (l) { return l.ref; }));
      }, function () { row.className = 'cl-act is-skip'; rec.acts[idx] = { cls: 'is-skip', text: label }; saveHistory(); resolve(null); });
    });
  }

  // over (từ phiếu chạy): {set, idxs:[số], platform} — thay bộ / video / nền tảng của các bước.
  // ── Khối đơn (flow-engine.js): lập kế hoạch → thẻ xem trước → chạy, ghi kết quả cho bước sau ──
  // eng = {targets:[{set, idx}], results:[...]} dùng chung cả quy trình. → 'ok' | 'skip' | 'error'
  async function seqByRef(ref) {
    PTOOLS.invalidate();
    var r = await PTOOLS.sequencesFor([ref]);
    if (!r.seqs.length) throw new Error('không mở được ' + String(ref).split(' ▸ ').pop() + (r.rows[0] && r.rows[0].error ? ' (' + r.rows[0].error + ')' : ''));
    return r.seqs[0];
  }
  async function engineStep(entry, rec, st, n, eng, label) {
    var items = (await PTOOLS.snapshot()) || [];
    var ctx = { items: items, targets: eng.targets, results: eng.results, platform: eng.platform, frames: eng.frames, fps: eng.fps };
    var renderRoot = '';
    if (st.type === 'render') {                    // Render: danh sách file đã render (học thư mục giao từ bộ trước)
      try {
        var ri = await fetch(BRIDGE_URL + '/render/index', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectPath: await projectPath() }) }).then(function (x) { return x.json(); });
        if (ri && ri.ok) { ctx.renderFiles = ri.files || []; ctx.renderDirs = ri.dirs || []; renderRoot = ri.root; }
        else throw new Error((ri && ri.error) || 'Bridge không trả lời');
      } catch (e) {
        addAct(entry, 'is-error', label + ': ' + e.message); rec.acts.push({ cls: 'is-error', text: label + ': ' + e.message });
        eng.results.push(eng.targets.map(function () { return null; }));
        return 'error';
      }
    }
    var rows = FLE.planStep(st, n, ctx);
    var idx = rec.acts.length;
    rec.acts.push({ cls: 'is-ask', text: label });
    var row = addAct(entry, 'is-ask', label);
    var box = document.createElement('div');
    box.className = 'cl-moves';
    entry.result.appendChild(box);
    // Tạo bin: nhiều video chung một bin → một dòng (tạo một lần, mọi video đó coi như xong)
    var shown = rows;
    // Render: chỉ liệt kê bản sẽ xuất (và bản đã có file); bản không cần render gộp thành 1 dòng tóm tắt
    var skipped = 0;
    if (st.type === 'render') { skipped = rows.filter(function (r) { return r.skip; }).length; shown = rows.filter(function (r) { return !r.skip; }); }
    if (st.type === 'bin_make') {
      var byBin = {};
      shown = [];
      rows.forEach(function (r) {
        if (r.error) { shown.push(r); return; }
        if (byBin[r.bin]) { byBin[r.bin].also.push(r.key); return; }
        r.also = [r.key]; byBin[r.bin] = r; shown.push(r);
      });
    }
    var lines = shown.map(function (r) {
      var title = st.type === 'bin_make' ? r.bin : st.type === 'raw_export' ? (r.src ? r.src.name : 'vid' + r.key) : (r.name || ('vid' + r.key));
      if (r.error) return { name: 'vid' + r.key + ' · ' + (title || ''), sub: r.error, bad: true, r: r };
      if (st.type === 'render') {
        if (r.exists) return { name: title, sub: 'đã có file — bỏ qua', bad: true, r: r };
        return { name: title, sub: '→ ' + r.dest + (r.learnedFrom ? '' : ' (mặc định — chưa có bộ nào đã render)'), r: r };
      }
      if (r.exists && st.type !== 'raw_export') return { name: title, sub: 'đã có' + (r.where ? ' ở ' + r.where.split(' / ').pop() : '') + ' — bỏ qua', bad: true, r: r };
      var sub = st.type === 'bin_make' ? 'bin mới' + (r.also && r.also.length > 1 ? ' · cho ' + r.also.length + ' video' : '') : st.type === 'seq_make' ? (r.like ? 'cài đặt như ' + r.like.name : 'khung ' + r.frame.join('×')) + (r.fps ? ' · ' + r.fps + 'fps' : '') + ' → ' + r.bin
              : st.type === 'seq_move' ? r.src.name + ' → ' + r.bin
              : st.type === 'raw_export' ? (st.mode === 'both' ? 'source + render' : st.mode)
              : 'từ ' + (r.src ? r.src.name : '?') + ' → ' + r.bin;
      return { name: title, sub: sub, r: r };
    });
    return await new Promise(function (resolve) {
      function finish(cls, text, res) {
        row.className = 'cl-act ' + cls; row.textContent = text;
        rec.acts[idx] = { cls: cls, text: text }; saveHistory();
        eng.results.push(res);
        resolve(cls === 'is-error' ? 'error' : cls === 'is-skip' ? 'skip' : 'ok');
      }
      function resultsOf(okKeys) {   // kết quả cho bước sau: dòng đã có / vừa tạo; lỗi / bỏ chọn → null
        var tmp = { items: items.slice(), results: eng.results.slice() };
        var all = FLE.applyVirtual(st, rows, tmp);
        return all.map(function (x, k) { var r = rows[k]; return (r.error || (!r.exists && okKeys.indexOf(r.key) < 0 && st.type !== 'bin_make' && st.type !== 'raw_export' && st.type !== 'render')) ? null : x; });
      }
      var todo = lines.filter(function (l) { return !l.bad; }).length;
      row.textContent = label + (todo ? ' — ' + todo + (st.type === 'render' ? ' video' : ' việc') : ' — không còn gì để làm')
        + (skipped ? ' · bỏ qua ' + skipped + ' bản không cần render (bản sao, resize tài nguyên' + (eng.platform ? ', nền tảng khác' : '') + ')' : '');
      if (!todo) {
        box.remove();
        var why = st.type === 'render' && skipped && !rows.some(function (r) { return r.exists; })
          ? ' — không có bản nào bộ trước đã render (' + skipped + ' bản bỏ qua)' : ' — đã có đủ';
        finish(st.type === 'render' && why.indexOf('không có') > 0 ? 'is-skip' : 'is-ok', label + why, resultsOf([]));
        return;
      }
      pickList(box, lines, function (k) { return (st.type === 'raw_export' || st.type === 'render' ? 'Xuất ' : 'Tạo ') + k; }, async function (sel) {
        setClawd('work', label + '…');
        row.className = 'cl-act is-run';
        var ok = [], fail = [];
        try {
          if (st.type === 'render') {
            for (var q = 0; q < sel.length; q++) {
              var rr = sel[q].r;
              row.textContent = 'Đang render ' + (q + 1) + '/' + sel.length + ': ' + rr.name + '…';
              try {
                var prep = await fetch(BRIDGE_URL + '/render/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ root: renderRoot, dir: rr.dest, name: rr.name }) }).then(function (x) { return x.json(); });
                if (!prep || !prep.ok) throw new Error((prep && prep.error) || 'Bridge không trả lời');
                var ex2 = await RCP.exportFile(await seqByRef(rr.src.ref), prep.file, prep.preset);
                if (!ex2.ok) throw new Error(ex2.error);
                ok.push(rr.key);
              } catch (e) { fail.push(rr.name + ': ' + ((e && e.message) || e)); if (/Media Encoder/.test(String(e && e.message))) break; }
            }
          } else if (st.type === 'raw_export') {
            var seqs = [];
            for (var a = 0; a < sel.length; a++) seqs.push(await seqByRef(sel[a].r.src.ref));
            row.textContent = 'Đang xuất RAW ' + seqs.length + ' sequence… (xem tab RAW)';
            var ex = st.auto ? await window.RawcutAPI.exportSeqs(seqs, st.mode) : await window.RawcutAPI.prepare(seqs, st.mode);
            if (ex.failed && ex.failed.length) fail = ex.failed; else sel.forEach(function (l) { ok.push(l.r.key); });
          } else {
            var project = await getActiveProject();
            for (var b = 0; b < sel.length; b++) {
              var r = sel[b].r;
              row.textContent = label + ' ' + (b + 1) + '/' + sel.length + '…';
              try {
                if (st.type === 'bin_make') {
                  if (!(await ppGetOrCreateBin(project, r.bin))) throw new Error('không tạo được bin');
                  (r.also || []).forEach(function (k) { if (k !== r.key) ok.push(k); });
                } else if (st.type === 'seq_make') {
                  await window.ResizeAPI.makeSequence(r.name, r.bin, { like: r.like ? await seqByRef(r.like.ref) : null, frame: r.frame || null, fps: r.fps || '' });
                } else if (st.type === 'seq_clone') {
                  await window.ResizeAPI.cloneInto(await seqByRef(r.src.ref), r.name, r.bin);
                } else if (st.type === 'seq_move') {
                  await window.ResizeAPI.moveInto(await seqByRef(r.src.ref), r.bin);
                } else if (st.type === 'seq_resize') {
                  var src = await seqByRef(r.src.ref);
                  var wanted = r.ratio === 'other' ? ['9-16', '4-5'] : r.ratio === 'prev' ? (r.ratios || []) : [r.ratio];
                  var pl = await window.ResizeAPI.plan(r.platform, wanted, [src]);
                  if (!pl.ok) throw new Error(pl.error);
                  var go = pl.plan.filter(function (x) { return !x.skip && !x.exists && !x.dupInPlan; });
                  if (!go.length && pl.plan.some(function (x) { return x.exists || x.dupInPlan; })) { ok.push(r.key); continue; }   // đã có → coi như xong
                  if (!go.length) throw new Error((pl.plan[0] && pl.plan[0].skip) || 'không có ratio nào để resize');
                  var out = await window.ResizeAPI.run(r.platform, go, function () {}, r.bin && r.src.bin !== r.bin ? { destBin: r.bin } : null);
                  var er = out.results.filter(function (x) { return x.error; });
                  if (er.length) throw new Error(er[0].error);
                }
                ok.push(r.key);
              } catch (e) { fail.push('vid' + r.key + ': ' + ((e && e.message) || e)); }
            }
          }
        } catch (e) { fail.push((e && e.message) || String(e)); }
        PTOOLS.invalidate();
        var done = st.type === 'bin_make' ? sel.length + ' bin' + (ok.length > sel.length ? ' (' + ok.length + ' video)' : '') : String(ok.length);
        if (fail.length) finish('is-error', label + ' — xong ' + done + ', lỗi: ' + fail.join('; '), resultsOf(ok));
        else finish('is-ok', label + ' — xong ' + done, resultsOf(ok));
      }, function () { finish('is-skip', label + ' — bỏ qua', resultsOf([])); });
      setClawd('idle', 'Chờ bro xác nhận');
    });
  }

  // Lỗi bất ngờ trong quy trình không được làm panel đứng im (bug 2026-10-05: nút GG bấm Chạy không có gì xảy ra
  // — runFlow văng TypeError trong async, không ai bắt). Bắt lại, dọn trạng thái, báo lỗi trong nhật ký.
  async function runFlow(b, over) {
    try { return await runFlowCore(b, over); }
    catch (e) {
      console.error('[claude-tab] runFlow', e);
      flow = null; window.CL_FLOW_RUNNING = 0;
      try {
        var en = makeEntry((b && b.name) || 'Quy trình', false);
        addAct(en, 'is-error', 'Quy trình lỗi: ' + ((e && e.message) || e));
        syncEmpty();
      } catch (e2) {}
      setSendMode();
      setClawd('fail', 'Quy trình lỗi', 'is-error');
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }
  async function runFlowCore(b, over) {
    if (busy || flow) return { ok: false, error: 'đang chạy việc khác' };
    over = over || {};
    autoRun = !!over.auto;
    window.CL_FLOW_RUNNING = Date.now();                 // việc các tab làm trong lúc chạy quy trình không ghi nhật ký riêng
    showView('log');
    var v = CLC.vars(seqNameNow());
    if (over.set) v['bộ'] = String(over.set);
    if (over.idxs || over.platform) b = { name: b.name, steps: b.steps.map(function (st) {
      var n = JSON.parse(JSON.stringify(st));
      if (over.idxs && n.seqs && n.seqs.length && n.seqs[0].k !== 'current') n.seqs = over.idxs.map(function (x) { return { k: 'idx', n: x }; });
      if (over.platform && n.platform && CLC.slotOptions(n, 'platform').some(function (o) { return o.value === over.platform; })) n.platform = over.platform;
      return n;
    }) };
    var title = CLC.fill(b.name, v).text;
    flow = { aborted: false, learn: false };
    setSendMode();
    var entry = makeEntry(title, false);
    var rec = { cmd: title, raw: '', acts: [], at: Date.now(), mode: 'command', flow: true };
    entry.meta.hidden = false;
    entry.meta.textContent = 'Quy trình · ' + b.steps.length + ' bước';
    syncEmpty();
    var items = null, stopped = '';
    // Video đích cho khối đơn: theo phiếu chạy; không chỉ định → mọi FB gốc của bộ (bộ mới chưa có → .0 .1 .2)
    var eng = { targets: null, results: [], platform: '', frames: over.frames || null };
    if (over.targets && over.targets.length) eng.targets = over.targets.map(function (t) { return { set: String(t.set), idx: Number(t.idx) }; });
    async function engTargets() {
      if (eng.targets) return eng.targets;
      var set = v['bộ'];
      if (!set) throw new Error('không biết bộ nào — mở một sequence vid{bộ}.N hoặc chọn bộ ở phiếu chạy');
      var idxs = over.idxs && over.idxs.length ? over.idxs
               : over.frames ? Object.keys(over.frames).map(Number).sort(function (a, c) { return a - c; }) : null;
      if (!idxs) {
        var snap = (await PTOOLS.snapshot()) || [];
        idxs = Object.keys(BSC.fbSources(snap, set)).map(Number).sort(function (a, c) { return a - c; });
        if (!idxs.length) idxs = [0, 1, 2];
      }
      eng.targets = idxs.map(function (n) { return { set: String(set), idx: n }; });
      return eng.targets;
    }
    for (var i = 0; i < b.steps.length && !stopped; i++) {
      if (flow.aborted) { stopped = 'Đã dừng ở bước ' + (i + 1) + '.'; break; }
      var st = b.steps[i], label = (i + 1) + '. ' + CLC.stepLabel(st);
      if (st.seqs && st.seqs.some(function (q) { return q.k !== 'current'; }) && !items) items = await PTOOLS.snapshot();
      var sa = CLC.stepAction(st, { vars: v, items: items || [] });
      if (sa.engine && st.type === 'platform') {       // khối Nền tảng: chỉ đặt ngữ cảnh cho các khối sau
        eng.platform = st.p; eng.fps = st.fps || '';
        eng.results.push((eng.targets || []).map(function () { return null; }));
        addAct(entry, 'is-ok', label);
        rec.acts.push({ cls: 'is-ok', text: label });
        continue;
      }
      if (sa.engine) {
        try { await engTargets(); } catch (e) { sa = { error: e.message }; }
        if (!sa.error) {
          var er = await engineStep(entry, rec, st, i + 1, eng, label);
          if (er === 'error' || (flow && flow.aborted)) { stopped = er === 'error' ? 'Dừng vì bước ' + (i + 1) + ' lỗi.' : 'Đã dừng ở bước ' + (i + 1) + '.'; break; }
          continue;
        }
      } else eng.results.push((eng.targets || []).map(function () { return null; }));   // khối khác: giữ chỗ để "kết quả bước N" đúng số
      if (sa.error) { addAct(entry, 'is-error', label + ': ' + sa.error); rec.acts.push({ cls: 'is-error', text: label + ': ' + sa.error }); stopped = 'Dừng vì bước ' + (i + 1) + ' lỗi.'; break; }
      if (sa.wait) {                                   // khối "Chờ bro": dừng tới khi bấm Tiếp tục
        var wi = rec.acts.length;
        rec.acts.push({ cls: 'is-ask', text: label });
        askWait(entry, rec, wi, label + ' — ' + sa.wait);
        if ((await waitAsk(rec, wi)) !== 'is-ok') { stopped = 'Bro dừng ở bước ' + (i + 1) + '.'; break; }
        continue;
      }
      if (sa.pick) {                                   // "Chọn lúc chạy": tick sequence rồi mới chạy bước
        var pi2 = rec.acts.length;
        rec.acts.push({ cls: 'is-ask', text: label });
        var chosen = await askPick(entry, rec, pi2, label, sa.pick.refs);
        if (!chosen) { stopped = 'Bỏ qua bước ' + (i + 1) + '.'; break; }
        sa = { action: Object.assign({}, sa.pick.action, { items: chosen }) };
      }
      if (sa.prompt) {                                 // bước hỏi Claude → một mục lệnh riêng
        addAct(entry, 'is-ok', label);
        rec.acts.push({ cls: 'is-ok', text: label });
        flow.learn = false;
        var r = await send({ text: sa.prompt, mode: 'command', via: 'flow' });
        if (!r) { stopped = 'Không gửi được bước ' + (i + 1) + '.'; break; }
        for (var k = 0; k < r.acts.length; k++) if (r.acts[k].cls === 'is-ask') await waitAsk(r, k);
        if (r.err || r.acts.some(function (a) { return a.cls === 'is-error'; })) { stopped = 'Dừng vì bước ' + (i + 1) + ' lỗi.'; break; }
        if (i < b.steps.length - 1) {                  // các bước sau nối vào mục mới, đứng dưới câu trả lời
          entry = makeEntry(title + ' (tiếp)', false);
          entry.meta.hidden = false; entry.meta.textContent = 'Quy trình · từ bước ' + (i + 2);
        }
        continue;
      }
      var chk = CLA.check(sa.action);
      if (!chk.ok) { addAct(entry, 'is-error', label + ': ' + chk.error); rec.acts.push({ cls: 'is-error', text: label + ': ' + chk.error }); stopped = 'Dừng vì bước ' + (i + 1) + ' lỗi.'; break; }
      addAct(entry, 'is-wait', label);
      scrollEnd();
      if (chk.mode === 'confirm') {
        var idx = rec.acts.length;
        rec.acts.push({ cls: 'is-ask', text: label });
        var first = askConfirm(entry, rec, idx, chk.action);
        if (rec.acts[idx].cls === 'is-ask' && first.cls !== 'is-ask') rec.acts[idx] = first;
        var res = await waitAsk(rec, idx);
        if (res === 'is-error') stopped = 'Dừng vì bước ' + (i + 1) + ' lỗi.';
      } else {
        setClawd('work', 'Bước ' + (i + 1) + '/' + b.steps.length + '…');
        var row = addAct(entry, 'is-run', chk.action.action + '…');
        var out = await runOne(row, chk.action);
        rec.acts.push(out);
        if (out.cls === 'is-error') stopped = 'Dừng vì bước ' + (i + 1) + ' lỗi.';
      }
      if (typeof refreshTimeline === 'function') refreshTimeline();
    }
    if (stopped) { addAct(entry, 'is-skip', stopped); rec.acts.push({ cls: 'is-skip', text: stopped }); }
    lastFlowStopped = !!stopped;                   // phiếu chạy nhiều bộ: dừng thì không chạy bộ sau
    var bad = rec.acts.some(function (a) { return a.cls === 'is-error'; });
    window.CL_FLOW_RUNNING = false;
    if (!bad && !stopped) (over.idxs && over.idxs.length ? over.idxs : [0]).forEach(function (n) { window.actLog && window.actLog('claude', 'flow', v['bộ'] ? 'vid' + v['bộ'] + '.' + n : '', { name: b.name }); });
    setClawd(bad ? 'fail' : 'done', bad ? 'Quy trình có bước lỗi' : 'Xong quy trình', bad ? 'is-error' : 'is-done');
    history = CLLOG.pushHistory(history, rec);
    saveHistory();
    flow = null;
    autoRun = false;
    setSendMode();
    scrollEnd();
    return { ok: !bad && !stopped, error: stopped || (bad ? 'có bước lỗi' : ''),
             detail: rec.acts.filter(function (a) { return a.cls === 'is-ok' || a.cls === 'is-error'; }).map(function (a) { return a.text; }).slice(-2).join(' · ') };
  }

  // ── Bấm nút lệnh / quy trình (bảng điều khiển gọi) — dữ liệu ở CLSTORE ──────
  function runButton(b) {
    if (busy || flow) return;
    if (b.kind === 'flow') { if (window.ClaudeDash) window.ClaudeDash.openSheet(b); return; }
    // Nút lệnh: điền lệnh (đã thay biến) vào ô cho bro xem / sửa, Enter mới gửi.
    var f = CLC.fill(b.prompt, CLC.vars(seqNameNow()));
    if (b.mode !== mode) setMode(b.mode);
    fill(f.text);
    setClawd('idle', f.missing.length ? 'Điền ' + f.missing.map(function (k) { return '{' + k + '}'; }).join(', ') + ' rồi Enter' : 'Xem lại lệnh rồi Enter');
  }

  // ── Màn: 'dash' (bảng điều khiển) | 'log' (lịch sử lệnh) | 'sheet' (phiếu chạy) ─────
  var tabEl = $('tab-claude'), view = 'dash';
  function showView(v) {
    view = v;
    ['dash', 'log', 'sheet'].forEach(function (k) { tabEl.classList.toggle('v-' + k, k === v); });
    if (v === 'dash' && window.ClaudeDash) window.ClaudeDash.render();
    if (v === 'log') { syncEmpty(); scrollEnd(); }
  }
  window.ClaudeTab = {
    showView: showView, runFlow: runFlow, runButton: runButton, flowStopped: function () { return lastFlowStopped; }, busy: function () { return !!(busy || flow); },
    history: function () { return history; }, seqName: seqNameNow, fill: fill,
    saveSuggest: function (sg) { shownSuggest[sg.key] = 1; },
    declineSuggest: function (sg) { CLSTORE.setHabits(CLC.decline(CLSTORE.habits(), sg.key)); }
  };

  // ── Khởi động ───────────────────────────────────────────────────────────────
  setMode(mode);
  renderPast();
  resizeInput();
  setClawd('idle');
  if (timelineContext) window.ClaudeTabSetSeq(timelineContext);
  showView('dash');
})();
