# ElevenLabs Clone Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In Settings → Voice Gen, show `X / Y` ElevenLabs clone slots used for the current API account and let the user delete custom voices (searchable, multi-select, arm-then-confirm) directly from the plugin.

**Architecture:** Plugin-only. The plugin calls ElevenLabs REST directly (`api.elevenlabs.io`, added to the manifest) using the existing `ELEVENLABS_KEY`; no bridge endpoint, so `Claude Bridge.app` needs no rebuild/re-seal. New markup goes in the Voice Gen settings panel; new JS goes in the Voice Gen module (same scope as `$`, `ELEVENLABS_KEY`, `loadVoices`).

**Tech Stack:** UXP plugin JavaScript (non-module `plugin/main.js`), UXP `fetch`. No build step, no automated test framework — `node --check` for syntax, manual verification in Premiere.

## Global Constraints

- Non-module script: no `import`/`export`.
- UXP: no `position:fixed`, `z-index`, `display:grid`, `new Audio()`, no `title=""`; `alert()`/`confirm()` do NOT work — use the inline arm-then-confirm button. **UXP flexbox ignores `gap`** — space with explicit `margin`.
- Direct ElevenLabs calls with header `xi-api-key: ELEVENLABS_KEY`; endpoints: `GET /v1/user/subscription`, `GET /v1/voices`, `DELETE /v1/voices/{id}`.
- Count: X = voices with `category !== 'premade'`; Y = `subscription.voice_limit`; warn when `X >= Y`. Uses the current `ELEVENLABS_KEY` (active profile).
- Search list uses pre-rendered rows + display-toggle filter (no `innerHTML` rebuild on keystroke) so Vietnamese IME input isn't swallowed.
- Deletes run sequentially; per-voice failures are counted and reported, others still proceed.
- Touch only `plugin/manifest.json`, `plugin/index.html`, `plugin/main.js`, `plugin/styles.css`. Do NOT touch `bridge/`, `bridge-app/`, the clone/TTS flow, or how the main voice list is built (only call `loadVoices()` to refresh after delete).
- In scope in the Voice Gen module: `$（id)`, `ELEVENLABS_KEY`, `loadVoices()`, `window.claimKeyboard`/`releaseKeyboard`. `setTimeout` is available in the plugin.

---

### Task 1: Clone-slot count + delete manager (Settings → Voice Gen)

**Files:**
- Modify: `plugin/manifest.json` — add `https://api.elevenlabs.io` to `requiredPermissions.network.domains`.
- Modify: `plugin/index.html` — add the manage section after `.vg-apiKeySection` in the Voice Gen settings panel (~line 224).
- Modify: `plugin/main.js` — Voice Gen module (near the profile wiring ~line 7568): fetch layer, state, render, search, delete, wiring.
- Modify: `plugin/styles.css` — `.elv-*` styles.
- No automated test (manual UXP verification).

**Interfaces:** self-contained; no other task depends on it.

- [ ] **Step 1: Allow the ElevenLabs domain in the manifest**

In `plugin/manifest.json`, extend the network domains:

```json
    "network": {
      "domains": [
        "http://localhost:3030",
        "http://127.0.0.1:3030",
        "https://api.elevenlabs.io"
      ]
    }
```

- [ ] **Step 2: Add the manage-section markup**

In `plugin/index.html`, immediately after the `.vg-apiKeySection` closing `</div>` (the block that ends after `#vgDeleteProfile`, ~line 224) and before the `<!-- Output Format -->` block, insert:

```html
        <!-- ElevenLabs clone-slot count + delete manager -->
        <div class="vg-sg elv-manageSection">
          <div class="vg-sl">Voice clone (ElevenLabs)</div>
          <div class="elv-slotRow">
            <span id="elvSlotLine" class="elv-slot">—</span>
            <div id="elvRefresh" class="vg-profileBtn" role="button"><span data-ic="rotate_right" data-ic-size="12"></span> Làm mới</div>
          </div>
          <input type="text" id="elvVoiceSearch" class="vg-settingInput" placeholder="Tìm voice theo tên…" autocomplete="off" />
          <div id="elvVoiceList" class="elv-list"></div>
          <div class="elv-delRow">
            <div id="elvDeleteBtn" class="vg-deleteProfileBtn is-disabled" role="button">Xoá đã chọn (0)</div>
            <span id="elvDelStatus" class="elv-delStatus"></span>
          </div>
        </div>
```

- [ ] **Step 3: Add the fetch layer + state**

In `plugin/main.js`, inside the Voice Gen module near the profile wiring (after the `var vgSaveKeyBtn = $('vgSaveKey');` area, ~line 7572), add:

```javascript
    // ── ElevenLabs clone manager (direct API; current ELEVENLABS_KEY) ──────────
    var elvVoices = [];    // [{ id, name, category }] custom (non-premade) voices
    var elvLimit = 0;      // subscription.voice_limit
    var elvSelected = {};  // voice_id → 1
    var elvBusy = false;
    var elvArmed = false, elvArmTimer = null;

    async function elvApi(method, path) {
      if (!ELEVENLABS_KEY) throw new Error('no-key');
      var res = await fetch('https://api.elevenlabs.io' + path, {
        method: method,
        headers: { 'xi-api-key': ELEVENLABS_KEY, 'Accept': 'application/json' }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (method === 'DELETE') return true;
      return await res.json();
    }

    async function elvFetchState() {
      var slot = $('elvSlotLine');
      if (!ELEVENLABS_KEY) { if (slot) { slot.textContent = 'Chưa có API key'; slot.className = 'elv-slot'; } elvVoices = []; elvLimit = 0; elvSelected = {}; elvRenderList(); return; }
      if (slot) { slot.textContent = 'Đang tải…'; slot.className = 'elv-slot'; }
      try {
        var sub = await elvApi('GET', '/v1/user/subscription');
        var vd  = await elvApi('GET', '/v1/voices');
        elvLimit = (sub && sub.voice_limit) || 0;
        var voices = (vd && vd.voices) || [];
        elvVoices = voices.filter(function (v) { return v.category !== 'premade'; })
          .map(function (v) { return { id: v.voice_id, name: v.name || '(no name)', category: v.category || '' }; });
        elvSelected = {};
        elvRenderSlots();
        elvRenderList();
      } catch (e) {
        if (slot) { slot.textContent = 'Không đọc được (kiểm tra API key)'; slot.className = 'elv-slot elv-err'; }
        elvVoices = []; elvSelected = {}; elvRenderList();
      }
    }
    function elvRenderSlots() {
      var slot = $('elvSlotLine'); if (!slot) return;
      var x = elvVoices.length, y = elvLimit;
      var full = y > 0 && x >= y;
      slot.textContent = 'Đã dùng ' + x + ' / ' + (y || '?') + ' slot clone' + (full ? ' — ĐẦY' : '');
      slot.className = 'elv-slot' + (full ? ' is-full' : '');
    }
```

- [ ] **Step 4: Add list render + search filter**

After Step 3's code, add:

```javascript
    function elvUpdateDeleteBtn() {
      var btn = $('elvDeleteBtn'); if (!btn) return;
      var n = Object.keys(elvSelected).length;
      btn.classList.toggle('is-disabled', n === 0 || elvBusy);
      if (elvArmed) { btn.textContent = 'Xác nhận xoá ' + n + ' voice?'; btn.classList.add('is-armed'); }
      else { btn.textContent = 'Xoá đã chọn (' + n + ')'; btn.classList.remove('is-armed'); }
    }
    // Rebuilt only on fetch/delete (never on keystroke) — search uses elvFilterRows.
    function elvRenderList() {
      var list = $('elvVoiceList'); if (!list) return;
      list.innerHTML = '';
      if (!elvVoices.length) { list.innerHTML = '<div class="vg-nameRow vg-nameRow--empty">(không có voice clone)</div>'; elvUpdateDeleteBtn(); return; }
      elvVoices.forEach(function (v) {
        var row = document.createElement('label'); row.className = 'elv-row';
        var cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'elv-cb'; cb.checked = !!elvSelected[v.id];
        cb.onchange = function () { if (cb.checked) elvSelected[v.id] = 1; else delete elvSelected[v.id]; elvUpdateDeleteBtn(); };
        var nm = document.createElement('span'); nm.className = 'elv-rowName'; nm.textContent = v.name;
        var tag = document.createElement('span'); tag.className = 'elv-rowTag'; tag.textContent = v.category;
        row.appendChild(cb); row.appendChild(nm); row.appendChild(tag);
        row.setAttribute('data-name', String(v.name).toLowerCase());
        list.appendChild(row);
      });
      elvUpdateDeleteBtn();
      var s = $('elvVoiceSearch'); elvFilterRows(s ? s.value : '');
    }
    function elvFilterRows(query) {
      var list = $('elvVoiceList'); if (!list) return;
      var q = (query || '').trim().toLowerCase();
      var rows = list.querySelectorAll('.elv-row');
      for (var i = 0; i < rows.length; i++) {
        var nm = rows[i].getAttribute('data-name') || '';
        rows[i].style.display = (!q || nm.indexOf(q) !== -1) ? '' : 'none';
      }
    }
```

- [ ] **Step 5: Add the arm-then-confirm delete**

After Step 4's code, add:

```javascript
    async function elvDoDelete() {
      var ids = Object.keys(elvSelected);
      if (!ids.length || elvBusy) return;
      elvBusy = true; elvArmed = false; if (elvArmTimer) { clearTimeout(elvArmTimer); elvArmTimer = null; }
      elvUpdateDeleteBtn();
      var ok = 0, fail = 0;
      for (var i = 0; i < ids.length; i++) {
        try { await elvApi('DELETE', '/v1/voices/' + ids[i]); ok++; } catch (e) { fail++; }
      }
      var st = $('elvDelStatus'); if (st) st.textContent = 'Đã xoá ' + ok + (fail ? (' • Lỗi ' + fail) : '');
      elvBusy = false;
      await elvFetchState();                       // refresh count + list
      try { if (typeof loadVoices === 'function') await loadVoices(); } catch (e) {} // refresh main dropdown
    }
    function elvOnDeleteClick() {
      var n = Object.keys(elvSelected).length;
      if (!n || elvBusy) return;
      if (!elvArmed) {
        elvArmed = true; elvUpdateDeleteBtn();
        if (elvArmTimer) clearTimeout(elvArmTimer);
        elvArmTimer = setTimeout(function () { elvArmed = false; elvUpdateDeleteBtn(); }, 4000);
        return;
      }
      elvDoDelete();
    }
```

