# Un-nest Exclude Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick project items (media + sequences) in Settings → Un-nest that will be kept inside the nest (not cloned out) during un-nest, via a searchable dropdown with a per-project persisted exclusion list.

**Architecture:** All work is inside the existing Un-nest IIFE in `plugin/main.js` (which ends at the `})();` around line 8912), plus markup in the `#tab-unnest` settings panel and styles. Storage is `localStorage['unnest_exclude_v1']` keyed by project name. Task 1 builds the storage + searchable UI; Task 2 makes `expandViaClone` skip clips whose source project-item id is on the list.

**Tech Stack:** UXP plugin JavaScript (non-module `plugin/main.js`), Premiere 25+ `ppro` API. No build step and no automated test framework — syntax checked with `node --check`, behavior verified manually in Premiere.

## Global Constraints

- Non-module script: no `import`/`export` in `plugin/main.js`.
- All Premiere API calls are async — wrap with the existing `un(...)` / `callSec(...)` helpers.
- UXP constraints: no `position:fixed`, `z-index`, `display:grid`, `new Audio()`, no `title=""`; `alert()` does NOT render (do not use it).
- Match key is the **project-item id** (`item.getId()`), stored as `{ id, name }` (id for matching, name for display). Never match by name.
- Dropdown lists **media items + sequences only** — exclude folders/bins (`entry.isFolder === true`).
- Persistence is **per-project**, keyed by the active project name, in `localStorage['unnest_exclude_v1']` = `{ [projKey]: [ {id, name}, … ] }`.
- Fail-open: if a clip's id can't be read during un-nest, treat it as NOT excluded (never drop an unidentifiable clip).
- Plugin-only change: do NOT touch `bridge/`, `bridge-app/`, or `Claude Bridge.app`.
- `sacCollectBinItems(rootItem)` is a global helper returning `[{ name, item, isFolder, mediaType, … }]`. `sacCurrentProjectKey` is NOT in scope here — define a local project-key helper.
- Existing in-scope helpers: `un(v)`, `callSec(obj, method)`, `getClipItems(track)`, `logLine(msg, cls)`, `getActiveProject()`, `ppro`, `EPS`.

---

### Task 1: Exclusion storage + searchable Settings UI

**Files:**
- Modify: `plugin/index.html` — add an "Loại trừ khi bung" block inside `#tab-unnest` (after the mode rows, before `#unRun` at ~line 327).
- Modify: `plugin/main.js` — inside the Un-nest IIFE (before its closing `})();` ~line 8912): storage helpers, project-key helper, item-list builder, dropdown + list rendering, and wiring on the settings-tab open.
- Modify: `plugin/styles.css` — styles for the new dropdown/list (append near the other `.un-*` rules).
- No automated test (manual UXP verification).

**Interfaces:**
- Produces (used by Task 2, all defined in the Un-nest IIFE scope):
  - `async function unnestProjKey(): string` — active project name (or guid), '' on failure.
  - `function unnestLoadExcludes(projKey): Array<{id,name}>` — saved list for a project (tolerant of missing/malformed JSON).
  - `function unnestSaveExcludes(projKey, arr): void`.
  - `async function unnestExcludeIdSet(): {[idString]: 1}` — map of excluded id strings for the current project.

- [ ] **Step 1: Add the Settings markup**

In `plugin/index.html`, immediately before `<div id="unRun" ...>` (line ~327), insert:

```html
        <div class="un-excludeWrap">
          <label class="vg-save-label" style="margin-top:2px;">Loại trừ khi bung</label>
          <div class="un-excludeTools">
            <div id="unExcludeAddBtn" class="vg-nameToolBtn" role="button"><span data-ic="plus" data-ic-size="12"></span> Thêm item loại trừ <span class="vg-caret">▾</span></div>
            <div id="unExcludeListBtn" class="vg-nameToolBtn" role="button"><span data-ic="layer_group" data-ic-size="12"></span> Đã loại trừ (<span id="unExcludeCount">0</span>) <span class="vg-caret">▾</span></div>
          </div>
          <div id="unExcludeAddPanel" class="vg-namePanel" hidden>
            <input id="unExcludeSearch" type="text" class="vg-dropSearchInput" placeholder="Tìm theo tên…" />
            <div id="unExcludeSearchList"></div>
            <div id="unExcludeRefresh" class="un-excludeRefresh" role="button"><span data-ic="rotate_right" data-ic-size="11"></span> Làm mới danh sách</div>
          </div>
          <div id="unExcludeListPanel" class="vg-namePanel" hidden></div>
        </div>
```

