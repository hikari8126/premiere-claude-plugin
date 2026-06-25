# Clone Voice UX Redesign — Design

Date: 2026-06-25
Area: Voice Gen tab → "Create Voice" mode (`plugin/index.html`, `plugin/main.js`, `plugin/styles.css`)

## Problem

The current "Create Voice" flow is hard to follow:
- A disabled-by-default `<select id="vcType">` (Clone / Design) hides the form until the
  user opens it; the two options are never explained.
- Fields appear in a flat list with no order or guidance.
- The extract button reads "Extract A1 Clips" — unclear what it does or where audio comes from.

This redesign only covers the Create Voice area. It does not touch the bridge or the
existing Gen Voice / SFX / Music flows. Wording stays in English.

## Goal

A guided, progressive flow where the next action only appears once the current one is done.

## Design

### 1. Method picker → two choice cards

Replace `<select id="vcType">` with two clickable cards:

- **Clone Voice** — "Copy an existing voice from your audio"
- **Design Voice** — "Generate a new voice from a description"

Clicking a card highlights it (accent border + tint) and shows its section
(`#vcCloneSection` / `#vcDesignSection`). No card selected on load → both sections hidden,
matching today's "choose method first" behavior.

### 2. Clone = 3-step progressive disclosure

A small state machine driven by whether an audio sample exists (`vcSelectedFilePath`):

- **Step 1 — Source + Extract**
  - Segmented tabs: `From Timeline A1` / `From File`.
  - Timeline tab → big primary button **"⬇ Extract audio from Timeline A1"** + helper line
    "Grabs every clip on audio track A1 and joins them into one voice sample."
  - File tab → button **"📂 Browse audio file"**.
- **Step 2 — Audio ready** (hidden until a sample exists)
  - Result row: ✓ `filename` · `N clips` · `duration` (duration shown when available;
    clip count only for the timeline path).
  - Secondary button **"↻ Re-extract"** (timeline) / **"Change file"** (file).
  - Green button **"🎙 Clone this voice"**.
  - No audio preview / play button (explicitly out of scope).
- **Step 3 — Details** (hidden until "Clone this voice" is clicked)
  - **Voice Name** (required), **Description** (optional), **Remove background noise** checkbox.
  - Primary button **"✓ Create Voice"** → existing `/voice/clone` call.
  - Empty name → inline error via existing `showVcStatus`.

**Reset rules:** switching the source tab, or clicking Re-extract / Change file, clears
`vcSelectedFilePath` and collapses Steps 2 and 3 back to Step 1, so a stale sample or a
half-open name form never lingers.

Both source paths (Timeline and File) follow the identical Step 1 → 2 → 3 progression.

### 3. Design Voice

Functionally unchanged. Lives under the "Design Voice" card and adopts the new card/section
styling for consistency.

## UXP constraints honored

- Show/hide via the `hidden` attribute and `style.display`, not `position:fixed`/`z-index`.
- No `display:grid` (use flex), no `new Audio()` (no preview added), no `title=""`.
- Keyboard claim/release already wired on the existing inputs; reused as-is.

## Touch points

- `plugin/index.html` (~400–510): rebuild the `.vc-panel` markup — cards, segmented tabs,
  result row, Step 2/3 containers with `hidden`.
- `plugin/main.js` (~6670–6883): drop the `vcType` dropdown listener; add card switching and
  a `vcSetCloneStep()` helper that reveals Step 2 after extract/browse and Step 3 after
  "Clone this voice". Reuse the existing extract, browse, and clone-submit logic unchanged.
- `plugin/styles.css`: add classes for `.vc-choiceCard`, segmented tabs, result row, big buttons.
- Version bump 4.8.4 → 4.8.5 (`manifest.json` + `PLUGIN_VERSION` in `main.js`).

## Out of scope

- Bridge / `/voice/clone` / `/tts/concat-from-sequence` changes.
- Audio preview playback.
- The two already-shipped fixes in this session (matched-source path line; back-to-block button).
