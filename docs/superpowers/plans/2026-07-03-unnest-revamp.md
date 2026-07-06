# Un-nest Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Un-nest a compact Settings utility with a video-only element filter and three user-assignable global hotkeys.

**Architecture:** Plugin JS keeps the core copy-paste expansion; a new `isVideoLikeClip` predicate filters the `video` mode. The Un-nest UI moves into the ⚙ Settings modal as a sub-tab. Global hotkeys are owned by the Swift host app (Carbon), which POSTs a trigger to the node bridge; the plugin polls the bridge and runs on the current selection. Hotkey combos are captured in-plugin (click-to-capture) and stored in `~/Library/Application Support/ClaudeBridge/hotkeys.json`, watched by the Swift app.

**Tech Stack:** UXP (Premiere DOM, non-module JS), Node/Express (bridge), Swift/Cocoa + Carbon (host app), AppleScript (existing host-key path).

## Global Constraints

- Non-module JS only (no `import`/`export`); follow existing `main.js` style (var, function).
- UXP: no `position:fixed`, no `z-index`, no `display:grid`; all Premiere API calls `await`ed.
- Config file MUST live at `~/Library/Application Support/ClaudeBridge/hotkeys.json` — never inside `Claude Bridge.app` (editing the bundle breaks its ad-hoc seal).
- Any change to `bridge/server.js` or `bridge-app/main.swift` requires `bridge-app/build-app.sh` (rebuild + ad-hoc re-sign) + re-grant Accessibility for `com.claudeai.bridge`.
- Plugin-only changes ship by copying files to `~/Library/Application Support/Adobe/UXP/Plugins/External/com.claudeai.premiere-assistant_4.8.10/` and reloading the panel.
- macOS-only. Default hotkeys: ⌃⌥⌘1 (video) / ⌃⌥⌘2 (av) / ⌃⌥⌘3 (avt).
- No automated test harness exists for UXP/Premiere DOM; plugin tasks verify by manual reload + panel log. Bridge tasks verify via `curl`. Swift tasks verify via build + hotkey.
- Verify each change with `node --check` before syncing; branch off `main` before the first commit.

## File structure

- `plugin/main.js` — un-nest module: add `isVideoLikeClip` + text probe (Phase 1); move UI wiring to Settings + ungate trigger poll + hotkey capture + poll loop (Phase 2/3).
- `plugin/index.html` — remove UN-NEST tab + panel; add Settings sub-tab "Un-nest" (Phase 2).
- `plugin/styles.css` — relocate un-nest styles under Settings scope (Phase 2).
- `bridge/server.js` — `/unnest/trigger`, `/unnest/poll`, `/unnest/hotkeys` (Phase 3).
- `bridge-app/main.swift` — Carbon hotkey registration + config watch + trigger POST (Phase 3).

---

## PHASE 1 — Video-only element filter (plugin-only, no rebuild)

### Task 1.1: Probe what clip-type/text info UXP exposes

**Files:**
- Modify: `plugin/main.js` (un-nest module, temporary probe button or console call)

**Interfaces:**
- Produces: findings recorded in the plan/commit message; informs Task 1.2's detection path.

- [ ] **Step 1: Add a temporary probe** in the un-nest module that, for each selected track item, logs available identity signals. Insert near `detect()`:

