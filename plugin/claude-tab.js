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

  var HISTORY_KEY = 'cl_history_v1', SHORTCUT_KEY = 'claude-shortcuts';

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
    var reply = document.createElement('div');
    reply.className = 'cl-reply';
    var result = document.createElement('div');
    result.className = 'cl-result';
    root.appendChild(c); root.appendChild(reply); root.appendChild(result);
    logEl.appendChild(root);
    return { root: root, reply: reply, result: result };
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
    if (r && r.ok) { row.className = 'cl-act is-ok'; row.textContent = (r.data && r.data.message) || a.action; }
    else { row.className = 'cl-act is-error'; row.textContent = a.action + ': ' + ((r && r.error) || 'lỗi'); }
    return { cls: row.className.replace('cl-act ', ''), text: row.textContent };
  }

  function askLabel(a) {
    var what = a.action === 'voicegen_sfx' ? 'SFX' : 'voice';
    return { q: 'Gen ' + what + ' luôn? Tốn credit ElevenLabs.', yes: 'Gen luôn', no: a.action === 'voicegen_sfx' ? 'Chỉ đẩy prompt' : 'Chỉ đẩy script' };
  }

  function askConfirm(entry, rec, idx, a) {
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

  function send() {
    var cmd = String(input.value || '').trim();
    if (!cmd || busy) return;
    input.value = '';
    resizeInput();

    var entry = makeEntry(cmd, false);
    entry.reply.className = 'cl-reply is-pending';
    entry.reply.textContent = 'Đang hiểu ý…';
    syncEmpty();
    scrollEnd();

    var startAt = Date.now();
    setClawd('think', CLLOG.thinkingText(0));
    var xhr = new XMLHttpRequest();
    busy = { xhr: xhr, aborted: false };
    busy.timer = setInterval(function () {
      if (stateEl && clawd.scene === 'think') stateEl.textContent = CLLOG.thinkingText((Date.now() - startAt) / 1000);
    }, 1000);
    setSendMode();

    var fullText = '', lastLen = 0, errText = '', rate = null, finished = false;

    function parseSSE() {
      var text = xhr.responseText || '';
      var chunk = text.slice(lastLen);
      lastLen = text.length;
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

      var rec = { cmd: cmd, raw: '', acts: [], at: Date.now() };
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
      history = CLLOG.pushHistory(history, rec);
      saveHistory();
      scrollEnd();
    }

    xhr.open('POST', BRIDGE_URL + '/chat', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 300000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 3 || xhr.readyState === 4) parseSSE();
      if (xhr.readyState === 4) finish();
    };
    xhr.onerror = finish;
    xhr.ontimeout = function () { errText = 'Bridge không trả lời sau 5 phút.'; finish(); };
    xhr.onabort = finish;
    xhr.send(JSON.stringify({
      messages: CLLOG.toMessages(history).concat([{ role: 'user', content: cmd }]),
      timelineContext: timelineContext,
      model: CLAUDE_MODEL,
      apiKey: ANTHROPIC_KEY || undefined,
      voiceContext: voiceContextFor(cmd) || undefined
    }));
  }

  function stop() {
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
    if (busy) {
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
  sendEl.addEventListener('click', function () { if (busy) stop(); else send(); });

  function fill(text) {
    input.value = text;
    resizeInput();
    input.focus();
  }
  // Lệnh mẫu ở màn trống
  logEl.addEventListener('click', function (e) {
    var ex = e.target && e.target.closest ? e.target.closest('[data-fill]') : null;
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

  // ── Nút lệnh tự tạo ([{name, prompt}] — giữ khoá cũ của tab chat) ────────────
  var chipsEl = $('quick-actions'), addEl = $('add-shortcut-btn'), formEl = $('clScForm');
  function loadShortcuts() {
    try { var a = JSON.parse(localStorage.getItem(SHORTCUT_KEY) || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function saveShortcuts(arr) { try { localStorage.setItem(SHORTCUT_KEY, JSON.stringify(arr)); } catch (e) {} }
  function renderShortcuts() {
    chipsEl.innerHTML = '';
    var list = loadShortcuts();
    chipsEl.hidden = !list.length;
    list.forEach(function (sc, idx) {
      var chip = document.createElement('div');
      chip.className = 'cl-chip';
      chip.setAttribute('role', 'button');
      chip.textContent = sc.name;
      var armTimer = null;
      chip.addEventListener('click', function () {
        if (chip.classList.contains('is-armed')) {           // đang hỏi xoá → xoá
          var arr = loadShortcuts(); arr.splice(idx, 1); saveShortcuts(arr); renderShortcuts();
          return;
        }
        fill(sc.prompt);
      });
      // Chuột phải → hỏi xoá ngay trên nút, 3s không bấm thì thôi.
      chip.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        chip.classList.add('is-armed');
        chip.textContent = 'Xoá “' + sc.name + '”?';
        clearTimeout(armTimer);
        armTimer = setTimeout(function () { chip.classList.remove('is-armed'); chip.textContent = sc.name; }, 3000);
      });
      chipsEl.appendChild(chip);
    });
  }
  var scName = $('clScName'), scPrompt = $('clScPrompt');
  [scName, scPrompt].forEach(function (el) {
    el.addEventListener('focus', window.claimKeyboard);
    el.addEventListener('blur', window.releaseKeyboard);
  });
  function setFormOpen(open) {
    formEl.hidden = !open;
    addEl.classList.toggle('is-open', open);
  }
  addEl.addEventListener('click', function () {
    setFormOpen(formEl.hidden);
    if (!formEl.hidden) {
      scName.value = '';
      scPrompt.value = String(input.value || '').trim();   // đang gõ dở lệnh nào → gợi ý lưu luôn
      scName.focus();
    }
  });
  $('clScCancel').addEventListener('click', function () { setFormOpen(false); });
  $('clScSave').addEventListener('click', function () {
    var name = scName.value.trim(), prompt = scPrompt.value.trim();
    if (!name) { scName.focus(); return; }
    if (!prompt) { scPrompt.focus(); return; }
    var arr = loadShortcuts();
    arr.push({ name: name, prompt: prompt });
    saveShortcuts(arr);
    renderShortcuts();
    setFormOpen(false);
  });

  // ── Khởi động ───────────────────────────────────────────────────────────────
  renderShortcuts();
  renderPast();
  resizeInput();
  setClawd('idle');
  if (timelineContext) window.ClaudeTabSetSeq(timelineContext);
})();
