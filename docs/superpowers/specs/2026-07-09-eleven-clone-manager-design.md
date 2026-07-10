# Manage cloned voices (ElevenLabs) — Design

Date: 2026-07-09
Area: Voice Gen → Settings modal, Voice Gen tab (`data-stab="voicegen"`).
Files: `plugin/manifest.json` (network domain), `plugin/index.html` (settings section),
`plugin/main.js` (fetch + UI), `plugin/styles.css`.

## Problem

Users can't see how many clone slots their current ElevenLabs account has used (to know
when it's full), and can't delete cloned voices without leaving Premiere for the
ElevenLabs website.

## Goal

In Settings → Voice Gen, show `X / Y` clone slots used for the **current API account**
and let the user delete custom voices (multi-select, confirmed) directly from the plugin.

## Decisions (from brainstorming)

- **Direct ElevenLabs calls from the plugin** (not new bridge endpoints), to avoid the
  `Claude Bridge.app` re-seal. Add `https://api.elevenlabs.io` to
  `manifest.json → requiredPermissions.network.domains`. Plugin-only change; reload the
  plugin, no bridge rebuild.
- Placement: **Settings → Voice Gen tab**, a new section below the API-key controls.
- Delete: **multi-select + one confirm**, custom voices only (premade never listed).
- Count: **X = custom voices** (category ≠ `premade`), **Y = `subscription.voice_limit`**.
- "Current account" = whatever `ELEVENLABS_KEY` currently holds (it already tracks the
  active profile).

## ElevenLabs endpoints (direct, header `xi-api-key: <ELEVENLABS_KEY>`)

- `GET https://api.elevenlabs.io/v1/user/subscription` → read `voice_limit`.
- `GET https://api.elevenlabs.io/v1/voices` → `voices[]` with `voice_id`, `name`,
  `category` (`premade` | `cloned` | `generated` | `professional` | …).
- `DELETE https://api.elevenlabs.io/v1/voices/{voice_id}` → delete one voice.

All via UXP `fetch(url, { method, headers: { 'xi-api-key': ELEVENLABS_KEY, 'Accept':
'application/json' } })`. Custom voices = `voices.filter(v => v.category !== 'premade')`.

## UI (new section in the Voice Gen settings panel)

Titled **"Voice clone (ElevenLabs)"**, below the API-key row:

- **Slot line:** `Đã dùng X / Y slot clone` + a ↻ refresh button. When `X >= Y`, add a
  `.is-full` warning style (e.g. red) and append ` — ĐẦY`. While loading show `Đang tải…`;
  on error show `Không đọc được (kiểm tra API key)`.
- **Search box** (`#elvVoiceSearch`) — filters the list by name. Rows are **pre-rendered
  once and filtered by toggling `display`** (never rebuild `innerHTML` on keystroke), so
  Vietnamese IME input isn't swallowed and clicks don't detach rows (same pattern as the
  un-nest exclude fix).
- **List** (`#elvVoiceList`) — one row per custom voice: a checkbox + the voice name + a
  small category tag. Scrollable, capped height.
- **Action row:** `Xoá đã chọn (n)` button (`#elvDeleteBtn`), disabled when `n === 0`.
  Clicking → `confirm`-style prompt is NOT available in UXP; instead show an inline
  **two-step confirm**: first click turns the button into `Xác nhận xoá n voice?` (armed,
  red) for ~4s; a second click within that window performs the delete. (Matches the
  no-`alert()`/no-`confirm()` UXP constraint.)

## Data flow

- `elvFetchState()` — fetch subscription + voices in parallel; compute `custom` list and
  `voiceLimit`; store in module state `elvVoices` (`[{id, name, category}]`) and
  `elvLimit`. Called when the Voice Gen settings tab opens and on ↻ refresh.
- `elvRenderSlots()` — update the slot line + full/warn state.
- `elvBuildRows()` / `elvFilterRows(query)` — build checkbox rows once, filter by display.
- Selection tracked in an `elvSelected` set (voice_id → 1), toggled by row checkbox;
  updates the `Xoá đã chọn (n)` label + enabled state.
- `elvDeleteSelected()` — sequentially `DELETE` each selected id; collect successes and
  failures; then `elvFetchState()` (refresh count/list) and `loadVoices()` (refresh the
  main Voice dropdown so deleted voices disappear). Show a status line
  `Đã xoá N • Lỗi M` if any failed.

## Error handling

- No/empty `ELEVENLABS_KEY` → slot line `Chưa có API key`, list empty, delete disabled.
- Subscription/voices fetch fails (network / 401) → slot line `Không đọc được (kiểm tra
  API key)`, list empty.
- A `DELETE` fails (e.g. library/non-owned voice, or 4xx) → that voice is counted in `M`
  (failures), remains in the list after refresh; other deletions still proceed.
- Deletes run sequentially (one request at a time) to keep it simple and avoid rate
  spikes.

## Out of scope

- Adding bridge endpoints (direct-call approach chosen).
- Editing voices, renaming, sharing, or library management.
- Changing how voices are cloned or how the main voice list is loaded (only calls
  `loadVoices()` to refresh after delete).
- A per-voice usage/character breakdown.

## Testing (manual, Premiere 25+, real ElevenLabs key)

1. Settings → Voice Gen: slot line shows `X / Y` matching the ElevenLabs dashboard; ↻
   refresh updates it.
2. With slots full (X ≥ Y): line shows the warning style + `ĐẦY`.
3. Search a partial voice name → list narrows; Vietnamese typing not swallowed; panel/tab
   stays put.
4. Tick 2 voices → `Xoá đã chọn (2)` → arm → confirm → both deleted on ElevenLabs (verify
   on dashboard); count drops; they vanish from the main Voice dropdown.
5. Bad API key → slot line shows the error message; list empty; delete disabled.
6. Try deleting a non-owned/library voice → reported as a failure, others still deleted.