```javascript
async function unnestProbe() {
  var seq = await getActiveSequence();
  var sel = await un(seq.getSelection());
  var items = await awaitArray(sel.getTrackItems());
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var pi = await un(it.getProjectItem ? it.getProjectItem() : null);
    var info = { name: '', hasGetMediaFilePath: false, mediaPath: '', isSeq: null,
                 chainLen: null, compNames: [] };
    try { info.name = pi && pi.name; } catch (e) {}
    try { info.hasGetMediaFilePath = pi && typeof pi.getMediaFilePath === 'function'; } catch (e) {}
    try { if (info.hasGetMediaFilePath) { var mp = pi.getMediaFilePath(); info.mediaPath = (mp && mp.then) ? await mp : mp; } } catch (e) {}
    try { var cp = asClipPI(pi); info.isSeq = cp ? await un(cp.isSequence()) : null; } catch (e) {}
    try {
      var chain = it.getComponentChain ? await un(it.getComponentChain()) : null;
      if (chain) { info.chainLen = chain.getComponentCount ? await un(chain.getComponentCount()) : (chain.length || null); }
    } catch (e) {}
    logLine('[probe] ' + JSON.stringify(info), 'warn');
    console.log('[unnest-probe]', info);
  }
}
window.__unnestProbe = unnestProbe;
```

- [ ] **Step 2: Sync + reload + run** on a nested containing footage, a Title, and a text mogrt (select each, call `window.__unnestProbe()` from the UXP console or a temp button). Record for each element type: does `getMediaFilePath()` exist and is it empty for graphics? Is a component chain readable? Is there any text/source-text component?

Run: reload panel, run probe, read `[probe]` log lines.
Expected: a documented mapping of which signals distinguish footage / nested / graphic / text-graphic on this build.

- [ ] **Step 3: Decide detection path** from the findings: `text-readable` (component/text exposed) or `fallback` (only media-path presence usable). Note the decision in the commit message.

- [ ] **Step 4: Remove the probe** (`unnestProbe` + `window.__unnestProbe`), keep nothing behind.

- [ ] **Step 5: Commit**

```bash
git add plugin/main.js
git commit -m "chore(unnest): probe UXP clip-type/text signals (findings in msg)"
```

### Task 1.2: Add `isVideoLikeClip` predicate

**Files:**
- Modify: `plugin/main.js` — add predicate near `collectCutRangeItems`.

**Interfaces:**
- Produces: `async function isVideoLikeClip(clip)` → `Promise<boolean>` (true = keep in `video` mode).
- Consumes: `asClipPI`, `un` (existing).

- [ ] **Step 1: Implement the predicate** using the path chosen in 1.1. Text-readable version keeps footage/nested/dynamic-link and drops text graphics; fallback drops all path-less synthetic graphics. Include both branches guarded by a module const `UNNEST_TEXT_DETECTION` set from 1.1:

```javascript
var UNNEST_TEXT_DETECTION = false; // set true only if Task 1.1 confirmed text is readable

// True → keep this clip in "video" mode. Keeps footage, nested sequences, and
// dynamic-link comps; drops titles/captions and text-bearing graphics/mogrt.
async function isVideoLikeClip(clip) {
  try {
    var pi = await un(clip.getProjectItem ? clip.getProjectItem() : null);
    if (!pi) return true; // unknown → don't silently drop
    var cp = asClipPI(pi);
    if (cp) { try { if (await un(cp.isSequence())) return true; } catch (e) {} } // nested seq
    var mediaPath = '';
    try { if (typeof pi.getMediaFilePath === 'function') { var mp = pi.getMediaFilePath(); mediaPath = (mp && mp.then) ? await mp : mp; } } catch (e) {}
    if (mediaPath) return true; // backed by a real media file / dynamic link → footage
    if (UNNEST_TEXT_DETECTION) {
      // Path-less: inspect for a text component; only text-bearing graphics are dropped.
      try { if (!(await clipHasText(clip))) return true; } catch (e) { return true; }
      return false;
    }
    // Fallback: path-less synthetic graphic (Title/Graphic/mogrt/matte) → drop.
    return false;
  } catch (e) { return true; }
}
```

- [ ] **Step 2:** If `UNNEST_TEXT_DETECTION` is true, implement `clipHasText(clip)` using the exact component API confirmed in 1.1 (fill in the real component/text accessor names). If false, omit `clipHasText` entirely.

- [ ] **Step 3: Syntax check.** Run: `node --check plugin/main.js` → Expected: no output (OK).

- [ ] **Step 4: Commit**