- [ ] **Step 2: Syntax sanity for HTML (open the plugin later); commit checkpoint deferred**

No command yet — proceed to JS. (HTML has no compiler; it is verified when the panel renders in Step 9.)

- [ ] **Step 3: Add storage + project-key helpers**

In `plugin/main.js`, inside the Un-nest IIFE (a good spot is right after `function logLine(...)`/`clearLog(...)` are defined, near line ~8227 — anywhere in the IIFE before the settings wiring works). Add:

```javascript
  // ── Exclude-from-un-nest list (per-project, by project-item id) ──────────────
  var UNNEST_EXCLUDE_LS = 'unnest_exclude_v1'; // { projKey: [ {id, name}, … ] }
  var unnestItemCache = null; // cached [{id, name}] of project media+sequences (session)
  async function unnestProjKey() {
    try {
      var p = await getActiveProject(); var nm = p && p.name;
      if (nm && typeof nm.then === 'function') nm = await nm;
      return String(nm || (p && p.guid) || '');
    } catch (e) { return ''; }
  }
  function unnestLoadStore() {
    try { var o = JSON.parse(localStorage.getItem(UNNEST_EXCLUDE_LS) || '{}'); return (o && typeof o === 'object') ? o : {}; }
    catch (e) { return {}; }
  }
  function unnestLoadExcludes(projKey) {
    var a = unnestLoadStore()[projKey]; return Array.isArray(a) ? a : [];
  }
  function unnestSaveExcludes(projKey, arr) {
    var store = unnestLoadStore(); store[projKey] = arr;
    try { localStorage.setItem(UNNEST_EXCLUDE_LS, JSON.stringify(store)); } catch (e) {}
  }
  async function unnestExcludeIdSet() {
    var key = await unnestProjKey(); var arr = unnestLoadExcludes(key); var set = {};
    for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id != null) set[String(arr[i].id)] = 1;
    return set;
  }
```

- [ ] **Step 4: Add the project-item list builder**

Immediately after the helpers from Step 3, add:

```javascript
  // Build (and cache) the list of project media items + sequences (id + name).
  async function unnestBuildItemList(force) {
    if (unnestItemCache && !force) return unnestItemCache;
    var out = [];
    try {
      var proj = await getActiveProject();
      var root = proj && (proj.getRootItem ? await un(proj.getRootItem()) : proj.rootItem);
      if (root && typeof sacCollectBinItems === 'function') {
        var items = await sacCollectBinItems(root);
        for (var i = 0; i < items.length; i++) {
          if (items[i].isFolder) continue; // skip bins/folders
          var id = null;
          try { id = await un(items[i].item.getId()); } catch (e) {}
          if (id == null) continue;
          out.push({ id: String(id), name: items[i].name || '(không tên)' });
        }
      }
    } catch (e) {}
    out.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), undefined, { numeric: true }); });
    unnestItemCache = out; return out;
  }
```

- [ ] **Step 5: Add rendering for the excluded-list panel + count**

After Step 4, add:

```javascript
  function unnestRenderCount(projKey) {
    var el = document.getElementById('unExcludeCount');
    if (el) el.textContent = String(unnestLoadExcludes(projKey).length);
  }
  function unnestRenderList(projKey) {
    var panel = document.getElementById('unExcludeListPanel');
    if (!panel) return;
    panel.innerHTML = '';
    var arr = unnestLoadExcludes(projKey);
    if (!arr.length) { panel.innerHTML = '<div class="vg-nameRow vg-nameRow--empty">(chưa loại trừ item nào)</div>'; return; }
    arr.forEach(function (it) {
      var row = document.createElement('div'); row.className = 'vg-nameRow';
      var label = document.createElement('span'); label.className = 'vg-nameRowLabel'; label.textContent = it.name;
      var del = document.createElement('span'); del.className = 'vg-nameRowDel'; del.setAttribute('role', 'button');
      del.innerHTML = window.pluginIconSVG('trash', 12, '#fca5a5');
      del.onclick = function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        var cur = unnestLoadExcludes(projKey).filter(function (x) { return String(x.id) !== String(it.id); });
        unnestSaveExcludes(projKey, cur); unnestRenderList(projKey); unnestRenderCount(projKey);
      };
      row.appendChild(label); row.appendChild(del); panel.appendChild(row);
    });
  }
```

