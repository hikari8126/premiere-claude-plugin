# Un-nest — clamp overflow to 2s — Design

Date: 2026-07-09
Area: Un-nest expansion — `plugin/main.js` (`expandViaClone`).
Related: [2026-07-03-unnest-revamp-design.md](2026-07-03-unnest-revamp-design.md)
(this addresses the "boundary-overflow" item listed there as out-of-scope).

## Problem

After un-nesting, `expandViaClone` clones each inner clip **whole** (full source
length, effects preserved) so nothing gets cut. Clips whose head/tail extend past the
nested region therefore **overflow** both boundaries. Some elements overflow far more
than needed, cluttering the timeline. The user wants the overflow **capped at 2
seconds** on each side of the region.

Additionally, when a clip's head extends before timeline 0, the current placement
(`TT` uses `Math.max(0, s)`) forces the clone to start at 0 **without trimming its
content**, so the clip is **pushed forward** and loses alignment with sibling clips.

## Goal

Cap each cloned element's overflow to 2s before the region start and 2s after the
region end, across all modes (`video` / `av` / `avt`) and all element types (video,
audio, text). When the region starts less than 2s from timeline 0, trim the head at
timeline 0 (pad < 2s) so clips stay frame-aligned instead of being shifted.

## Constants

- `UNNEST_PAD = 2.0` — seconds, fixed in code.

## Clamp rule

Every cloned clip already overlaps `[nestIn, nestOut]` (filtered by `inRange`), so only
its head (before the region) and/or tail (after) can overflow. On the parent timeline,
with `winStart = parentStart` and `winEnd = parentStart + (nestOut − nestIn)`:

```
Hlo = max(winStart − UNNEST_PAD, 0)   // head lower bound (never before timeline 0)
Hhi = winEnd + UNNEST_PAD              // tail upper bound
```

- **Tail trim** when `cloneEnd > Hhi`: reduce source outPoint by `cloneEnd − Hhi`;
  timeline end becomes `Hhi`, start unchanged.
- **Head trim** when `cloneStart < Hlo`: move start to `Hlo` **and** advance source
  inPoint by `Hlo − cloneStart` (drops early content, keeps remaining frames aligned).
- Clips already inside `[Hlo, Hhi]` are untouched.
- No clip is dropped: the clamped window always contains the in-region overlap, so
  clamped length ≥ overlap > EPS.

The `max(…, 0)` in `Hlo` is what implements the user's added condition: when
`winStart < 2`, the head is trimmed exactly at timeline 0 (pad shorter than 2s), and
because inPoint is advanced to match, the clip is **not** pushed forward — alignment
with siblings is preserved.

## Approach: clone-then-trim (two transactions)

1. **TX1 — clone whole** (unchanged): `createCloneTrackItemAction` as today, preserving
   effects. This keeps the working path untouched.
2. **Locate clones**: `createCloneTrackItemAction` does not return a handle. For each
   cloned target we know its target track (vIdx/aIdx) and expected timeline start
   `= timeOffset + sourceStart`. After TX1, scan that track for a clip whose start is
   within `EPS` of the expected value. This matches only our clones and never touches
   pre-existing clips on reused tracks (which may legitimately sit inside the pad zone).
3. **TX2 — trim overflow**: for each located clone that overflows `[Hlo, Hhi]`, apply
   head/tail trim. Runs in its own transaction (separate undo step); if it throws, the
   TX1 clones still stand.

Rejected alternative — *pre-trim source before clone, restore after*: mutates the
nested sequence mid-operation, needs restore-on-failure, and adds undo-history noise.
Clone-then-trim leaves the effects-preserving clone path intact.

## Probe (implementation task 0 — feasibility gate)

The un-nest code uses the Premiere 25+ `ppro.SequenceEditor` transaction API, not the
legacy `seq.videoTracks[].clips` DOM. Before implementing, a throwaway probe confirms,
on the installed build, which action trims a **placed track item**:

- **Tail**: `trackItem.createSetInOutPointsAction(inPt, outPt)` (reduce outPoint).
- **Head**: a start-move (`createMoveTrackItemAction`, or setting start) paired with an
  inPoint advance.

The probe result selects the exact calls. If no working trim action exists, take the
fallback below.

## Error handling / fallback

- **Trim action unavailable on this build**: skip trimming, keep the whole clone
  (current behavior), log `⚠ không trim được overflow (API n/a) — giữ nguyên độ dài`.
  Non-fatal.
- **Clone not found by start-match**: skip that clone, log, continue with the rest.
- **TX2 throws**: caught and logged; TX1 clones remain.

## Testing (manual, Premiere 25+)

1. Nested seq mid-timeline, a clip overflowing both ends >2s → run `video` / `av` /
   `avt`: clone head and tail trimmed to exactly 2s beyond the region; effects kept.
2. Nested seq starting <2s from timeline 0 → head trimmed at 0; clip stays aligned with
   sibling clips (no forward shift).
3. Clip already within ±2s of the region → untouched.
4. Reused track with a pre-existing clip sitting in the pad zone → that clip is NOT
   trimmed (only located clones are).

## Out of scope

- Making the pad configurable (fixed 2s).
- Any change to the whole-clip clone path, effects handling, mode filters, or hotkeys.
- Windows support.