```bash
git add plugin/main.js
git commit -m "feat(unnest): add isVideoLikeClip predicate (video-only mode)"
```

### Task 1.3: Apply the filter in `video` mode

**Files:**
- Modify: `plugin/main.js` — `collectCutRangeItems` video loop.

**Interfaces:**
- Consumes: `isVideoLikeClip`.

- [ ] **Step 1:** In `collectCutRangeItems`, gate video-track clips by the predicate when `mode === 'video'`. Change the video loop body:

```javascript
for (var a = 0; a < vc.length; a++) {
  var s1 = await callSec(vc[a], 'getStartTime'), e1 = await callSec(vc[a], 'getEndTime');
  if (s1 == null || e1 == null) continue;
  if (mode === 'video' && !(await isVideoLikeClip(vc[a]))) continue; // skip text/graphics
  consider(vc[a], s1, e1);
}
```

- [ ] **Step 2: Update the option label** in `index.html` (done fully in Phase 2, but the wording): "Chỉ element video — bỏ text / title".

- [ ] **Step 3: Syntax check + sync + manual verify.** Run: `node --check plugin/main.js`; copy `main.js` to the External folder; reload panel. On a nested with footage + title + text mogrt, run `video` mode → footage/nested pasted, title + text graphics skipped. The `[diag] chọn X/Y` line should show fewer picked than total.
Expected: text/title elements absent from the un-nested result.

- [ ] **Step 4: Commit**

```bash
git add plugin/main.js
git commit -m "feat(unnest): filter video-only mode to video-like elements"
```

---

## PHASE 2 — Move Un-nest into Settings (plugin-only, no rebuild)

### Task 2.1: Add the "Un-nest" Settings sub-tab markup

**Files:**
- Modify: `plugin/index.html` — add sub-tab button + panel; remove old tab + panel.
- Modify: `plugin/styles.css` — scope styles to `.settings-tabPanel[data-stab="unnest"]`.

**Interfaces:**
- Produces: DOM ids `#unMode*` radios, `#unRun`, `#unDisableOrig`, `#unLog`, and 3 hotkey capture fields `#unHkVideo`, `#unHkAv`, `#unHkAvt` (consumed by Phase 3 wiring).

- [ ] **Step 1: Add the sub-tab button** after the Voice Gen settings-tab ([index.html:118](../../../plugin/index.html)):

```html
<div class="settings-tab" role="button" data-stab="unnest">Un-nest</div>
```

- [ ] **Step 2: Add the sub-tab panel** after the voicegen `settings-tabPanel` (before `settings-actions`). Move the 3 mode radios + disable-original toggle + run button + log out of the old `#tab-unnest`, and add 3 hotkey capture fields:

```html
<div class="settings-tabPanel" data-stab="unnest" hidden>
  <div class="un-modeRow">
    <label><input type="radio" name="unMode" value="video" checked> Chỉ element video — bỏ text / title</label>
    <div class="un-hk" data-mode="video"><span class="un-hkLabel" id="unHkVideo">⌃⌥⌘1</span><button class="un-hkSet" data-target="unHkVideo">Đổi…</button></div>
  </div>
  <div class="un-modeRow">
    <label><input type="radio" name="unMode" value="av"> Clip + audio</label>
    <div class="un-hk" data-mode="av"><span class="un-hkLabel" id="unHkAv">⌃⌥⌘2</span><button class="un-hkSet" data-target="unHkAv">Đổi…</button></div>
  </div>
  <div class="un-modeRow">
    <label><input type="radio" name="unMode" value="avt"> Clip + audio + text <i>(thử nghiệm)</i></label>
    <div class="un-hk" data-mode="avt"><span class="un-hkLabel" id="unHkAvt">⌃⌥⌘3</span><button class="un-hkSet" data-target="unHkAvt">Đổi…</button></div>
  </div>
  <label class="un-optRow"><input type="checkbox" id="unDisableOrig" checked> Tắt (disable) clip nested gốc sau khi bung</label>
  <div id="unRun" class="un-runBtn" role="button" aria-disabled="false">UN-NEST CLIP ĐÃ CHỌN</div>
  <div id="unLog" class="un-log" hidden></div>
</div>
```

