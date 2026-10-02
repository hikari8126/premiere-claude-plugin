// plugin/rename.js — tab Watch, mục "Đổi tên source hàng loạt": đổi tên file
// thật trên đĩa → relink clip trong project → đổi tên hiển thị → relink .aep.
//
// Classic script, nạp SAU main.js + watch.js + rename-core.js nên dùng chung global:
//   BRIDGE_URL, ppro, getActiveProject, sacCollectBinItems, sacGetItemName,
//   RNC (rename-core.js), wfApi.log (nhật ký tab Watch).
//
// Bridge làm mọi việc trên đĩa (đổi tên 2 pha, nhật ký, sửa .aep); file này lo
// Premiere: đọc selection, changeMediaFilePath, createSetNameAction, và giao diện.
// Spec: docs/superpowers/specs/2026-10-02-batch-rename-relink-design.md

(function () {
  'use strict';

  var LS_KEY = 'rn_prefs';

  var rn = {
    wired: false,
    busy: false,
    projectPath: null,
    rows: [],          // [{path, oldName, bin, items}] theo thứ tự đánh số
    skipped: [],       // [{name, reason}]
    preview: [],       // RNC.buildPreview(rows)
    server: null,      // kết quả /rename/plan mới nhất (cùng thứ tự với rows)
    planSeq: 0,
    planTimer: null,
    aep: [],           // [{path, name, count, checked}]
    aeRunning: false,
    aepScanning: false,
    aepNote: '',
    done: false,       // đã chạy xong lượt → nút chính thành "Đóng"
    hidden: [],
    journal: null,
    undoArmed: 0,
  };

  function $(id) { return document.getElementById(id); }
  async function un(v) { return (v && typeof v.then === 'function') ? await v : v; }
  async function awaitArray(v) {
    v = await un(v);
    if (!v) return [];
    if (Array.isArray(v)) return v;
    var n = v.length || 0, out = [];
    for (var i = 0; i < n; i++) out.push(v[i]);
    return out;
  }
  function baseName(p) { return String(p || '').split('/').pop(); }
  function fold(p) { var s = String(p || ''); if (s.normalize) s = s.normalize('NFC'); return s.toLowerCase(); }
  function log(text, isErr) { try { if (window.wfApi && window.wfApi.log) window.wfApi.log(text, isErr); } catch (e) {} }

  function api(method, url, body) {
    return fetch(BRIDGE_URL + url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      // Bridge cũ không có route → Express trả 404 HTML, r.json() sẽ nổ khó hiểu.
      if (r.status === 404 && url.indexOf('/rename/') === 0 && (r.headers.get('content-type') || '').indexOf('json') < 0) {
        return { ok: false, error: 'Bridge cũ chưa có tính năng đổi tên (cần ≥ 1.22.0) — cập nhật Claude Bridge' };
      }
      return r.json();
    })
      .catch(function (e) { return { ok: false, error: 'Bridge không trả lời: ' + e.message, offline: true }; });
  }

  function loadPrefs() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) {}
    var mode = (s.mode === 'n' || s.mode === 'custom') ? s.mode : 'num';
    return { mode: mode, tpl: typeof s.tpl === 'string' && s.tpl ? s.tpl : '{bin}_{num}', open: !!s.open };
  }
  // Hai kiểu bấm là chạy; "Tự đặt mẫu…" mới cần gõ (prefs.tpl).
  var MODE_TPL = { num: '{bin}_{num}', n: '{bin}_{n}' };
  function savePrefs(p) { try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch (e) {} }
  var prefs = loadPrefs();

  // ── Premiere ────────────────────────────────────────────────────────────
  async function currentProjectPath() {
    try {
      var proj = await getActiveProject();
      if (!proj) return null;
      var raw = await un(proj.path);
      return (raw && typeof raw === 'string' && raw.charAt(0) === '/') ? raw : null;
    } catch (e) { return null; }
  }

  function castClip(item) {
    try { return (ppro.ClipProjectItem && ppro.ClipProjectItem.cast) ? ppro.ClipProjectItem.cast(item) : null; }
    catch (e) { return null; }
  }
  function isFolder(item) {
    try { return !!(ppro.FolderItem && ppro.FolderItem.cast && ppro.FolderItem.cast(item)); } catch (e) { return false; }
  }
  async function call(obj, name) {
    if (!obj || typeof obj[name] !== 'function') return undefined;
    try { return await un(obj[name]()); } catch (e) { return undefined; }
  }
  async function mediaPathOf(item) {
    var cp = castClip(item) || item;
    var p = await call(cp, 'getMediaFilePath');
    return p ? String(p) : '';
  }

  // Bắt lỗi BÊN TRONG lockedAccess — throw lọt ra ngoài lock có thể làm treo Premiere.
  async function commit(project, fn, label) {
    var err = null;
    var r = project.lockedAccess(function () {
      try { project.executeTransaction(fn, label || 'Đổi tên source'); }
      catch (e) { err = e; }
    });
    if (r && typeof r.then === 'function') await r;
    if (err) throw err;
  }

  // Một clip trong selection → {entry} hoặc {skip: lý do}.
  async function classify(item, bin) {
    var name = await sacGetItemName(item);
    var cp = castClip(item);
    if (!cp) return { skip: { name: name, reason: 'Không phải clip' } };
    if (await call(cp, 'isSequence')) return { skip: { name: name, reason: 'Sequence' } };
    var p = await mediaPathOf(item);
    if (!p || p.charAt(0) !== '/') return { skip: { name: name, reason: 'Không có file (title, MOGRT…)' } };
    if (await call(cp, 'isOffline') === true) return { skip: { name: name, reason: 'Đang offline' } };
    if (await call(cp, 'canChangeMediaPath') === false) return { skip: { name: name, reason: 'Premiere không cho đổi đường dẫn' } };
    return { entry: { path: p, bin: bin, item: item, name: name } };
  }

  // Selection ở Project panel → {entries, skipped}. Bin → mọi clip bên trong (đệ quy);
  // {bin} = bin trực tiếp chứa clip.
  async function readSelection(project) {
    var entries = [], skipped = [], seen = {};
    // Chọn cả bin lẫn clip trong bin đó → cùng một item gặp 2 lần.
    async function push(c, item) {
      if (c.skip) { skipped.push(c.skip); return; }
      var id = await call(ppro.ProjectItem.cast(item), 'getId');
      if (id && seen[id]) return;
      if (id) seen[id] = true;
      entries.push(c.entry);
    }
    if (!ppro.ProjectUtils || typeof ppro.ProjectUtils.getSelection !== 'function') {
      throw new Error('Premiere này không có ProjectUtils.getSelection');
    }
    var sel = await un(ppro.ProjectUtils.getSelection(project));
    var items = sel ? await awaitArray(sel.getItems()) : [];
    var root = await un(project.getRootItem());
    var rootId = await call(ppro.ProjectItem.cast(root), 'getId');
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (isFolder(it)) {
        var binName = await sacGetItemName(it);
        var kids = await sacCollectBinItems(it);
        for (var k = 0; k < kids.length; k++) {
          if (kids[k].isFolder) continue;
          await push(await classify(kids[k].item, kids[k].parent || binName), kids[k].item);
        }
        continue;
      }
      var parent = '';
      try {
        var pb = typeof it.getParentBin === 'function' ? await un(it.getParentBin()) : null;
        if (pb) {
          var pid = await call(ppro.ProjectItem.cast(pb), 'getId');
          if (!rootId || pid !== rootId) parent = await sacGetItemName(pb);
        }
      } catch (e) {}
      await push(await classify(it, parent), it);
    }
    return { entries: entries, skipped: skipped };
  }

  // Mọi clip trong project → Map(fold(path) → [item]). Đọc TRƯỚC khi đổi tên (lúc
  // file còn online) để relink được cả clip trùng file nằm ngoài selection.
  async function indexProject(project, wanted) {
    var root = await un(project.getRootItem());
    var all = await sacCollectBinItems(root);
    var idx = {};
    for (var i = 0; i < all.length; i++) {
      if (all[i].isFolder) continue;
      var p = await mediaPathOf(all[i].item);
      if (!p || !wanted[fold(p)]) continue;
      (idx[fold(p)] = idx[fold(p)] || []).push(all[i].item);
    }
    return idx;
  }

  async function relinkItem(project, item, newPath) {
    var cp = castClip(item);
    if (!cp || typeof cp.changeMediaFilePath !== 'function') throw new Error('Premiere này không có changeMediaFilePath');
    var ok;
    try { ok = await un(cp.changeMediaFilePath(newPath, false)); }
    catch (e) {
      // Một số bản cần lock project — thử lại trong lockedAccess.
      var res = null, err = e;
      var r = project.lockedAccess(function () {
        try { res = cp.changeMediaFilePath(newPath, false); err = null; } catch (e2) { err = e2; }
      });
      if (r && typeof r.then === 'function') await r;
      if (err) throw err;
      ok = await un(res);
    }
    if (ok === false) throw new Error('Premiere từ chối relink');
    var now = await mediaPathOf(item);
    if (now && fold(now) !== fold(newPath)) throw new Error('Đọc lại vẫn là đường dẫn cũ');
  }

  // pairs [{from, to}] + idx → {ok:[pair], fail:[{pair, error}]}. Dòng hỏng thì các
  // item đã relink trong dòng đó được đưa về `from`.
  async function relinkPairs(project, pairs, idx) {
    var ok = [], fail = [];
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i], items = idx[fold(p.from)] || [], done = [];
      try {
        if (!items.length) throw new Error('Không tìm lại được clip trong project');
        for (var k = 0; k < items.length; k++) { await relinkItem(project, items[k], p.to); done.push(items[k]); }
        ok.push(p);
      } catch (e) {
        for (var d = 0; d < done.length; d++) { try { await relinkItem(project, done[d], p.from); } catch (e2) {} }
        fail.push({ pair: p, error: e.message || String(e) });
      }
    }
    return { ok: ok, fail: fail };
  }

  // Đổi tên hiển thị trong một transaction. onlyIf(nameHiện tại, pair) → có đổi không.
  // Action tạo BÊN TRONG callback transaction (cùng cách sacCommitTx ở main.js).
  async function renameItems(project, pairs, idx, onlyIf) {
    var todo = [];
    for (var i = 0; i < pairs.length; i++) {
      var items = idx[fold(pairs[i].from)] || [];
      for (var k = 0; k < items.length; k++) {
        var pi = ppro.ProjectItem.cast(items[k]);
        if (!pi || typeof pi.createSetNameAction !== 'function') continue;
        if (onlyIf && !onlyIf(await sacGetItemName(items[k]), pairs[i])) continue;
        todo.push({ pi: pi, name: baseName(pairs[i].to) });
      }
    }
    if (!todo.length) return 0;
    await commit(project, function (ca) {
      todo.forEach(function (t) { ca.addAction(t.pi.createSetNameAction(t.name)); });
    }, 'Đổi tên source');
    return todo.length;
  }

  // ── Bảng ────────────────────────────────────────────────────────────────
  function status(msg, cls) {
    var el = $('rnStatus');
    if (!el) return;
    el.hidden = !msg;
    el.textContent = msg || '';
    el.className = 'vgm-status' + (cls ? ' ' + cls : '');
  }

  function openModal() {
    rn.hidden = [];
    var activePanel = document.querySelector('.tab-panel.active');
    if (activePanel) { activePanel.style.display = 'none'; rn.hidden.push(activePanel); }
    $('rnModal').hidden = false;
  }
  function closeModal() {
    if (rn.busy) return;
    $('rnModal').hidden = true;
    rn.hidden.forEach(function (el) { el.style.display = ''; });
    rn.hidden = [];
    rn.rows = []; rn.skipped = []; rn.preview = []; rn.server = null; rn.aep = []; rn.done = false;
  }

  function currentTpl() { return prefs.mode === 'custom' ? $('rnTpl').value : MODE_TPL[prefs.mode]; }

  // Nút kiểu tên: sáng nút đang chọn, ví dụ lấy từ clip đầu tiên; ô mẫu chỉ hiện khi
  // "Tự đặt", ô Bắt đầu từ chỉ hiện khi có {n} (với {num} nó gần như không dùng tới).
  // Dòng được tick (bỏ tick = coi như không có trong lượt: giữ tên, không chiếm số).
  function active() { return rn.rows.filter(function (r) { return r.checked !== false; }); }

  // rn.preview chỉ gồm dòng được tick; rn.pidx[i] = vị trí của rn.rows[i] trong preview (-1 nếu bỏ tick).
  function computePreview() {
    var j = 0;
    rn.pidx = rn.rows.map(function (r) { return r.checked !== false ? j++ : -1; });
    rn.preview = RNC.buildPreview(active(), currentTpl(), startNum());
  }

  function renderModes() {
    var act = active();
    var ex = function (tpl) {
      var p = RNC.buildPreview(act.slice(0, 1), tpl, startNum())[0];
      return p ? p.newName : '';
    };
    // Ví dụ "Giữ số gốc" nên là dòng có số giữ được, không thì dòng đầu.
    var keepRow = null;
    for (var i = 0; i < act.length && !keepRow; i++) {
      if (RNC.keptNumber(RNC.splitExt(act[i].oldName).base, act[i].bin) !== null) keepRow = act[i];
    }
    var exNum = keepRow ? RNC.buildPreview([keepRow], MODE_TPL.num, startNum())[0].newName : ex(MODE_TPL.num);
    $('rnExNum').textContent = exNum ? (keepRow ? keepRow.oldName + ' → ' : '') + exNum : '';
    $('rnExN').textContent = act.length ? act[0].oldName + ' → ' + ex(MODE_TPL.n) : '';
    Array.prototype.forEach.call(document.querySelectorAll('.rn-mode'), function (b) {
      if (b.getAttribute('data-mode') === prefs.mode) b.classList.add('is-active'); else b.classList.remove('is-active');
    });
    $('rnCustom').style.display = prefs.mode === 'custom' ? '' : 'none';
    $('rnCustomToggle').textContent = prefs.mode === 'custom' ? 'Dùng kiểu có sẵn' : 'Tự đặt mẫu…';
    $('rnStartWrap').style.display = /\{n\}/.test(currentTpl()) ? '' : 'none';
  }

  function setMode(m) {
    if (rn.busy || rn.done) return;
    prefs.mode = m; savePrefs(prefs);
    refresh();
  }

  function startNum() { var n = parseInt($('rnStart').value, 10); return isNaN(n) || n < 0 ? 1 : n; }

  // Lỗi một dòng: ưu tiên kết quả bridge (biết đĩa) khi còn khớp tên mới.
  function rowError(i) {
    var p = rn.preview[i];
    var s = rn.server && rn.server.rows && rn.server.rows[i];
    if (s && s.newName === p.newName && s.error) return s.error;
    return p.error;
  }

  function counts() {
    var errs = 0, todo = 0;
    rn.preview.forEach(function (p, i) { if (rowError(i)) errs++; else if (!p.same) todo++; });
    return { errs: errs, todo: todo };
  }

  function renderGo() {
    var t = $('rnGoText'), go = $('rnGo');
    if (rn.done) { t.textContent = 'Đóng'; go.classList.remove('is-disabled'); return; }
    var c = counts();
    var fresh = rn.server && rn.server.seq === rn.planSeq;
    var ready = !rn.busy && fresh && !c.errs && c.todo > 0;
    t.textContent = rn.busy ? 'Đang chạy…' : (c.errs ? c.errs + ' dòng lỗi' : (c.todo ? 'Đổi tên ' + c.todo + ' clip' : 'Không có gì để đổi'));
    if (ready) go.classList.remove('is-disabled'); else go.classList.add('is-disabled');
  }

  function numTag(p) {
    if (p.numKind === 'keep') return p.numCopyOf ? 'bản copy của ' + p.numCopyOf + ' · giữ số' : 'giữ số gốc';
    if (p.numKind !== 'new') return '';
    if (p.numDupOf) return 'trùng số ' + p.numDupOf + ' · số mới';
    if (p.numCopyOf) return 'bản copy của ' + p.numCopyOf + ' (số đã có file giữ) · số mới';
    return 'số mới';
  }

  function renderList() {
    var host = $('rnList');
    host.innerHTML = '';
    rn.rows.forEach(function (r, i) {
      var pi = rn.pidx ? rn.pidx[i] : i;
      var p = pi >= 0 ? rn.preview[pi] : null;
      var err = p ? rowError(pi) : '';
      var row = document.createElement('div');
      row.className = 'rn-row' + (!p ? ' is-off' : (err ? ' is-err' : (p.same ? ' is-same' : '')));
      var box = document.createElement('input'); box.type = 'checkbox'; box.className = 'rn-chk';
      box.checked = !!p; box.disabled = rn.busy || rn.done;
      box.addEventListener('change', function () {
        if (rn.busy || rn.done) { box.checked = !!p; return; }
        r.checked = box.checked;
        refresh();
      });
      row.appendChild(box);
      var mv = document.createElement('div'); mv.className = 'rn-move';
      [['↑', -1], ['↓', 1]].forEach(function (b) {
        var bt = document.createElement('div');
        bt.className = 'rn-mv'; bt.setAttribute('role', 'button'); bt.textContent = b[0];
        bt.addEventListener('click', function () {
          if (rn.busy || rn.done) return;
          rn.rows = RNC.moveRow(rn.rows, i, b[1]);
          refresh();
        });
        mv.appendChild(bt);
      });
      row.appendChild(mv);
      var txt = document.createElement('div'); txt.className = 'rn-txt';
      var names = document.createElement('div'); names.className = 'rn-names';
      var o = document.createElement('span'); o.className = 'rn-old'; o.textContent = r.oldName;
      var a = document.createElement('span'); a.className = 'rn-arrow'; a.textContent = '→';
      var n = document.createElement('span'); n.className = 'rn-new';
      n.textContent = !p ? '(bỏ chọn — giữ nguyên)' : (p.same ? '(giữ nguyên)' : p.newName);
      names.appendChild(o); names.appendChild(a); names.appendChild(n);
      txt.appendChild(names);
      var cnt = r.items.length;
      var tag = p ? numTag(p) : '';
      if (p && (err || cnt > 1 || tag)) {
        var sub = document.createElement('div'); sub.className = 'rn-sub' + (!err && p.numKind === 'new' ? ' is-new' : '');
        sub.textContent = err || [tag, cnt > 1 ? cnt + ' clip trong project dùng file này' : '']
          .filter(Boolean).join(' · ');
        txt.appendChild(sub);
      }
      row.appendChild(txt);
      host.appendChild(row);
    });
    rn.skipped.forEach(function (s) {
      var row = document.createElement('div'); row.className = 'rn-row is-skip';
      var txt = document.createElement('div'); txt.className = 'rn-txt';
      txt.textContent = s.name + ' — bỏ qua: ' + s.reason;
      row.appendChild(txt);
      host.appendChild(row);
    });
    var c = counts();
    var on = rn.preview.length;
    $('rnDropErr').style.display = c.errs && !rn.busy && !rn.done ? '' : 'none';
    $('rnAll').textContent = on === rn.rows.length ? 'Bỏ chọn hết' : 'Chọn hết';
    $('rnSummary').textContent = (on === rn.rows.length ? rn.rows.length + ' file' : on + '/' + rn.rows.length + ' file được chọn')
      + (rn.skipped.length ? ' · bỏ qua ' + rn.skipped.length : '')
      + (c.errs ? ' · ' + c.errs + ' lỗi' : '') + ' · số thứ tự theo thứ tự dưới đây, bấm ↑↓ để đổi';
    renderGo();
  }

  function renderAep() {
    var host = $('rnAepList');
    host.innerHTML = '';
    var warn = $('rnAeWarn');
    warn.hidden = !rn.aeRunning;
    warn.textContent = rn.aeRunning ? 'After Effects đang mở — đóng AE rồi bấm Quét lại. AE giữ project trong bộ nhớ, Save sẽ ghi đè phần relink.' : '';
    if (rn.aepScanning) { host.textContent = 'Đang quét file .aep trong thư mục sản phẩm…'; host.className = 'rn-aep-empty'; return; }
    host.className = '';
    if (!rn.aep.length) {
      host.textContent = rn.aepNote || 'Không có file .aep nào dùng các file này.';
      host.className = 'rn-aep-empty';
      return;
    }
    rn.aep.forEach(function (a) {
      var row = document.createElement('label'); row.className = 'rn-aep-row' + (rn.aeRunning ? ' is-locked' : '');
      var box = document.createElement('input'); box.type = 'checkbox';
      box.checked = a.checked && !rn.aeRunning; box.disabled = rn.aeRunning || rn.busy || rn.done;
      box.addEventListener('change', function () { a.checked = box.checked; });
      row.appendChild(box);
      var t = document.createElement('span');
      t.textContent = a.name + ' — ' + a.count + ' footage';
      row.appendChild(t);
      host.appendChild(row);
    });
    if (rn.aepNote) {
      var n = document.createElement('div'); n.className = 'rn-aep-empty'; n.textContent = rn.aepNote;
      host.appendChild(n);
    }
  }

  function refresh() {
    computePreview();
    renderModes();
    renderList();
    schedulePlan(false);
  }

  function planBody(scanAep) {
    return {
      projectPath: rn.projectPath, scanAep: scanAep,
      rows: rn.preview.map(function (p) { return { oldPath: p.path, newName: p.newName }; }),
    };
  }

  function schedulePlan(scanAep) {
    clearTimeout(rn.planTimer);
    var seq = ++rn.planSeq;
    renderGo();
    rn.planTimer = setTimeout(function () { runPlan(seq, scanAep); }, scanAep ? 0 : 250);
  }

  async function runPlan(seq, scanAep) {
    if (scanAep) { rn.aepScanning = true; renderAep(); }
    var r = await api('POST', '/rename/plan', planBody(scanAep));
    if (scanAep) rn.aepScanning = false;
    if (seq !== rn.planSeq && !scanAep) return;           // đã có lượt mới hơn
    if (!r.ok) { status('✗ ' + (r.error || 'Bridge lỗi'), 'is-err'); renderAep(); renderGo(); return; }
    rn.aeRunning = !!r.aeRunning;
    if (r.aep) {
      var prev = {};
      rn.aep.forEach(function (a) { prev[a.path] = a.checked; });
      rn.aep = r.aep.map(function (a) { return { path: a.path, name: a.name, count: a.count, checked: prev[a.path] !== false }; });
      rn.aepNote = r.aepTimedOut ? 'Quét .aep quá 30 giây nên dừng giữa chừng — có thể còn sót file.' : '';
    }
    if (seq === rn.planSeq) {
      rn.server = { seq: seq, rows: r.rows };
      renderList();
    }
    renderAep();
    renderGo();
  }

  async function pick() {
    if (rn.busy) return;
    wire();
    var proj = await getActiveProject();
    if (!proj) { lastLine('✗ Không có project đang mở', true); return; }
    rn.projectPath = await currentProjectPath();
    if (!rn.projectPath) { lastLine('✗ Project chưa lưu — lưu .prproj trước', true); return; }
    var btn = $('rnPick');
    btn.textContent = 'Đang đọc selection…';
    var got;
    try { got = await readSelection(proj); }
    catch (e) { btn.textContent = 'Lấy clip đang chọn'; lastLine('✗ ' + e.message, true); return; }
    btn.textContent = 'Lấy clip đang chọn';
    rn.rows = RNC.sortRows(RNC.groupByPath(got.entries));
    rn.skipped = got.skipped;
    if (!rn.rows.length) {
      lastLine(got.skipped.length ? '✗ Không có clip đổi tên được (' + got.skipped.length + ' bỏ qua: ' + got.skipped[0].reason + '…)'
        : '✗ Chưa chọn clip hoặc bin nào ở Project panel', true);
      return;
    }
    rn.done = false; rn.server = null; rn.aep = []; rn.aepNote = '';
    $('rnTpl').value = prefs.tpl;
    $('rnStart').value = '1';
    status('', '');
    openModal();
    computePreview();
    renderModes();
    renderList();
    renderAep();
    schedulePlan(true);
  }

  async function run() {
    if (rn.done) { closeModal(); return; }
    if ($('rnGo').classList.contains('is-disabled') || rn.busy) return;
    var proj = await getActiveProject();
    if (!proj) { status('✗ Không có project đang mở', 'is-err'); return; }
    if (prefs.mode === 'custom') { prefs.tpl = $('rnTpl').value; savePrefs(prefs); }

    rn.busy = true; renderGo(); renderAep();
    try {
      var todo = rn.preview.filter(function (p) { return !p.same; });
      var wanted = {};
      todo.forEach(function (p) { wanted[fold(p.path)] = true; });
      status('⏳ Đọc clip trong project…', '');
      var idx = await indexProject(proj, wanted);

      status('⏳ Đổi tên ' + todo.length + ' file trên đĩa…', '');
      var aepPaths = rn.aeRunning ? [] : rn.aep.filter(function (a) { return a.checked; }).map(function (a) { return a.path; });
      var ap = await api('POST', '/rename/apply', {
        projectPath: rn.projectPath, aep: aepPaths,
        rows: rn.preview.map(function (p) { return { oldPath: p.path, newName: p.newName }; }),
      });
      if (!ap.ok) { status('✗ ' + ap.error + ' — chưa đổi file nào', 'is-err'); return; }
      if (!ap.batchId) { status('Không có file nào cần đổi tên.', ''); return; }

      status('⏳ Relink ' + ap.rows.length + ' file trong Premiere…', '');
      var pairs = ap.rows.map(function (r) { return { from: r.oldPath, to: r.newPath }; });
      var rl = await relinkPairs(proj, pairs, idx);
      if (rl.fail.length) {
        await api('POST', '/rename/revert', { projectPath: rn.projectPath, batchId: ap.batchId,
          oldPaths: rl.fail.map(function (f) { return f.pair.from; }) });
        rl.fail.forEach(function (f) { log('✗ Relink ' + baseName(f.pair.from) + ' — ' + f.error + ' (đã đổi tên file về)', true); });
      }
      var named = 0, nameErr = '';
      try { named = await renameItems(proj, rl.ok, idx, null); }
      catch (e) { nameErr = e.message || String(e); log('✗ Đổi tên hiển thị — ' + nameErr, true); }

      var aepMsg = rn.aeRunning && rn.aep.length ? ' · AE: bỏ qua vì After Effects đang mở' : '';
      if (aepPaths.length && rl.ok.length) {
        status('⏳ Relink ' + aepPaths.length + ' file After Effects…', '');
        var ae = await api('POST', '/rename/aep', { projectPath: rn.projectPath, batchId: ap.batchId });
        if (!ae.ok) aepMsg = ' · AE: ✗ ' + ae.error;
        else {
          var aeOk = ae.files.filter(function (f) { return f.ok; });
          var aeBad = ae.files.filter(function (f) { return !f.ok; });
          aepMsg = ' · AE: ' + aeOk.length + ' file' + (aeBad.length ? ', ✗ ' + aeBad.map(function (f) { return f.name + ' (' + f.error + ')'; }).join('; ') : '');
          aeOk.forEach(function (f) { log('AE ' + f.name + ': relink ' + f.replaced + ' footage'); });
          aeBad.forEach(function (f) { log('✗ AE ' + f.name + ' — ' + f.error, true); });
        }
      }

      var msg = (rl.fail.length ? '⚠ ' : '✓ ') + 'Đã đổi tên ' + rl.ok.length + '/' + pairs.length + ' file, relink '
        + rl.ok.reduce(function (n, p) { return n + (idx[fold(p.from)] || []).length; }, 0) + ' clip'
        + (rl.fail.length ? ' · ' + rl.fail.length + ' file relink lỗi đã đổi tên về' : '')
        + (nameErr ? ' · tên hiển thị chưa đổi (' + nameErr + ')' : '') + aepMsg;
      status(msg, rl.fail.length || nameErr ? 'is-warn' : 'is-ok');
      log('Đổi tên source: ' + msg.replace(/^[✓⚠] /, ''));
      rn.done = true;
    } catch (e) {
      status('✗ ' + (e.message || e), 'is-err');
      log('✗ Đổi tên source — ' + (e.message || e), true);
    } finally {
      rn.busy = false;
      renderGo(); renderAep();
      loadJournal();
    }
  }

  // ── Hoàn tác ────────────────────────────────────────────────────────────
  function lastLine(text, isErr) {
    var el = $('rnLast');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'rn-last' + (isErr ? ' is-err' : '');
  }

  function fmtTime(t) {
    var d = new Date(t);
    function p2(n) { return String(n).padStart(2, '0'); }
    return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ' ' + p2(d.getDate()) + '/' + p2(d.getMonth() + 1);
  }

  async function loadJournal() {
    var p = await currentProjectPath();
    rn.projectPath = p || rn.projectPath;
    var undo = $('rnUndo');
    if (!p) { rn.journal = null; undo.style.display = 'none'; return; }
    var r = await api('GET', '/rename/journal?projectPath=' + encodeURIComponent(p));
    rn.journal = r.ok ? r.batch : null;
    rn.undoArmed = 0;
    undo.textContent = 'Hoàn tác lượt vừa rồi';
    if (rn.journal && rn.journal.rows && rn.journal.rows.length) {
      undo.style.display = '';
      lastLine('Lượt gần nhất: ' + rn.journal.rows.length + ' file · ' + fmtTime(rn.journal.time)
        + (rn.journal.aep && rn.journal.aep.length ? ' · ' + rn.journal.aep.length + ' file AE' : ''));
    } else {
      undo.style.display = 'none';
      if (r.offline) lastLine('Bridge chưa chạy', true);
    }
  }

  async function undo() {
    if (rn.busy || !rn.journal) return;
    // Bấm 2 lần cho chắc (cùng kiểu "Ghi đè?" của Voice Gen).
    if (!rn.undoArmed || Date.now() - rn.undoArmed > 4000) {
      rn.undoArmed = Date.now();
      $('rnUndo').textContent = 'Bấm lần nữa để hoàn tác ' + rn.journal.rows.length + ' file';
      return;
    }
    rn.undoArmed = 0;
    var proj = await getActiveProject();
    if (!proj) { lastLine('✗ Không có project đang mở', true); return; }
    if ((await currentProjectPath()) !== rn.journal.projectPath) {
      await loadJournal();
      lastLine('Project đang mở đã đổi — nạp lại lượt đổi tên của project này', true);
      return;
    }
    rn.busy = true;
    $('rnUndo').textContent = 'Đang hoàn tác…';
    try {
      var j = rn.journal;
      var wanted = {};
      j.rows.forEach(function (r) { wanted[fold(r.newPath)] = true; });
      var idx = await indexProject(proj, wanted);
      var r = await api('POST', '/rename/undo', { projectPath: j.projectPath, batchId: j.batchId });
      if (!r.ok) { lastLine('✗ ' + r.error, true); return; }
      var pairs = r.rows.map(function (x) { return { from: x.newPath, to: x.oldPath }; });
      var rl = await relinkPairs(proj, pairs, idx);
      try {
        await renameItems(proj, rl.ok, idx, function (cur, p) { return fold(cur) === fold(baseName(p.from)); });
      } catch (e) { log('✗ Hoàn tác tên hiển thị — ' + (e.message || e), true); }
      rl.fail.forEach(function (f) { log('✗ Hoàn tác relink ' + baseName(f.pair.to) + ' — ' + f.error + ' (file đã về tên cũ, relink tay trong Premiere)', true); });
      (r.skipped || []).forEach(function (s) { log('✗ Hoàn tác bỏ qua ' + baseName(s.newPath) + ' — ' + s.reason, true); });
      (r.aep || []).forEach(function (a) { log((a.ok ? 'AE ' : '✗ AE ') + a.name + (a.ok ? ': đổi về ' + a.replaced + ' footage' : ' — ' + a.error), !a.ok); });
      var msg = 'Đã hoàn tác ' + rl.ok.length + ' file' + (r.skipped && r.skipped.length ? ', bỏ qua ' + r.skipped.length : '')
        + (rl.fail.length ? ', ' + rl.fail.length + ' relink lỗi' : '');
      log('Đổi tên source: ' + msg);
      await loadJournal();
      lastLine((rl.fail.length || (r.skipped && r.skipped.length) ? '⚠ ' : '✓ ') + msg, !!rl.fail.length);
    } catch (e) {
      lastLine('✗ ' + (e.message || e), true);
    } finally {
      rn.busy = false;
      if ($('rnUndo').textContent === 'Đang hoàn tác…') $('rnUndo').textContent = 'Hoàn tác lượt vừa rồi';
    }
  }

  // ── Nối dây ─────────────────────────────────────────────────────────────
  function bindKeyboard(input) {
    input.addEventListener('focus', function () { if (window.claimKeyboard) window.claimKeyboard(); });
    input.addEventListener('blur', function () { if (window.releaseKeyboard) window.releaseKeyboard(); });
  }

  function setOpen(open) {
    prefs.open = open; savePrefs(prefs);
    $('rnBody').style.display = open ? '' : 'none';
    $('rnCaret').textContent = open ? '▾' : '▸';
    if (open) loadJournal();
  }

  function wire() {
    if (rn.wired) return;
    rn.wired = true;
    $('rnClose').addEventListener('click', closeModal);
    $('rnGo').addEventListener('click', run);
    $('rnRescan').addEventListener('click', function () { if (!rn.busy && !rn.done) schedulePlan(true); });
    $('rnDropErr').addEventListener('click', function () {
      if (rn.busy || rn.done) return;
      rn.rows.forEach(function (r, i) { var pi = rn.pidx[i]; if (pi >= 0 && rowError(pi)) r.checked = false; });
      refresh();
    });
    $('rnAll').addEventListener('click', function () {
      if (rn.busy || rn.done) return;
      var on = rn.preview.length !== rn.rows.length;
      rn.rows.forEach(function (r) { r.checked = on; });
      refresh();
    });
    $('rnSort').addEventListener('click', function () { if (!rn.busy && !rn.done) { rn.rows = RNC.sortRows(rn.rows); refresh(); } });
    ['rnTpl', 'rnStart'].forEach(function (id) {
      var el = $(id);
      bindKeyboard(el);
      el.addEventListener('input', function () { if (!rn.busy && !rn.done) refresh(); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.rn-mode'), function (b) {
      b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); });
    });
    $('rnCustomToggle').addEventListener('click', function () {
      if (prefs.mode !== 'custom' && !$('rnTpl').value) $('rnTpl').value = prefs.tpl;
      setMode(prefs.mode === 'custom' ? 'num' : 'custom');
    });
    document.querySelectorAll('.rn-tok').forEach(function (t) {
      t.addEventListener('click', function () {
        if (rn.busy || rn.done) return;
        $('rnTpl').value = $('rnTpl').value + t.getAttribute('data-tok');
        refresh();
      });
    });
  }

  function init() {
    if (!$('rnHead')) return;
    $('rnHead').addEventListener('click', function () { setOpen($('rnBody').style.display === 'none'); });
    $('rnPick').addEventListener('click', pick);
    $('rnUndo').addEventListener('click', undo);
    setOpen(prefs.open);
    // Mở tab Watch → cập nhật nút hoàn tác (project có thể đã đổi).
    var tabBtn = document.querySelector('.tab-btn[data-tab="watch"]');
    if (tabBtn) tabBtn.addEventListener('click', function () { if (prefs.open) loadJournal(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Để gỡ lỗi từ console UXP.
  // debugOpen(entries): mở bảng với entries [{path, bin, item, name}] như khi lấy selection.
  window.rnInternals = {
    state: rn, readSelection: readSelection, indexProject: indexProject, loadJournal: loadJournal,
    close: closeModal,
    debugOpen: async function (entries) {
      wire();
      rn.projectPath = await currentProjectPath();
      rn.rows = RNC.sortRows(RNC.groupByPath(entries)); rn.skipped = [];
      rn.done = false; rn.server = null; rn.aep = []; rn.aepNote = '';
      $('rnTpl').value = prefs.tpl; $('rnStart').value = '1';
      openModal(); refresh(); schedulePlan(true);
    },
    setMode: setMode,
  };
})();
