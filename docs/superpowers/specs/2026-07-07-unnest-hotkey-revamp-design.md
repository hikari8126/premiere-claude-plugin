# Un-nest Hotkey Revamp — Design

Date: 2026-07-07
Scope: fix + extend the Un-nest global-hotkey binding across the three layers
(UXP plugin, Node bridge, Swift host app).

## Problem

1. **Capture broken on Premiere 2025** — double-clicking a shortcut chip to bind a
   combo does not register keystrokes. Root cause: `captureCombo` in
   `plugin/main.js` listens for `keydown` but never calls `window.claimKeyboard()`,
   so on UXP (Premiere 25+) Premiere swallows the keys before the panel sees them.
2. **Combos only** — binding requires at least one of ⌘/⌥/⌃. Users want to bind a
   single key.
3. **No conflict feedback** — a bound key may collide with a Premiere keyboard
   shortcut (especially single keys), silently shadowing editing behaviour while
   the app runs.

## Architecture (unchanged)

Swift app registers Carbon global hotkeys → `POST /unnest/trigger` → bridge stores
one-shot pending → plugin polls `GET /unnest/poll` (400 ms) → runs un-nest.
Combos are stored in `~/Library/Application Support/ClaudeBridge/hotkeys.json`
(written by plugin `POST /unnest/hotkeys`, watched by the Swift app every 2 s).

## Design

### Part 1 — Fix capture (plugin)
`captureCombo` (`plugin/main.js`): call `window.claimKeyboard()` when entering the
listening state; call `window.releaseKeyboard()` inside `cleanup()` (covers Escape,
successful capture, and blur). Mirrors the existing pattern used by textareas and
the voice dropdown.

### Part 2 — Allow single-key binding
Remove the mandatory-modifier guards at two layers:
- Plugin `captureCombo`: drop the `if (!(cfg.cmd||cfg.opt||cfg.ctrl)) { … 'Cần ⌘/⌥/⌃'; return; }`
  branch so a bare key is accepted and saved.
- Swift `reloadAndRegister` (`bridge-app/main.swift`): drop `if mods == 0 { continue }`
  so `RegisterEventHotKey(kc, 0, …)` registers a modifier-less global hotkey.

Escape still cancels; modifier-only presses still ignored (wait for a real key).

### Part 3 — Premiere-shortcut conflict warning (read real .kys)
**Bridge — new `GET /unnest/premiere-shortcuts`:**
- Resolve the keymap source in order:
  1. Newest-mtime `~/Documents/Adobe/Premiere Pro/*/Profile-*/Mac/*.kys` (user's
     active custom keymap).
  2. **Fallback — bundled default** when no custom file exists:
     `/Applications/Adobe Premiere Pro */…/Contents/Keyboard Shortcuts/<locale>/Adobe Premiere Pro Defaults.kys`,
     preferring locale `en`, from the highest Premiere version folder. (Shortcuts /
     virtualkeys are identical across locales; only display names differ.)
  3. None found → empty list.
- Response includes `source: "custom" | "default" | "none"` so the plugin can note
  which keymap it compared against.
- Parse XML `<item.N>` blocks → `{ char, cmd, opt, shift, ctrl, commandname, context }`.
  - `char`: decode `virtualkey`. Adobe encodes character keys as `0x80000000 | ASCII`
    (verified: `V`=2147483734=`0x80000056`, `C`=Razor, `B`=Ripple, digits, punctuation).
    `char = String.fromCharCode(vk - 0x80000000)` when `vk >= 0x80000000` and the
    result is printable ASCII; otherwise skip the entry (no false warnings — covers
    F-keys / arrows / numpad which use a different low-number scheme).
  - `context`: from the enclosing `<context.*>` tag.
- Cache parsed result keyed by file path + mtime; re-parse only when mtime changes.
- No `.kys` found → return `{ ok: true, shortcuts: [] }` (conflict check disabled).

**Plugin:**
- On opening the Un-nest tab, fetch `/unnest/premiere-shortcuts` (cache in memory).
- After each bind/clear, and on initial load, compare each mode's combo against the
  list: match = same `char` (from `KeyboardEvent.code`: `KeyV`→`V`, `Digit1`→`1`,
  known punctuation codes) AND identical cmd/opt/shift/ctrl booleans. Match scope =
  **all contexts**.
- On match: render a **⚠** marker next to the chip. Hover → custom tooltip (UXP has
  no `title=""`; reuse the absolute-positioned popup approach already in the file)
  listing the colliding Premiere command(s), shown as a friendly label derived from
  `commandname` (e.g. `cmd.tools.06razor` → "Razor Tool") plus context; fall back to
  the raw `commandname` when unmapped.

### Code→char mapping (plugin side)
- `KeyA`–`KeyZ` → that uppercase letter.
- `Digit0`–`Digit9` → that digit char.
- A small punctuation table for common bindable keys (`Minus`→`-`, `Equal`→`=`,
  `Slash`→`/`, `Backquote`→`` ` ``, etc.). Unmapped code → no conflict check.

## Non-goals / limitations
- Only the active `[Custom].kys` is read; a pristine "Default" layout with no custom
  file yields no warnings.
- F-keys, arrows, numpad, and non-ASCII keys are not conflict-checked.
- The warning is informational only — it does not block binding or unregister the key.

## Testing
- Manual (requires Premiere 2025): bind a single key `V` → capture works, ⚠ appears,
  hover shows "Selection Tool / Razor…"; bind `⌃⌥⌘1` → no warning; clear → ⚠ gone.
- Bridge parser: unit-check decode of known virtualkeys (`0x80000056`→`V`) and
  graceful empty result when no `.kys` present.