- [ ] **Step 3: Remove the old tab** button `.tab-btn[data-tab="unnest"]` ([index.html:33](../../../plugin/index.html)) and the whole `#tab-unnest` panel ([index.html:1128-1189](../../../plugin/index.html)).

- [ ] **Step 4: Move CSS** — in `styles.css`, re-scope the `#tab-unnest ...` rules to `.settings-tabPanel[data-stab="unnest"] ...`; keep `.un-item`, `.un-runBtn`, `.un-log`, radios. Add `.un-modeRow`/`.un-hk`/`.un-hkSet` layout (flex row, label + spacer + button).

- [ ] **Step 5: Sync + reload + verify** the UN-NEST top tab is gone and ⚙ Settings → Un-nest shows the controls.
Expected: no UN-NEST tab; Settings shows the sub-tab with 3 modes + hotkey fields.

- [ ] **Step 6: Commit**

```bash
git add plugin/index.html plugin/styles.css
git commit -m "feat(unnest): move UI into Settings sub-tab, drop top-level tab"
```

### Task 2.2: Rewire the un-nest module to the new DOM + refs

**Files:**
- Modify: `plugin/main.js` — element lookups (`els`), remove old tab-open detect hook, keep run/detect.

**Interfaces:**
- Consumes: new ids from 2.1. Removes `els.refresh`/`els.hint`/`els.count`/`els.list` if those UI pieces were dropped; keep `els.run`, `els.disableOrig`, `els.log`.

- [ ] **Step 1:** Update the `els` map at the top of the un-nest IIFE to the ids that still exist (`run: $('unRun')`, `disableOrig: $('unDisableOrig')`, `log: $('unLog')`). Guard removed refs so `renderList`/`detect` that touched `els.count`/`els.list` either no-op or are simplified (manual run detects the current selection directly instead of rendering a list).

- [ ] **Step 2:** Replace the tab-open detect hook (`document.querySelectorAll('.tab-btn')...unnest`) with a settings-sub-tab hook: when `data-stab="unnest"` becomes active, no forced detect is needed (manual run detects on click).

- [ ] **Step 3:** Make `run()` detect the current selection itself (call `detect({silent:true})` first, then expand `detected`), so it no longer depends on the removed live list UI.

- [ ] **Step 4: Syntax check + sync + verify** manual run from Settings → Un-nest expands the selected nested clip.
Run: `node --check plugin/main.js`; reload; select nested; click UN-NEST → expands.

- [ ] **Step 5: Commit**

```bash
git add plugin/main.js
git commit -m "refactor(unnest): rewire module to Settings DOM, self-detect on run"
```

---

## PHASE 3 — Global hotkeys (bridge + Swift app; rebuild + re-sign + re-grant)

### Task 3.1: Bridge endpoints — trigger / poll / hotkeys

**Files:**
- Modify: `bridge/server.js` — add 3 routes + config read/write helpers near the `/host-key` route.

**Interfaces:**
- Produces: `POST /unnest/trigger {mode}`, `GET /unnest/poll`, `GET|POST /unnest/hotkeys`.
- Config path: `path.join(os.homedir(), 'Library/Application Support/ClaudeBridge/hotkeys.json')`.

- [ ] **Step 1: Implement** (place after the `/host-key` route):

