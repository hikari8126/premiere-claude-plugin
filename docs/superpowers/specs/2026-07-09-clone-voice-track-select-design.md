# Clone Voice — select source audio track — Design

Date: 2026-07-09
Area: Voice Gen → Create → Clone Voice, Step 1 "Choose audio source".
Files: `plugin/index.html` (`#vcFromSeqSection` markup), `plugin/main.js`
(Voice Create module — the `vcSource` radio wiring + the `vcGetClip` extract handler),
`plugin/styles.css`.

## Problem

Cloning a voice "From Timeline" always reads audio track index 0 (A1): the extract
handler (`vcGetClip` click) grabs `seq.getAudioTrack(0)` / trackGroup `getTrack(0)`
([main.js:7213](plugin/main.js:7213), [main.js:7224](plugin/main.js:7224)), and the UI is
labelled "A1". The user wants to choose which existing audio track to clone from.

## Goal

Let the user pick a single existing audio track (default the first non-empty one) as the
source for Clone Voice, instead of always A1. Only tracks that actually have clips are
offered.

## Decisions (from brainstorming)

- **Single track** selection (not multi-combine).
- Dropdown lists **only non-empty** audio tracks, with clip counts; default = first
  non-empty. Real track labels (`A1`, `A3`, …) — numbering may skip.
- **No persistence** — the list rebuilds when the Clone source step is shown and defaults
  to the first non-empty track (track layout is project-specific).

## UI (`#vcFromSeqSection`, Clone Step 1)

- Rename the segment radio label **"From Timeline A1" → "From Timeline"**
  ([index.html:484](plugin/index.html:484)).
- Add a track dropdown inside `#vcFromSeqSection`, above the extract button:
  a toggle button `#vcTrackSelBtn` showing the current pick (e.g. `Track: A1 (3 clip)  ▾`)
  and a panel `#vcTrackSelPanel` listing one row per non-empty track (`A1 (3 clip)`).
  Clicking a row selects that track and closes the panel.
- Built as a **custom toggle-dropdown** (not a native `<select>` — unreliable in UXP),
  mirroring the existing dropdown/panel pattern (`vg-namePanel` / `vg-nameRow`).
- The extract button `#vcGetClip` label and `#vcClipInfo` text are **dynamic**:
  `Extract audio from {label}` and `Grabs every clip on audio track {label} and joins
  them into one voice sample.`
- **Empty state:** if no audio track has clips → the dropdown shows `(không có clip audio)`,
  and `#vcGetClip` is disabled (`aria-disabled` + a `.is-disabled` class) with info text
  `Không có clip audio nào trên timeline.`

## Logic (main.js, Voice Create module)

- New state: `var vcSelectedTrackIdx = 0;` (0-based track index) and
  `var vcTrackList = [];` (cached `[{ index, label, count }]`).
- `async function vcListAudioTracks()`: get `seq = await getActiveSequence()`; read
  `cnt = await un(seq.getAudioTrackCount())`; for `i` in `0..cnt-1`, get the track (await),
  `items = await getClipItems(track)`; if `items.length > 0` push
  `{ index: i, label: 'A' + (i + 1), count: items.length }`. Returns the array (empty if
  none / no sequence). Fail-safe: wrap per-track reads in try/catch.
- `async function vcRefreshTrackList()`: `vcTrackList = await vcListAudioTracks()`; if the
  current `vcSelectedTrackIdx` is not among the listed indices, reset it to the first
  listed track's index (or leave 0 if list empty); then `vcRenderTrackSel()`.
- `function vcRenderTrackSel()`: update the toggle button label to the selected track's
  `label (count clip)` or `(không có clip audio)`; rebuild the panel rows; enable/disable
  `#vcGetClip`; update `#vcClipInfo` and the button caption to the selected label.
- Rebuild triggers: call `vcRefreshTrackList()` when the Clone method is selected
  (`vcSelectMethod('clone')`) and when the `vcSource` radio switches to `sequence`
  ([main.js:7184](plugin/main.js:7184)), so the list reflects the current timeline.
- In the `vcGetClip` extract handler, replace the hardcoded `0`:
  - trackGroup path: `aGroup.getTrack(vcSelectedTrackIdx)`.
  - getAudioTrack path: `seq.getAudioTrack(vcSelectedTrackIdx)`.
  - Guard: if `aGroup.numTracks <= vcSelectedTrackIdx` fall through to the getAudioTrack
    path (as today). Error/status strings use the selected label instead of "A1".

## Panel behavior

- The track panel toggles open/closed on the button; opening it does not affect the
  file-source section. Selecting a row sets `vcSelectedTrackIdx`, calls
  `vcRenderTrackSel()`, and closes the panel. Re-extraction still clears the sample and
  collapses Steps 2 & 3 (existing `vcRefreshCloneSteps()` — unchanged).

## Error handling

- No active sequence / no audio tracks → empty list, disabled extract, info message; no
  crash.
- A track read failing mid-scan → that track is skipped (try/catch), others still listed.
- Selected track has no clips at extract time (edge: clips deleted after listing) → the
  existing "No clips on audio track {label}" error path fires.

## Out of scope

- Multi-track combine (single-select chosen).
- The "From File" source path (unchanged).
- The ElevenLabs clone request payload / Steps 2–3 (unchanged).
- Persisting the track choice across sessions.

## Testing (manual, Premiere 25+)

1. Timeline with clips on A1 and A3 (A2 empty) → open Create → Clone Voice → From Timeline:
   dropdown lists `A1 (n clip)` and `A3 (n clip)` only; default A1; button reads "Extract
   audio from A1".
2. Pick A3 → button/info update to A3; Extract → sample built from A3's clips; clone flow
   proceeds.
3. Timeline with no audio clips → dropdown shows `(không có clip audio)`, Extract disabled.
4. Switch source to "From File" and back → track list refreshes; From File still works.