- [ ] **Step 6: Wire the controls + tab-open refresh**

After Step 5's code, add:

```javascript
    (function elvWire() {
      var rb = $('elvRefresh'); if (rb) rb.addEventListener('click', function () { elvFetchState(); });
      var db = $('elvDeleteBtn'); if (db) db.addEventListener('click', elvOnDeleteClick);
      var es = $('elvVoiceSearch');
      if (es) {
        es.addEventListener('focus', function () { if (window.claimKeyboard) window.claimKeyboard(); });
        es.addEventListener('blur',  function () { if (window.releaseKeyboard) window.releaseKeyboard(); });
        var composing = false;
        es.addEventListener('compositionstart', function () { composing = true; });
        es.addEventListener('compositionend', function () { composing = false; elvFilterRows(es.value); });
        es.addEventListener('input', function () { if (!composing) elvFilterRows(es.value); });
      }
      document.querySelectorAll('.settings-tab').forEach(function (t) {
        if (t.getAttribute('data-stab') === 'voicegen') t.addEventListener('click', function () { elvFetchState(); });
      });
    })();
```

- [ ] **Step 7: Add styles**

In `plugin/styles.css`, append near the other `.vg-*` settings rules (UXP has no flex `gap` — margins used):

```css
.elv-manageSection { margin-top: 10px; }
.elv-slotRow { display: flex; align-items: center; justify-content: space-between; margin: 6px 0; }
.elv-slot { font-size: 11px; color: var(--text-dim); }
.elv-slot.is-full, .elv-slot.elv-err { color: #fca5a5; font-weight: 600; }
.elv-list { max-height: 220px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; margin-top: 4px; }
.elv-row { display: flex; align-items: center; padding: 5px 8px; font-size: 11px; color: var(--text); border-bottom: 1px solid rgba(255,255,255,0.05); cursor: pointer; }
.elv-row:last-child { border-bottom: none; }
.elv-row:hover { background: rgba(255,255,255,0.06); }
.elv-cb { width: 13px; height: 13px; margin-right: 8px; flex: 0 0 auto; }
.elv-rowName { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 8px; }
.elv-rowTag { flex: 0 0 auto; font-size: 9px; color: var(--text-dim); }
.elv-delRow { display: flex; align-items: center; margin-top: 6px; }
.elv-delRow #elvDeleteBtn { margin-right: 8px; }
.elv-delStatus { font-size: 10px; color: var(--text-dim); }
.vg-deleteProfileBtn.is-armed { background: #dc2626; color: #fff; }
.vg-deleteProfileBtn.is-disabled { opacity: 0.5; pointer-events: none; }
```

- [ ] **Step 8: Syntax check**

Run: `cd plugin && node --check main.js`
Expected: exit 0, no output.

- [ ] **Step 9: Manual verification in Premiere (25+, real ElevenLabs key)**

Reload the plugin. Settings → Voice Gen → "Voice clone (ElevenLabs)":
- Slot line shows `Đã dùng X / Y slot clone` matching the ElevenLabs dashboard; ↻ Làm mới refreshes. Full account (X≥Y) shows red + `ĐẦY`.
- Type a partial voice name → list narrows; Vietnamese typing not swallowed; the Settings tab stays put.
- Tick 2 voices → button reads `Xoá đã chọn (2)` → click once (arms red `Xác nhận xoá 2 voice?`) → click again → both deleted on ElevenLabs (verify on dashboard); count drops; status `Đã xoá 2`; they vanish from the main Voice dropdown.
- Empty/bad API key → slot line shows `Chưa có API key` / `Không đọc được…`; list empty; delete disabled.

- [ ] **Step 10: Commit**

```bash
git add plugin/manifest.json plugin/index.html plugin/main.js plugin/styles.css
git commit -m "feat(voicegen): ElevenLabs clone-slot count + delete manager in Settings"
```

---

## Notes for the implementer

- `$`, `ELEVENLABS_KEY`, `loadVoices`, and `window.claimKeyboard`/`releaseKeyboard` are reachable in the Voice Gen module — do not redefine.
- Do NOT use `alert()`/`confirm()`; the arm-then-confirm button is the confirmation.
- The search filter (`elvFilterRows`) must only toggle `display` — never rebuild the list on a keystroke (Vietnamese IME).
- After delete, both `elvFetchState()` (this panel) and `loadVoices()` (main dropdown) must run so counts and the picker stay in sync.
- Keep changes within the Voice Gen module, the Voice Gen settings markup, `.elv-*` styles, and the manifest domain. Nothing else.