```javascript
const UNNEST_MODES = ['video', 'av', 'avt'];
let unnestPending = null; // { mode, ts } — one-shot
const HK_DIR  = path.join(os.homedir(), 'Library/Application Support/ClaudeBridge');
const HK_FILE = path.join(HK_DIR, 'hotkeys.json');
const HK_DEFAULT = {
  video: { code: 'Digit1', cmd: true, opt: true, ctrl: true, shift: false },
  av:    { code: 'Digit2', cmd: true, opt: true, ctrl: true, shift: false },
  avt:   { code: 'Digit3', cmd: true, opt: true, ctrl: true, shift: false },
};
function readHotkeys() {
  try { return Object.assign({}, HK_DEFAULT, JSON.parse(fs.readFileSync(HK_FILE, 'utf8'))); }
  catch (e) { return HK_DEFAULT; }
}
app.post('/unnest/trigger', (req, res) => {
  const mode = String((req.body && req.body.mode) || '');
  if (UNNEST_MODES.indexOf(mode) === -1) return res.status(400).json({ ok: false, error: 'mode không hợp lệ' });
  unnestPending = { mode, ts: Date.now() };
  res.json({ ok: true });
});
app.get('/unnest/poll', (_req, res) => {
  const p = unnestPending; unnestPending = null;
  res.json({ ok: true, pending: p ? { mode: p.mode } : null });
});
app.get('/unnest/hotkeys', (_req, res) => res.json({ ok: true, hotkeys: readHotkeys() }));
app.post('/unnest/hotkeys', (req, res) => {
  try {
    const hk = req.body && req.body.hotkeys ? req.body.hotkeys : req.body;
    fs.mkdirSync(HK_DIR, { recursive: true });
    fs.writeFileSync(HK_FILE, JSON.stringify(Object.assign({}, HK_DEFAULT, hk), null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
```

- [ ] **Step 2:** Ensure `os` and `path` and `fs` are required at the top of `server.js` (add `const os = require('os');` if missing).

- [ ] **Step 3: Test with node + curl.** Run the repo bridge locally (`node bridge/server.js` on a spare port if 3030 is taken, or stop the app first), then:

```bash
curl -s -XPOST localhost:3030/unnest/trigger -H 'Content-Type: application/json' -d '{"mode":"video"}'
curl -s localhost:3030/unnest/poll   # → {"ok":true,"pending":{"mode":"video"}}
curl -s localhost:3030/unnest/poll   # → {"ok":true,"pending":null}  (one-shot)
curl -s -XPOST localhost:3030/unnest/hotkeys -H 'Content-Type: application/json' -d '{"hotkeys":{"video":{"code":"KeyU","cmd":true,"opt":false,"ctrl":true,"shift":false}}}'
curl -s localhost:3030/unnest/hotkeys   # → merged config; check ~/Library/Application Support/ClaudeBridge/hotkeys.json written
```
Expected: outputs as annotated; config file created outside any app bundle.

- [ ] **Step 4: Commit**

```bash
git add bridge/server.js
git commit -m "feat(bridge): /unnest trigger, poll, hotkeys config endpoints"
```

### Task 3.2: Plugin trigger poll + run-by-mode

**Files:**
- Modify: `plugin/main.js` — global poll loop for `/unnest/poll`.

**Interfaces:**
- Consumes: `/unnest/poll`; `run()` / `detect()`; `BRIDGE_URL`.
- Produces: `async function runMode(mode)` that sets the mode radio + runs.

- [ ] **Step 1: Add `runMode`** — set the selected mode then run:

```javascript
async function runMode(mode) {
  var r = document.querySelector('input[name="unMode"][value="' + mode + '"]');
  if (r) r.checked = true;
  await run();
}
```

- [ ] **Step 2: Add a global trigger poll** (runs regardless of active tab; separate from the selection-fingerprint poll). Guard reentrancy with `busy`:

```javascript
var trigPolling = false;
async function pollTrigger() {
  if (busy || trigPolling) return;
  trigPolling = true;
  try {
    var res = await fetch(BRIDGE_URL + '/unnest/poll');
    var j = await res.json();
    if (j && j.pending && j.pending.mode) await runMode(j.pending.mode);
  } catch (e) {} finally { trigPolling = false; }
}
setInterval(pollTrigger, 400);
```

