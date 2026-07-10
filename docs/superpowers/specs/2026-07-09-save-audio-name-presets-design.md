# Save-audio name history & presets — design

**Date:** 2026-07-09
**Area:** Voice Gen tab → "Lưu audio" save modal
**Files:** `plugin/index.html` (modal markup), `plugin/main.js` (`promptSaveLocation`), `plugin/styles.css`

## Problem

The "Lưu audio" dialog only pre-fills a single suggested filename and remembers the
destination folder. There is no way to recall previously-used names or reuse a saved
name template, so the user retypes similar names (`v84.2 K17 Applovin.mp3`, …) each time.

## Goal

1. Smart default suggested name: `v{lastVersion} - {currentVoiceName}` (e.g. `v14.3 - Evelyn`).
2. A **Save preset** button that stores the current name field verbatim.
3. A **Recent** dropdown of the last 5 saved filenames.
4. A **Preset** dropdown of saved names.

## Behavior

### Default suggested name
On modal open, override the passed suggestion and pre-fill:
```
v{lastVersion} - {vgVoiceName()}{ext}
```
- `lastVersion`: remembered exact string from the previous save (e.g. `14.3`); fallback `1.0`.
- `vgVoiceName()`: live current voice name (auto), existing helper at `main.js:5832`.
- `ext`: extension carried from the caller's suggested name (default `.mp3`).

### On successful save (`okB.onclick`)
- Parse version via `/^v\s*([0-9]+(?:\.[0-9x]+)?)/i` → persist to `vg_last_version`.
- Prepend the final filename to `vg_recent_names`, dedup, cap at 5.

### Save preset button
- Stores current name-field text into `vg_name_presets` as a flat, de-duplicated list
  (saving an existing name is a no-op). Refreshes the Preset panel.

### Dropdowns
- Built as custom toggle-panels (same pattern as `renderVoiceDrop`), NOT native `<select>`
  — native selects render unreliably in UXP and would punch through the modal.
- **Recent**: click a row → fills name field.
- **Preset**: click a row → fills name field; each row has an `×` to delete that preset.
- Only one panel open at a time; opening one closes the other.

## Storage (localStorage, `vg_*` convention)

| Key | Value |
|---|---|
| `vg_last_version` | string, e.g. `"14.3"` |
| `vg_recent_names` | JSON array, ≤5 full filenames, newest first |
| `vg_name_presets` | JSON array of full filename strings |

All reads tolerate missing / malformed JSON (try/catch → `[]`).

## UI layout

New row under the "Tên file" input inside `#vgSaveModal`:
```
[🕘 Gần đây ▾]   [⭐ Preset ▾]   [💾 Lưu preset]
```
Panels render inline below the row (absolute-position avoided per UXP constraints;
use normal flow so the modal box grows).

## Out of scope
- No bridge/server changes.
- No template variables beyond version + voice (YAGNI).
- Presets are global (not per-voice).

## Test / verification
No automated test harness for UXP UI. Verify manually in Premiere:
1. Open Save modal → default reads `v{lastVersion} - {voice}`.
2. Save → reopen → version remembered, name appears in Recent.
3. Save preset → appears in Preset panel; picking fills field; `×` deletes.