- [ ] **Step 6: Add the searchable add-dropdown renderer**

After Step 5, add:

```javascript
  function unnestRenderSearch(projKey, query) {
    var list = document.getElementById('unExcludeSearchList');
    if (!list) return;
    list.innerHTML = '';
    var items = unnestItemCache || [];
    var q = (query || '').trim().toLowerCase();
    var excluded = {}; unnestLoadExcludes(projKey).forEach(function (x) { excluded[String(x.id)] = 1; });
    var matches = items.filter(function (it) {
      return !excluded[String(it.id)] && (!q || String(it.name).toLowerCase().indexOf(q) !== -1);
    }).slice(0, 40); // cap the rendered rows; the search narrows further
    if (!matches.length) { list.innerHTML = '<div class="vg-nameRow vg-nameRow--empty">' + (items.length ? '(không khớp)' : '(bấm Làm mới danh sách)') + '</div>'; return; }
    matches.forEach(function (it) {
      var row = document.createElement('div'); row.className = 'vg-nameRow';
      row.textContent = it.name;
      row.onclick = function () {
        var cur = unnestLoadExcludes(projKey);
        if (!cur.some(function (x) { return String(x.id) === String(it.id); })) { cur.push({ id: String(it.id), name: it.name }); unnestSaveExcludes(projKey, cur); }
        unnestRenderCount(projKey); unnestRenderList(projKey); unnestRenderSearch(projKey, document.getElementById('unExcludeSearch').value);
      };
      list.appendChild(row);
    });
  }
```

- [ ] **Step 7: Wire the panels + refresh (with stale-prune) on the Un-nest settings tab**

Add an init function after Step 6, and CALL it where the un-nest tab is set up. First the function:

```javascript
  var unnestExcludeWired = false;
  async function unnestInitExclude() {
    var projKey = await unnestProjKey();
    var addBtn = document.getElementById('unExcludeAddBtn');
    var listBtn = document.getElementById('unExcludeListBtn');
    var addPanel = document.getElementById('unExcludeAddPanel');
    var listPanel = document.getElementById('unExcludeListPanel');
    var search = document.getElementById('unExcludeSearch');
    var refresh = document.getElementById('unExcludeRefresh');
    if (!addBtn || !listBtn) return;
    unnestRenderCount(projKey); unnestRenderList(projKey);
    if (unnestExcludeWired) return; // wire click handlers once
    unnestExcludeWired = true;
    function closeP() { if (addPanel) addPanel.hidden = true; if (listPanel) listPanel.hidden = true; }
    addBtn.onclick = async function () {
      var show = addPanel && addPanel.hidden; closeP();
      if (show) {
        if (!unnestItemCache) await unnestBuildItemList(false);
        unnestRenderSearch(await unnestProjKey(), search ? search.value : ''); addPanel.hidden = false;
        try { search.focus(); } catch (e) {}
        if (window.claimKeyboard) window.claimKeyboard();
      } else if (window.releaseKeyboard) window.releaseKeyboard();
    };
    listBtn.onclick = function () {
      var show = listPanel && listPanel.hidden; closeP();
      if (show) { unnestRenderList(projKey); listPanel.hidden = false; }
    };
    if (search) {
      var composing = false;
      search.addEventListener('compositionstart', function () { composing = true; });
      search.addEventListener('compositionend', function () { composing = false; unnestRenderSearch(projKey, search.value); });
      search.addEventListener('input', function () { if (!composing) unnestRenderSearch(projKey, search.value); });
    }
    if (refresh) refresh.onclick = async function () {
      await unnestBuildItemList(true);
      // prune saved ids no longer in the project; refresh saved names to current.
      var live = {}; unnestItemCache.forEach(function (it) { live[String(it.id)] = it.name; });
      var pk = await unnestProjKey();
      var pruned = unnestLoadExcludes(pk).filter(function (x) { return live[String(x.id)]; })
        .map(function (x) { return { id: String(x.id), name: live[String(x.id)] }; });
      unnestSaveExcludes(pk, pruned);
      unnestRenderCount(pk); unnestRenderList(pk); unnestRenderSearch(pk, search ? search.value : '');
    };
  }
```

