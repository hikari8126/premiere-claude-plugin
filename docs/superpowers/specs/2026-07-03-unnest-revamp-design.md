# Un-nest Revamp — Design

Date: 2026-07-03
Area: Un-nest feature — `plugin/index.html`, `plugin/main.js`, `plugin/styles.css`,
`bridge/server.js`, `bridge-app/main.swift`, plus app rebuild/re-sign.

## Problem

The Un-nest feature currently has three shortcomings:

1. The **"Chỉ bung clip"** (video-only) mode still expands *every* visual element,
   including titles/text graphics. The user wants it to expand only **video-type
   elements** (video footage, nested sequences, After Effects dynamic-link comps,
   motion-graphics) and to **exclude text/title graphics**.
2. Un-nest occupies a **top-level tab** (peer to Autocut / Voice Gen / Tạo Sub),
   overweighting a utility function.
3. Running it is inconvenient — the user wants **global keyboard shortcuts** (one per
   mode) so that, with a nested clip selected on the Timeline, a keypress runs it
   immediately.

## Constraints (established during brainstorming)

- **UXP plugins receive key events only when their panel is focused.** A plugin cannot
  register OS-global hotkeys nor inject commands into Premiere's Keyboard Shortcuts
  editor. Global hotkeys must be owned by the **Swift host app** (`Claude Bridge.app`),
  which has a run loop and Accessibility permission.
- **Editing files inside `Claude Bridge.app` breaks its ad-hoc code seal.** Any change to
  `main.swift` or the bundled `server.js` requires a rebuild via `bridge-app/build-app.sh`
  (which re-signs ad-hoc) and a **re-grant of Accessibility** (bundle identity changes).
- **Config must NOT live inside the app bundle** (would break the seal on every edit).
  Shared config lives at `~/Library/Application Support/ClaudeBridge/hotkeys.json`.

## Goal

Un-nest becomes a compact, optional utility: video-aware expansion, tucked into Settings,
and driven by three user-assignable global shortcuts.

---

## Design

### Component overview

```
Keypress (anywhere)
  → macOS
  → Claude Bridge.app  (Carbon RegisterEventHotKey, 3 hotkeys)
  → POST http://localhost:3030/unnest/trigger { mode }
  → node bridge stores a one-shot pending trigger
  → plugin polls GET /unnest/poll  (~400ms, runs regardless of active tab)
  → plugin detects the CURRENT timeline selection and runs un-nest for that mode
  → clears the trigger
```

```
Hotkey config:
  plugin Settings → Un-nest  (click-to-capture recorder)
  → POST /unnest/hotkeys { video, av, avt }
  → node writes ~/Library/Application Support/ClaudeBridge/hotkeys.json
  → Claude Bridge.app watches the file → unregister old + register new
```

### Phase 1 — "Video-only" element filter

Only the first mode changes. Rename option **"Chỉ bung clip"** → **"Chỉ element video"**
(label: "chỉ element video — bỏ text / title"). Modes `av` and `avt` are unchanged.

Add a predicate `isVideoLikeClip(clip)` applied inside `collectCutRangeItems()` when
`mode === 'video'` (and in the legacy `expandOne` video loop, for parity):

- **KEEP:** nested sequences (`ClipProjectItem.isSequence()`), clips backed by a real
  media file (video/image), After Effects dynamic-link comps (media path present,
  non-audio), and motion-graphics/mogrt that contain **no text**.
- **DROP:** Titles, Captions, and mogrt/graphics that **contain text**.

**Text detection (feasibility risk — must be validated first):**

1. **Probe step (implementation task 0):** write a throwaway probe that, for a selected
   graphic/mogrt track item, tries to read a component/graphic/source-text chain via the
   UXP DOM (e.g. component chain → look for a text/Source-Text component). Confirm what is
   actually exposed on the installed Premiere build before committing to a detection path.
2. **If text layers ARE readable:** classify a clip as text-graphic when it exposes a text
   component with non-empty text → DROP; keep animated/graphic mogrt with no text.
3. **If NOT readable (fallback, documented as acceptable):** DROP every synthetic graphic
   (no media file path: Titles, Graphics, mogrt, Color Matte, Adjustment Layer); KEEP
   media-backed clips + nested sequences + dynamic-link comps. This is coarser (drops
   text-free mogrt too) but deterministic. The chosen branch is logged to the panel so the
   user knows which rule ran.

Classification helpers reuse existing patterns: `asClipPI()`, `isSequence()`, and a new
`clipMediaPath(projItem)` / `clipHasText(trackItem)`.

### Phase 2 — Move Un-nest into Settings

- **Remove** the top-level `UN-NEST` tab: delete its `.tab-btn[data-tab="unnest"]`
  ([index.html:33](../../../plugin/index.html)) and the `#tab-unnest` panel; drop the
  tab-open detect hook.
- **Add** a Settings sub-tab **"Un-nest"** in the ⚙ Settings modal, alongside General /
  Voice Gen ([index.html:116](../../../plugin/index.html)). Its content:
  - 3 mode rows (radio): **Chỉ element video** / **Clip + audio** / **Clip + audio + text**.
    Each row shows its currently-bound shortcut and a click-to-capture control (Phase 3).
  - **"Tắt clip gốc sau khi bung"** toggle (kept from current UI).
  - **"Chạy trên clip đang chọn"** button — runs the selected mode manually.
  - The existing log area.
- **Global trigger poll:** the current poll is gated by `tabActive()`. Split it:
  - The `/unnest/poll` trigger loop runs **always** (module init), independent of any tab,
    so hotkeys work from anywhere.
  - The selection-fingerprint detect (for manual-run UI state) runs only while the Un-nest
    settings sub-tab is visible.