- [ ] **Step 3: Sync + verify** with a manual curl trigger while the plugin is loaded and a nested clip is selected:

```bash
curl -s -XPOST localhost:3030/unnest/trigger -H 'Content-Type: application/json' -d '{"mode":"video"}'
```
Expected: within ~0.5s the plugin runs un-nest in `video` mode on the selection (log shows a run), proving the poll path end-to-end before hotkeys exist.

- [ ] **Step 4: Commit**

```bash
git add plugin/main.js
git commit -m "feat(unnest): poll bridge trigger and run selected mode globally"
```

### Task 3.3: Click-to-capture hotkey config in plugin

**Files:**
- Modify: `plugin/main.js` — capture UI + load/save via `/unnest/hotkeys`.

**Interfaces:**
- Consumes: `.un-hkSet` buttons, `#unHk*` labels, `/unnest/hotkeys`.
- Produces: config objects `{ code, cmd, opt, ctrl, shift }` per mode.

- [ ] **Step 1: Load saved hotkeys** into the labels on Settings open (GET `/unnest/hotkeys`), formatting a display string (`comboLabel(cfg)` → `⌃⌥⌘1`).

- [ ] **Step 2: Capture flow.** On `.un-hkSet` click, put the paired label into "listening" state and attach a one-shot `keydown` (capture phase) on `document`:

```javascript
function comboLabel(c){ return (c.ctrl?'⌃':'')+(c.opt?'⌥':'')+(c.shift?'⇧':'')+(c.cmd?'⌘':'')+ (c.code||'').replace(/^Key|^Digit/,''); }
function captureCombo(labelEl, mode) {
  labelEl.textContent = 'Bấm tổ hợp…';
  function onKey(e){
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { cleanup(); loadHotkeys(); return; }
    if (['Meta','Alt','Control','Shift'].indexOf(e.key) !== -1) return; // modifier-only → wait
    var cfg = { code: e.code, cmd: e.metaKey, opt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey };
    labelEl.textContent = comboLabel(cfg);
    saveHotkey(mode, cfg); cleanup();
  }
  function cleanup(){ document.removeEventListener('keydown', onKey, true); }
  document.addEventListener('keydown', onKey, true);
}
```

- [ ] **Step 3: Save** — merge the one mode into the current config and POST the full set to `/unnest/hotkeys`; warn (log, non-blocking) on duplicate combo or modifier-only.

- [ ] **Step 4: Sync + verify** — click "Đổi…" on `video`, press a combo → label updates; GET `/unnest/hotkeys` reflects it; `hotkeys.json` updated.
Expected: capture works while the Settings panel is focused; config persists.

- [ ] **Step 5: Commit**

```bash
git add plugin/main.js
git commit -m "feat(unnest): click-to-capture hotkey config, persist via bridge"
```

### Task 3.4: Swift app — register Carbon hotkeys + POST trigger + watch config

**Files:**
- Modify: `bridge-app/main.swift` — add `import Carbon`; hotkey manager; call from `applicationDidFinishLaunching`.

**Interfaces:**
- Consumes: `hotkeys.json`; posts to `http://localhost:3030/unnest/trigger`.

- [ ] **Step 1: Add a code→keycode map** (kVK_*) covering Digit0-9 and A-Z at minimum:

```swift
let kVKByCode: [String: UInt32] = [
  "Digit1": 0x12, "Digit2": 0x13, "Digit3": 0x14, "Digit4": 0x15, "Digit5": 0x17,
  "Digit6": 0x16, "Digit7": 0x1A, "Digit8": 0x1C, "Digit9": 0x19, "Digit0": 0x1D,
  "KeyA": 0x00, "KeyU": 0x20, "KeyN": 0x2D /* … extend as needed */ ]
func carbonMods(_ h: [String: Any]) -> UInt32 {
  var m: UInt32 = 0
  if h["cmd"]  as? Bool == true { m |= UInt32(cmdKey) }
  if h["opt"]  as? Bool == true { m |= UInt32(optionKey) }
  if h["ctrl"] as? Bool == true { m |= UInt32(controlKey) }
  if h["shift"] as? Bool == true { m |= UInt32(shiftKey) }
  return m
}
```