Then, in the settings-tab wiring near the bottom of the IIFE (the block at ~line 8908-8911 that calls `loadHotkeys()` and adds the `data-stab==='unnest'` click listener), add `unnestInitExclude()` alongside. Change:

```javascript
  loadHotkeys(); // populate labels + premiere-shortcut conflicts (defaults if unreachable)
  document.querySelectorAll('.settings-tab').forEach(function (t) {
    if (t.getAttribute('data-stab') === 'unnest') t.addEventListener('click', loadHotkeys);
  });
```

to:

```javascript
  loadHotkeys(); // populate labels + premiere-shortcut conflicts (defaults if unreachable)
  unnestInitExclude();
  document.querySelectorAll('.settings-tab').forEach(function (t) {
    if (t.getAttribute('data-stab') === 'unnest') t.addEventListener('click', function () { loadHotkeys(); unnestInitExclude(); });
  });
```

- [ ] **Step 8: Add styles**

In `plugin/styles.css`, append near the other `.un-*` rules:

```css
.un-excludeWrap { margin-top: 12px; }
.un-excludeTools { display: flex; align-items: center; margin-top: 6px; }
.un-excludeTools .vg-nameToolBtn { margin-right: 8px; }
.un-excludeTools .vg-nameToolBtn:last-child { margin-right: 0; }
.un-excludeRefresh {
  display: flex; align-items: center; gap: 4px; justify-content: center;
  font-size: 10px; color: var(--text-dim); cursor: pointer;
  padding: 6px 8px; border-top: 1px solid rgba(255,255,255,0.06);
}
.un-excludeRefresh:hover { color: var(--text); }
```

- [ ] **Step 9: Syntax check + manual UI verification**

Run: `cd plugin && node --check main.js`
Expected: exit 0, no output.

Then reload the plugin in Premiere, open Settings → Un-nest:
- "Thêm item loại trừ ▾" opens a panel with a search box; typing narrows the list to name matches (rendered rows capped at 40).
- Clicking an item adds it; "Đã loại trừ (N)" count increments; expanding it lists the item with a trash `×` that removes it.
- "Làm mới danh sách" repopulates the item list.
- Reload → same project shows the saved list; a different project shows its own list.

- [ ] **Step 10: Commit**

```bash
git add plugin/index.html plugin/main.js plugin/styles.css
git commit -m "feat(unnest): searchable per-project exclude-items list in Settings"
```

---

### Task 2: Skip excluded items during un-nest

**Files:**
- Modify: `plugin/main.js` — `expandViaClone` (the video + audio pick loops, ~lines 8443-8477, and the summary `logLine` ~line 8560).
- No automated test (manual UXP verification).

**Interfaces:**
- Consumes (from Task 1): `unnestExcludeIdSet()` → `{[idString]: 1}`.

- [ ] **Step 1: Load the excluded id-set once per expandViaClone call**

In `expandViaClone`, right after the guard line `if (!d.ok || !d.nestedSeq) { … return 0; }` (~line 8388), add:

```javascript
    var excludeIds = await unnestExcludeIdSet();
    var excludedCount = 0;
```

- [ ] **Step 2: Skip excluded clips in the video pick loop**

In the video loop, change the inner body so excluded items are skipped before classification. Replace:

```javascript
      for (var c = 0; c < vc.length; c++) {
        var s1 = await callSec(vc[c], 'getStartTime'), e1 = await callSec(vc[c], 'getEndTime');
        if (s1 == null || e1 == null || !inRange(s1, e1)) continue;
        if (mode === 'video' || mode === 'av') {
          var cls = await classifyVideoClip(vc[c]);
          if (!cls.keep) { vfDropped++; continue; } // pure text/title → skip
        }
        picked.push(vc[c]);
      }
```

with:

```javascript
      for (var c = 0; c < vc.length; c++) {
        var s1 = await callSec(vc[c], 'getStartTime'), e1 = await callSec(vc[c], 'getEndTime');
        if (s1 == null || e1 == null || !inRange(s1, e1)) continue;
        var vpi = await un(vc[c].getProjectItem ? vc[c].getProjectItem() : null);
        if (vpi) { var vpid = null; try { vpid = await un(vpi.getId()); } catch (e) {} if (vpid != null && excludeIds[String(vpid)]) { excludedCount++; continue; } }
        if (mode === 'video' || mode === 'av') {
          var cls = await classifyVideoClip(vc[c]);
          if (!cls.keep) { vfDropped++; continue; } // pure text/title → skip
        }
        picked.push(vc[c]);
      }
```

- [ ] **Step 3: Skip excluded clips in the audio pick loop**

In the audio loop, replace:

```javascript
        for (var b = 0; b < ac.length; b++) {
          var s2 = await callSec(ac[b], 'getStartTime'), e2 = await callSec(ac[b], 'getEndTime');
          if (s2 == null || e2 == null || !inRange(s2, e2)) continue;
          apick.push(ac[b]);
        }
```

with:

```javascript
        for (var b = 0; b < ac.length; b++) {
          var s2 = await callSec(ac[b], 'getStartTime'), e2 = await callSec(ac[b], 'getEndTime');
          if (s2 == null || e2 == null || !inRange(s2, e2)) continue;
          var api2 = await un(ac[b].getProjectItem ? ac[b].getProjectItem() : null);
          if (api2) { var apid = null; try { apid = await un(api2.getId()); } catch (e) {} if (apid != null && excludeIds[String(apid)]) { excludedCount++; continue; } }
          apick.push(ac[b]);
        }
```

- [ ] **Step 4: Report excluded count in the summary log**

Find the summary `logLine('✓ "' + d.name + '": clone ' + done + ' clip …` (~line 8560) and append the excluded note to its message. Change the final segment:

```javascript
      + ((mode === 'video' || mode === 'av') && vfDropped ? ' · bỏ ' + vfDropped + ' text/title' : ''), 'ok');
```

to:

```javascript
      + ((mode === 'video' || mode === 'av') && vfDropped ? ' · bỏ ' + vfDropped + ' text/title' : '')
      + (excludedCount ? ' · bỏ ' + excludedCount + ' item loại trừ' : ''), 'ok');
```

- [ ] **Step 5: Syntax check**

Run: `cd plugin && node --check main.js`
Expected: exit 0, no output.

- [ ] **Step 6: Manual verification in Premiere (25+)**

Reload. In Settings → Un-nest, add an item that appears inside a nested sequence to the exclusion list. Select that nested clip and run un-nest (any mode that would normally clone it):
- The excluded item is NOT placed on the parent timeline; all other inner clips are.
- Remove it from the exclusion list → run again → it IS un-nested.
- With nothing excluded, un-nest behaves exactly as before (regression check).

- [ ] **Step 7: Commit**

```bash
git add plugin/main.js
git commit -m "feat(unnest): skip excluded project items when cloning out"
```

---

## Notes for the implementer

- `getActiveProject`, `ppro`, `un`, `callSec`, `getClipItems`, `logLine`, and `sacCollectBinItems` are all reachable from the Un-nest IIFE. `sacCurrentProjectKey` is NOT — use the local `unnestProjKey` from Task 1.
- Do not use `alert()` — it does not render in this UXP build. On-screen feedback is the panels/count only.
- The exclusion check must run in BOTH pick loops so excluding an item removes its video and audio parts alike.
- Keep the change confined to the Un-nest IIFE, `#tab-unnest` markup, and `.un-*` styles. Do not touch the overflow-clamp/placement logic added earlier.
