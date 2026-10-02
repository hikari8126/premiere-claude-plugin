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
    return { mode: mode, tpl: typeof s.tpl === 'string' && s.tpl ? s.tpl : '{bin}_{num}', open: !!s.open,
      withExternal: s.withExternal !== false, moveBins: s.moveBins !== false };
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

  // Mọi đường dẫn media trong project (fold) — để biết file nào trong thư mục chưa import.
  // Mọi đường dẫn media trong project → {fold(path): đường dẫn bin chứa clip đầu tiên}.
  async function projectPaths(project) {
    var root = await un(project.getRootItem());
    var all = await sacCollectBinItems(root);
    var out = {};
    for (var i = 0; i < all.length; i++) {
      if (all[i].isFolder) continue;
      var p = await mediaPathOf(all[i].item);
      if (p && !(fold(p) in out)) out[fold(p)] = all[i].path || '';
    }
    return out;
  }

  // Thêm MỌI file media cùng thư mục với source mà chưa nằm trong lựa chọn (bridge liệt kê):
  // chưa import (extra + external: chỉ đổi tên trên đĩa) hoặc đã import ở bin khác (extra +
  // otherBin: vẫn relink + đổi tên hiển thị). {bin} theo dòng đầu tiên của thư mục đó.
  async function addSiblings(project) {
    var binOfDir = {}, dirs = [];
    rn.rows.forEach(function (r) {
      var d = r.path.slice(0, r.path.lastIndexOf('/'));
      if (!(d in binOfDir)) { binOfDir[d] = r.bin; dirs.push(d); }
    });
    var inProj = await projectPaths(project);
    rn.binOfDir = binOfDir; rn.dirNames = {}; rn.binObjOfDir = {};
    // Bin thật (object) của từng thư mục = bin chứa clip đầu tiên trong lựa chọn — đích khi
    // "Chuyển clip ở bin khác về bin …". Lấy theo object, không theo tên (tên bin có thể trùng).
    for (var i = 0; i < rn.rows.length; i++) {
      var row = rn.rows[i], d = row.path.slice(0, row.path.lastIndexOf('/'));
      if (rn.binObjOfDir[d] || !row.items.length) continue;
      try {
        var pb = typeof row.items[0].getParentBin === 'function' ? await un(row.items[0].getParentBin()) : null;
        if (pb) rn.binObjOfDir[d] = { bin: pb, id: await call(ppro.ProjectItem.cast(pb), 'getId') };
      } catch (e) {}
    }
    var r = await api('POST', '/rename/siblings', { dirs: dirs, known: rn.rows.map(function (x) { return x.path; }) });
    if (!r.ok) { rn.siblingNote = 'Không quét được thư mục: ' + r.error; return 0; }
    rn.dirNames = r.names || {};
    (r.files || []).forEach(function (f) {
      var bin = inProj[fold(f.path)];
      rn.rows.push({ path: f.path, oldName: baseName(f.path), bin: binOfDir[f.dir] || '', items: [],
        extra: true, external: bin == null, otherBin: bin == null ? null : bin, checked: prefs.withExternal });
    });
    rn.rows = RNC.sortRows(rn.rows);
    return (r.files || []).length;
  }

  function dirOf(p) { return String(p).slice(0, String(p).lastIndexOf('/')); }
  function binLabel(b) { return b ? b : '(gốc project)'; }

  // Dòng "ở bin khác" sẽ được chuyển về bin của thư mục (ô tick chung, bật sẵn).
  function willMove(r) {
    return prefs.moveBins && r.otherBin != null && r.checked !== false && !!(rn.binObjOfDir || {})[dirOf(r.path)];
  }

  // Chuyển clip trong một transaction. todo [{item, target(FolderItem đã cast)}].
  async function moveItems(project, todo) {
    if (!todo.length) return 0;
    await commit(project, function (ca) {
      todo.forEach(function (t) { ca.addAction(t.target.createMoveItemAction(t.item, t.target)); });
    }, 'Chuyển clip về bin');
    return todo.length;
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
  // external: Set(fold(path)) của file chưa import — không có clip thì không cần relink.
  // onProgress(i, total, tên file) trước mỗi file.
  async function relinkPairs(project, pairs, idx, external, onProgress) {
    var ok = [], fail = [];
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i], items = idx[fold(p.from)] || [], done = [];
      if (onProgress) { try { onProgress(i, pairs.length, baseName(p.to)); } catch (e0) {} }
      try {
        if (!items.length) {
          if (external === true || (external && external[fold(p.from)])) { ok.push(p); continue; }
          throw new Error('Không tìm lại được clip trong project');
        }
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
    rn.preview = RNC.buildPreview(active(), currentTpl(), startNum(), { occupied: occupiedNums() });
  }

  // Số đã có file khác giữ trong thư mục trên đĩa (file ngoài lượt hoặc bị bỏ tick vẫn
  // nằm đó với tên của nó) → {bin → [số]}. Thiếu cái này thì số mới đè lên Senyue_51…
  // đã đổi ở lượt trước (bridge báo "Đã có file trùng tên").
  function occupiedNums() {
    var mine = {}, out = {};
    active().forEach(function (r) { mine[fold(r.path)] = true; });
    Object.keys(rn.dirNames || {}).forEach(function (dir) {
      var bin = (rn.binOfDir || {})[dir] || '', g = fold(bin);
      (rn.dirNames[dir] || []).forEach(function (name) {
        if (mine[fold(dir + '/' + name)]) return;
        var ni = RNC.numberInfo(RNC.splitExt(name).base, bin);
        if (ni.num !== null && !ni.copy) (out[g] = out[g] || []).push(parseInt(ni.num, 10));
      });
    });
    return out;
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
  // Khớp theo đường dẫn (không theo vị trí — bỏ tick làm lệch vị trí trước khi bridge trả lời).
  function rowError(i) {
    var p = rn.preview[i];
    var s = rn.server && rn.server.byPath && rn.server.byPath[fold(p.path)];
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
    t.textContent = rn.busy ? 'Đang chạy…' : (c.errs ? c.errs + ' dòng lỗi' : (c.todo ? 'Đổi tên ' + c.todo + ' file' : 'Không có gì để đổi'));
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
      var where = r.external ? 'chưa import vào project'
        : (r.otherBin != null ? binLabel(r.otherBin) + (willMove(r) ? ' → chuyển về bin ' + (r.bin || '(gốc project)') : ' (ở bin khác)') : '');
      var tag = p ? [numTag(p), where].filter(Boolean).join(' · ') : '';
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
    var ext = rn.rows.filter(function (r) { return r.extra; });
    var nNew = ext.filter(function (r) { return r.external; }).length, nOther = ext.length - nNew;
    $('rnExtWrap').style.display = ext.length || rn.siblingNote ? '' : 'none';
    $('rnExt').checked = ext.some(function (r) { return r.checked !== false; });
    $('rnExt').disabled = !ext.length || rn.busy || rn.done;
    $('rnExtText').textContent = rn.siblingNote || ('Đổi tên cả ' + ext.length + ' file khác cùng thư mục với source ('
      + [nNew ? nNew + ' chưa import' : '', nOther ? nOther + ' ở bin khác' : ''].filter(Boolean).join(', ') + ')');
    var movable = rn.rows.filter(function (r) { return r.otherBin != null && r.checked !== false && (rn.binObjOfDir || {})[dirOf(r.path)]; });
    var tgtBins = {};
    movable.forEach(function (r) { tgtBins[r.bin || '(gốc project)'] = true; });
    $('rnMoveWrap').style.display = movable.length ? '' : 'none';
    $('rnMove').checked = prefs.moveBins;
    $('rnMove').disabled = rn.busy || rn.done;
    $('rnMoveText').textContent = 'Chuyển ' + movable.length + ' clip ở bin khác về bin '
      + (Object.keys(tgtBins).length === 1 ? Object.keys(tgtBins)[0] : 'của thư mục');
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
      var byPath = {};
      (r.rows || []).forEach(function (x) { byPath[fold(x.oldPath)] = x; });
      rn.server = { seq: seq, rows: r.rows, byPath: byPath };
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
    rn.rows = RNC.sortRows(RNC.groupByPath(got.entries));
    rn.skipped = got.skipped;
    if (!rn.rows.length) {
      btn.textContent = 'Lấy clip đang chọn';
      lastLine(got.skipped.length ? '✗ Không có clip đổi tên được (' + got.skipped.length + ' bỏ qua: ' + got.skipped[0].reason + '…)'
        : '✗ Chưa chọn clip hoặc bin nào ở Project panel', true);
      return;
    }
    btn.textContent = 'Đang quét thư mục chứa source…';
    rn.siblingNote = ''; rn.dirNames = {}; rn.binOfDir = {}; rn.binObjOfDir = {};
    try { await addSiblings(proj); } catch (e) { rn.siblingNote = 'Không quét được thư mục: ' + (e.message || e); }
    btn.textContent = 'Lấy clip đang chọn';
    rn.done = false; rn.server = null; rn.aep = []; rn.aepNote = '';
    $('rnTpl').value = prefs.tpl;
    $('rnStart').value = '1';
    status('', '');
    progHide();
    openModal();
    computePreview();
    renderModes();
    renderList();
    renderAep();
    schedulePlan(true);
  }

  // ── Tiến trình ──────────────────────────────────────────────────────────
  // Thanh chung cho cả lượt: mỗi bước một phần (relink trong Premiere lâu nhất vì
  // Premiere đọc lại từng file — trên Google Drive mất cả giây mỗi file).
  var STEPS = [['Đọc clip trong project', 5], ['Đổi tên file trên đĩa', 15], ['Relink trong Premiere', 65],
               ['Đổi tên trong Project panel', 5], ['Relink After Effects', 10]];
  function prog(step, frac, detail) {
    var before = 0, total = 0;
    STEPS.forEach(function (st, i) { total += st[1]; if (i < step) before += st[1]; });
    var pct = Math.max(0, Math.min(100, Math.round((before + STEPS[step][1] * Math.max(0, Math.min(1, frac))) * 100 / total)));
    $('rnProg').style.display = '';
    $('rnProgBar').style.width = pct + '%';
    $('rnProgPct').textContent = pct + '%';
    $('rnProgText').textContent = 'Bước ' + (step + 1) + '/' + STEPS.length + ' · ' + STEPS[step][0] + (detail ? ' · ' + detail : '');
  }
  function progHide() { $('rnProg').style.display = 'none'; }
  function fmtLeft(ms) {
    var sec = Math.round(ms / 1000);
    return sec < 60 ? 'còn ~' + Math.max(1, sec) + ' giây' : 'còn ~' + Math.round(sec / 60) + ' phút';
  }
  // onProgress cho relinkPairs: "12/53 · Senyue_12.MOV · còn ~40 giây".
  function relinkTicker(show) {
    var t0 = Date.now();
    return function (i, total, name) {
      var left = i > 0 ? ' · ' + fmtLeft((Date.now() - t0) / i * (total - i)) : '';
      show(i / total, (i + 1) + '/' + total + ' · ' + name + left);
    };
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
      var movers = rn.rows.filter(willMove);
      movers.forEach(function (r) { wanted[fold(r.path)] = true; });
      status('', '');
      prog(0, 0);
      var idx = await indexProject(proj, wanted);
      var external = {};
      rn.rows.forEach(function (r) { if (r.external) external[fold(r.path)] = true; });

      prog(1, 0, todo.length + ' file');
      var aepPaths = rn.aeRunning ? [] : rn.aep.filter(function (a) { return a.checked; }).map(function (a) { return a.path; });
      var ap = await api('POST', '/rename/apply', {
        projectPath: rn.projectPath, aep: aepPaths,
        rows: rn.preview.map(function (p) { return { oldPath: p.path, newName: p.newName }; }),
      });
      if (!ap.ok) { progHide(); status('✗ ' + ap.error + ' — chưa đổi file nào', 'is-err'); return; }
      if (!ap.batchId) { progHide(); status('Không có file nào cần đổi tên.', ''); return; }

      var pairs = ap.rows.map(function (r) { return { from: r.oldPath, to: r.newPath }; });
      var rl = await relinkPairs(proj, pairs, idx, external, relinkTicker(function (f, d) { prog(2, f, d); }));
      if (rl.fail.length) {
        await api('POST', '/rename/revert', { projectPath: rn.projectPath, batchId: ap.batchId,
          oldPaths: rl.fail.map(function (f) { return f.pair.from; }) });
        rl.fail.forEach(function (f) { log('✗ Relink ' + baseName(f.pair.from) + ' — ' + f.error + ' (đã đổi tên file về)', true); });
      }
      var named = 0, nameErr = '';
      prog(3, 0);
      try { named = await renameItems(proj, rl.ok, idx, null); }
      catch (e) { nameErr = e.message || String(e); log('✗ Đổi tên hiển thị — ' + nameErr, true); }

      // Chuyển clip ở bin khác về bin của thư mục (bỏ qua dòng relink lỗi — đã đổi tên về).
      var moved = 0, moveErr = '', failed = {}, finalOf = {};
      rl.fail.forEach(function (f) { failed[fold(f.pair.from)] = true; });
      pairs.forEach(function (p) { finalOf[fold(p.from)] = p.to; });
      var mv = [], notes = [];
      for (var mi = 0; mi < movers.length; mi++) {
        var r0 = movers[mi], k0 = fold(r0.path);
        if (failed[k0]) continue;
        var tb = rn.binObjOfDir[dirOf(r0.path)], target = ppro.FolderItem.cast(tb.bin);
        if (!target || typeof target.createMoveItemAction !== 'function') continue;
        var its = idx[k0] || [];
        for (var q = 0; q < its.length; q++) {
          var cur = typeof its[q].getParentBin === 'function' ? await un(its[q].getParentBin()) : null;
          if (cur && tb.id && (await call(ppro.ProjectItem.cast(cur), 'getId')) === tb.id) continue;
          mv.push({ item: its[q], target: target });
        }
        if (its.length) notes.push({ path: finalOf[k0] || r0.path, fromBin: r0.otherBin });
      }
      if (mv.length) {
        prog(3, 0.5, 'chuyển ' + mv.length + ' clip về bin');
        try {
          moved = await moveItems(proj, mv);
          await api('POST', '/rename/note', { projectPath: rn.projectPath, batchId: ap.batchId, moves: notes });
        } catch (e) { moveErr = e.message || String(e); log('✗ Chuyển bin — ' + moveErr, true); }
      }

      var aepMsg = rn.aeRunning && rn.aep.length ? ' · AE: bỏ qua vì After Effects đang mở' : '';
      if (aepPaths.length && rl.ok.length) {
        prog(4, 0, aepPaths.length + ' file .aep');
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

      prog(4, 1);
      var nExt = rl.ok.filter(function (p) { return external[fold(p.from)] && !(idx[fold(p.from)] || []).length; }).length;
      var msg = (rl.fail.length ? '⚠ ' : '✓ ') + 'Đã đổi tên ' + rl.ok.length + '/' + pairs.length + ' file'
        + (nExt ? ' (' + nExt + ' file chưa import)' : '') + ', relink '
        + rl.ok.reduce(function (n, p) { return n + (idx[fold(p.from)] || []).length; }, 0) + ' clip'
        + (rl.fail.length ? ' · ' + rl.fail.length + ' file relink lỗi đã đổi tên về' : '')
        + (nameErr ? ' · tên hiển thị chưa đổi (' + nameErr + ')' : '')
        + (moved ? ' · chuyển ' + moved + ' clip về bin' : '') + (moveErr ? ' · chưa chuyển bin được (' + moveErr + ')' : '') + aepMsg;
      status(msg, rl.fail.length || nameErr ? 'is-warn' : 'is-ok');
      log('Đổi tên source: ' + msg.replace(/^[✓⚠] /, ''));
      rn.done = true;
    } catch (e) {
      progHide();
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
      (j.moves || []).forEach(function (m) { wanted[fold(m.path)] = true; });
      var idx = await indexProject(proj, wanted);
      var r = await api('POST', '/rename/undo', { projectPath: j.projectPath, batchId: j.batchId });
      if (!r.ok) { lastLine('✗ ' + r.error, true); return; }
      var pairs = r.rows.map(function (x) { return { from: x.newPath, to: x.oldPath }; });
      var rl = await relinkPairs(proj, pairs, idx, true, relinkTicker(function (f, d) {
        lastLine('⏳ Hoàn tác ' + Math.round(f * 100) + '% · relink ' + d);
      }));
      try {
        await renameItems(proj, rl.ok, idx, function (cur, p) { return fold(cur) === fold(baseName(p.from)); });
      } catch (e) { log('✗ Hoàn tác tên hiển thị — ' + (e.message || e), true); }
      // Chuyển clip về lại bin cũ (ppGetOrCreateBin hiểu đường dẫn "A / B / C").
      var back = 0;
      for (var mi = 0; mi < (r.moves || []).length; mi++) {
        var m = r.moves[mi], its = idx[fold(m.path)] || [];
        for (var q = 0; q < its.length; q++) {
          try {
            if (!m.fromBin) {
              var rt = ppro.FolderItem.cast(await un(proj.getRootItem()));
              await moveItems(proj, [{ item: its[q], target: rt }]);
            } else {
              var mr = await ppMoveToBin(its[q], proj, m.fromBin);
              if (!mr.ok) throw new Error(mr.error);
            }
            back++;
          } catch (e) { log('✗ Hoàn tác chuyển bin ' + baseName(m.path) + ' — ' + (e.message || e), true); }
        }
      }
      if (back) log('Hoàn tác: chuyển ' + back + ' clip về bin cũ');
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
    $('rnMove').addEventListener('change', function () {
      if (rn.busy || rn.done) return;
      prefs.moveBins = $('rnMove').checked; savePrefs(prefs);
      renderList();
    });
    $('rnExt').addEventListener('change', function () {
      if (rn.busy || rn.done) return;
      prefs.withExternal = $('rnExt').checked; savePrefs(prefs);
      rn.rows.forEach(function (r) { if (r.extra) r.checked = prefs.withExternal; });
      refresh();
    });
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
    debugOpen: async function (entries, withSiblings) {
      wire();
      rn.projectPath = await currentProjectPath();
      rn.rows = RNC.sortRows(RNC.groupByPath(entries)); rn.skipped = []; rn.siblingNote = ''; rn.dirNames = {}; rn.binOfDir = {}; rn.binObjOfDir = {};
      if (withSiblings) await addSiblings(await getActiveProject());
      rn.done = false; rn.server = null; rn.aep = []; rn.aepNote = '';
      $('rnTpl').value = prefs.tpl; $('rnStart').value = '1';
      openModal(); refresh(); schedulePlan(true);
    },
    setMode: setMode,
    prog: function (a, b, c) { prog(a, b, c); }, progHide: function () { progHide(); }, ticker: relinkTicker,
  };
})();