- [ ] **Step 2: Register hotkeys** with `RegisterEventHotKey` + an `InstallEventHandler` that maps the fired hotkey id → mode → fires `postTrigger(mode)`. Keep an array of `EventHotKeyRef` to `UnregisterEventHotKey` on reload.

- [ ] **Step 3: `postTrigger`** — fire-and-forget POST:

```swift
func postTrigger(_ mode: String) {
  var req = URLRequest(url: URL(string: "http://localhost:3030/unnest/trigger")!)
  req.httpMethod = "POST"
  req.setValue("application/json", forHTTPHeaderField: "Content-Type")
  req.httpBody = try? JSONSerialization.data(withJSONObject: ["mode": mode])
  URLSession.shared.dataTask(with: req).resume()
}
```

- [ ] **Step 4: Read config + watch.** Read `~/Library/Application Support/ClaudeBridge/hotkeys.json` (defaults ⌃⌥⌘1/2/3 if absent) at launch; register. Watch with a `DispatchSource.makeFileSystemObjectSource` (or a 2s `Timer`); on change → unregister all → re-read → re-register. Call the setup from `applicationDidFinishLaunching`.

- [ ] **Step 5: Build.** Run: `bash bridge-app/build-app.sh`
Expected: "Swift compiled — universal binary" and "Signed"; no swiftc errors.

- [ ] **Step 6: Commit**

```bash
git add bridge-app/main.swift
git commit -m "feat(bridge-app): register configurable global hotkeys, POST unnest trigger"
```

### Task 3.5: Install, re-grant Accessibility, end-to-end verify

**Files:** none (deploy + manual verify).

- [ ] **Step 1: Install** the freshly built app: replace `/Applications/Claude Bridge.app` with the new build (quit old first), or run the installer. Confirm seal valid: `codesign --verify --verbose "/Applications/Claude Bridge.app"` → "valid on disk".
- [ ] **Step 2: Re-grant Accessibility** (bundle identity changed): `tccutil reset Accessibility com.claudeai.bridge`, then add/enable Claude Bridge in System Settings → Privacy & Security → Accessibility; relaunch app; confirm `/health` shows `hostKey:true`.
- [ ] **Step 3: End-to-end.** Select a nested clip on the Timeline; press ⌃⌥⌘1 → runs `video` mode; ⌃⌥⌘2 → `av`; ⌃⌥⌘3 → `avt`. Reassign a combo in Settings → confirm old key stops, new key works (app re-registered from the config watch).
Expected: hotkeys run un-nest from the Timeline without focusing the plugin.

- [ ] **Step 4: Commit** (docs/changelog only if applicable)

```bash
git add -A
git commit -m "docs(unnest): record hotkey defaults + install/re-grant steps"
```

---

## Self-review notes

- **Spec coverage:** Phase 1 = §"Phase 1"; Phase 2 = §"Phase 2"; Phase 3 endpoints/Swift/config/capture = §"Phase 3". Fallback for text detection = Task 1.1/1.2. `hotkeys.json` outside bundle = Task 3.1. Re-sign/re-grant = Task 3.5.
- **Naming consistency:** `isVideoLikeClip`, `runMode`, `pollTrigger`, `captureCombo`, `comboLabel`, `readHotkeys`, `/unnest/{trigger,poll,hotkeys}` used consistently across tasks.
- **Known risk:** exact UXP component/text API names in 1.2 (`clipHasText`) are filled from the 1.1 probe; if the probe shows text is unreadable, `UNNEST_TEXT_DETECTION` stays false and the fallback rule ships (documented, acceptable per spec).