- Core expansion logic (`copyPasteOne`, condition-based waiting, paste verify + retry) is
  unchanged. Styles move from the old tab rules into Settings-scoped rules.

### Phase 3 — Global hotkeys (native Swift, assignable in-plugin)

**`bridge/server.js`** — three new endpoints (no auth, localhost-only, same as others):

| Endpoint | Method | Behavior |
|----------|--------|----------|
| `/unnest/trigger` | POST | Body `{ mode: 'video'\|'av'\|'avt' }`. Stores a one-shot pending trigger `{ mode, ts }`. Called by the Swift app on hotkey. |
| `/unnest/poll` | GET | Returns `{ pending: {mode} \| null }` and clears it. Polled by the plugin. |
| `/unnest/hotkeys` | GET / POST | GET returns the saved combos; POST `{ video, av, avt }` writes `~/Library/Application Support/ClaudeBridge/hotkeys.json`. |

Pending trigger is in-memory and one-shot (consumed by first poll) to avoid replay. If two
triggers arrive before a poll, last-wins (a single un-nest run per keypress is intended).

**`bridge-app/main.swift`** — on `applicationDidFinishLaunching`:
- Read `hotkeys.json` (defaults ⌃⌥⌘1 / ⌃⌥⌘2 / ⌃⌥⌘3 if missing).
- Register 3 hotkeys via Carbon `RegisterEventHotKey` (needs a Carbon event handler; the
  app already runs an NSApplication run loop).
- On fire → `POST http://localhost:3030/unnest/trigger` with the mode for that hotkey.
- Watch `hotkeys.json` (DispatchSource file watch, or 2s poll) → `UnregisterEventHotKey`
  the old set and re-register on change.

**Hotkey config UX (click-to-capture, like Premiere's shortcut panel):**
- Each mode row has a shortcut field. Click it → field enters "listening" state
  ("Bấm tổ hợp phím…"). The next `keydown` (while the Settings panel is focused, so the
  plugin receives it) is captured: record `event.code` (e.g. `"Digit1"`, `"KeyK"`) plus
  the modifier flags (cmd/opt/ctrl/shift). `Esc` cancels; a modifier-only press is ignored.
- Display a human label (e.g. `⌃⌥⌘1`); persist and POST to `/unnest/hotkeys`.
- **Config format** (portable across the JS→Swift boundary):
  ```json
  { "video": { "code": "Digit1", "cmd": true, "opt": true, "ctrl": true, "shift": false },
    "av":    { "code": "Digit2", ... },
    "avt":   { "code": "Digit3", ... } }
  ```
  The Swift side maps `code` → macOS virtual keycode (kVK_* table) and the flags →
  Carbon modifier mask. Storing `code` (not the printable char) keeps the mapping
  layout-independent.
- Validation: warn (non-blocking) if a combo has no non-modifier key, or duplicates another
  mode's combo. Conflicts with Premiere/macOS shortcuts are the user's responsibility
  (documented).

**Build & install:** run `bridge-app/build-app.sh` (compiles `main.swift`, bundles the new
`server.js`, ad-hoc signs) → install `Claude Bridge.app` to `/Applications` → re-grant
Accessibility (bundle identity changed) → relaunch. This replaces the earlier hand-patch of
the bundle and keeps a valid seal.

---

## Data / state summary

- **Pending trigger:** in-memory in node, one-shot.
- **Hotkeys config:** `~/Library/Application Support/ClaudeBridge/hotkeys.json`, written by
  node, read+watched by the Swift app. Never inside the app bundle.
- **"disable original" + selected mode:** plugin localStorage (as today).

## Error handling

- **Bridge offline / poll fails:** plugin poll silently retries; no user noise.
- **Hotkey fires but nothing selected / no nested in selection:** the existing detect path
  logs "không có nested trong vùng chọn"; no-op.
- **Paste doesn't land:** unchanged — existing verify + 3× retry, then the actionable
  Track-Targeting/focus error.
- **Text-detection API absent:** fall back to the coarse rule and log which rule ran.
- **hotkeys.json unreadable/corrupt:** Swift app falls back to defaults and logs.

## Testing

- **Phase 1:** on a nested seq containing footage + a title + a text mogrt + (if possible)
  a text-free mogrt, run `video` mode → footage/nested kept, title + text mogrt dropped;
  verify the fallback branch on a build where text isn't readable.
- **Phase 2:** UN-NEST tab gone; Settings → Un-nest runs manually; trigger poll works from
  the Autocut tab (proves it's not tab-gated).
- **Phase 3:** assign a combo via click-to-capture; confirm `hotkeys.json` written;
  confirm the Swift app re-registers; press the key with Timeline focused → un-nest runs;
  reassign → old combo stops, new works.

## Out of scope

- The **boundary-overflow** bug (native copy takes whole clips; `earliest=0` shifts the
  block before `parentStart`) — tracked separately.
- Changes to `av` / `avt` modes.
- Windows support (hotkeys + AppleScript path are macOS-only, as today).
- Conflict-checking against Premiere's own keyboard map.

## Implementation phases (independent, in order)

1. **Phase 1** (plugin-only, no rebuild): video-only filter + probe + fallback. Shippable
   alone via External-folder sync.
2. **Phase 2** (plugin-only, no rebuild): move UI to Settings, ungate the trigger poll
   (poll endpoints can no-op until Phase 3 bridge lands).
3. **Phase 3** (bridge + Swift app + rebuild + re-sign + re-grant Accessibility): endpoints,
   Carbon hotkeys, click-to-capture config.
