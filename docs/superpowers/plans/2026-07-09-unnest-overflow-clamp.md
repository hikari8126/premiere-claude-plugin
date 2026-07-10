# Un-nest Overflow Clamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After un-nesting, clamp each cloned element's timeline overflow to at most 2 seconds before/after the nested region, trimming the head at timeline 0 (keeping alignment) when the region starts less than 2s from the start.

**Architecture:** Keep the existing effects-preserving `createCloneTrackItemAction` clone (TX1) untouched. Add a second pass that locates each freshly-cloned track item by its expected start time and, in a separate transaction (TX2), trims any clone that overflows `[max(winStart−2,0), winEnd+2]`. A one-time runtime probe (Task 1) confirms which SequenceEditor action trims a placed track item on the installed Premiere build before the real edit is written.

**Tech Stack:** UXP plugin JavaScript (non-module `plugin/main.js`), Premiere 25+ `ppro.SequenceEditor` transaction API. No build step, no automated test framework — syntax checked with `node --check`, behavior verified manually in Premiere.

## Global Constraints

- Non-module script: no `import`/`export` in `plugin/main.js`.
- All Premiere API calls are async — wrap with the existing `await un(...)` / `await callSec(...)` helpers.
- UXP constraints: no `position:fixed`, `z-index`, `display:grid`, `new Audio()`.
- Fixed pad value: `UNNEST_PAD = 2.0` seconds (not configurable).
- Do not modify `Claude Bridge.app`, `bridge/server.js`, or `bridge-app/main.swift` — this is a plugin-only change (no rebuild / re-sign).
- Only touch `expandViaClone` and constants near it; do not change mode filters, `classifyVideoClip`, hotkeys, or the clone/effects path itself.
- Existing helpers available in the same scope: `un(v)`, `callSec(obj, method)`, `getClipItems(track)`, `getTimeSec(x)`, `secToTicks(s)`, `logLine(msg, level)`, `EPS = 0.0006`, `ppro`, and `TT(s) = ppro.TickTime.createWithSeconds(Math.max(0, s))` (defined locally inside `expandViaClone`).

---

### Task 1: Probe the trim API on the installed Premiere build

**Files:**
- Modify (temporary): `plugin/main.js` — add a throwaway `window.__unnestTrimProbe` function near `expandViaClone` (~line 8492, after the function).
- No test file (manual runtime probe).

**Interfaces:**
- Consumes: `ppro.SequenceEditor`, a selected timeline track item.
- Produces: a recorded decision (written as a comment block above `expandViaClone` in Task 2) naming the exact actions for TAIL trim and HEAD trim, or "unavailable".

**Why:** `createCloneTrackItemAction` returns no handle, and the code uses the new SequenceEditor API (not the legacy `seq.videoTracks[].clips` DOM at line 725). We must confirm, on the real build, which action trims a placed track item's tail and head before writing the edit.

- [ ] **Step 1: Add the probe function**

Add after `expandViaClone` closes (after line ~8492):

```javascript
// TEMP PROBE (Task 1) — remove after recording findings. Run from the UXP
// debug console with ONE clip selected on the timeline:  await window.__unnestTrimProbe()
window.__unnestTrimProbe = async function () {
  var out = { setInOut: false, move: false, methods: [] };
  try {
    var proj = await getActiveProject();
    var s = await un(proj.getActiveSequence ? proj.getActiveSequence() : null);
    var sel = await un(s.getSelection());
    var items = await un(sel.getTrackItems ? sel.getTrackItems() : sel);
    var it = (items && items.length) ? items[0] : null;
    if (!it) { console.log('[probe] select one clip first'); return out; }
    // Enumerate action factories present on the track item.
    for (var k in it) { if (typeof it[k] === 'function' && /create.*Action/i.test(k)) out.methods.push(k); }
    out.setInOut = typeof it.createSetInOutPointsAction === 'function';
    out.move     = typeof it.createMoveTrackItemAction === 'function';
    console.log('[probe] getInPoint/getOutPoint/getStartTime/getEndTime =',
      getTimeSec(await un(it.getInPoint())), getTimeSec(await un(it.getOutPoint())),
      getTimeSec(await un(it.getStartTime())), getTimeSec(await un(it.getEndTime())));
    console.log('[probe] action factories on track item:', out.methods.join(', '));
    console.log('[probe] createSetInOutPointsAction =', out.setInOut, '| createMoveTrackItemAction =', out.move);
  } catch (e) { console.log('[probe] error:', e.message || e); }
  return out;
};
```

- [ ] **Step 2: Syntax check**

Run: `cd plugin && node --check main.js`
Expected: no output (exit 0).

- [ ] **Step 3: Run the probe in Premiere**

Reload the plugin in UXP Developer Tool. Open a sequence, select ONE clip on the timeline, open the plugin's Debug console, and run:
`await window.__unnestTrimProbe()`

Record the console output:
- The list of `create…Action` factories on the track item.
- Whether `createSetInOutPointsAction` and `createMoveTrackItemAction` exist.
- Then, in the console, try a TAIL trim to confirm it visibly shortens the clip's end:
  ```javascript
  // adjust newOutSec to ~1s less than current outPoint
  var proj = await getActiveProject(); var s = await un(proj.getActiveSequence());
  var it = (await un((await un(s.getSelection())).getTrackItems()))[0];
  var inP = it.getInPoint(); var outP = it.getOutPoint();
  await proj.lockedAccess(function(){ proj.executeTransaction(function(a){
    a.addAction(it.createSetInOutPointsAction(inP, ppro.TickTime.createWithSeconds(getTimeSec(outP)-1)));
  }, 'probe tail'); });
  ```
  Note whether the clip's END moved left (tail trim works) and whether START stayed put.

- [ ] **Step 4: Record findings & decide**

Decide the implementation branch for Task 2 and note it (you will paste it as the comment in Task 2, Step 2):
- **TAIL:** if `createSetInOutPointsAction` shortens the end → use it (primary path).
- **HEAD:** if `createMoveTrackItemAction` exists AND moving start + advancing inPoint trims the left edge → use it; else HEAD trim is "unavailable" → Task 2 applies tail-only trim and logs the fallback for head.
- If neither works → both trims "unavailable"; Task 2 keeps whole clips + logs (matches spec fallback).

- [ ] **Step 5: Remove the probe & commit the decision note**

Delete the `window.__unnestTrimProbe` block. Leave no probe code in `main.js`.

Run: `cd plugin && node --check main.js` → exit 0.

```bash
git add plugin/main.js
git commit -m "chore(unnest): probe trim API, remove probe (findings in plan)"
```

---

### Task 2: Clamp cloned-clip overflow to ±2s (head aligned at t=0)

**Files:**
- Modify: `plugin/main.js` — `expandViaClone` (lines ~8387-8492). Add `UNNEST_PAD` constant, capture per-target expected start during target gathering, and add a post-clone locate+trim pass (TX2).
- No automated test (manual verification in Premiere).

**Interfaces:**
- Consumes (existing, same scope): `un`, `callSec`, `getClipItems`, `getTimeSec`, `secToTicks`, `logLine`, `EPS`, `ppro`, and the locals `ed`, `TT`, `timeOffset`, `winStart`, `winEnd`, `parentSeq`, `targets`.
- Produces: no new exported symbol; behavior change only.

**Interface note:** the existing `targets` array entries are `{ item, vIdx, aIdx, align }`. This task extends each entry with `expStart` (expected timeline start of the clone in seconds) and `isVideo` (bool), so the trim pass can locate the clone on the right track.

- [ ] **Step 1: Add the `UNNEST_PAD` constant**

Near `EPS` (line ~8206), add:

```javascript
  var EPS = 0.0006;            // seconds tolerance for overlap math
  var UNNEST_PAD = 2.0;        // seconds: max overflow kept beyond the nested region
```

- [ ] **Step 2: Add the trim-decision comment (from Task 1 findings)**

Immediately above `async function expandViaClone(` (line ~8387), paste the recorded decision, e.g.:

```javascript
  // Overflow trim (see plan 2026-07-09-unnest-overflow-clamp):
  //   TAIL trim  → trackItem.createSetInOutPointsAction(inPt, outPt)   [confirmed on build 25.x]
  //   HEAD trim  → <confirmed action OR "unavailable — tail-only + log">
```

- [ ] **Step 3: Record each target's expected start when gathering targets**

In the video gather loop, replace the push line:

```javascript
      for (var pk = 0; pk < picked.length; pk++) targets.push({ item: picked[pk], vIdx: vIdx, aIdx: 0, align: true });
```

with (compute expected start = timeOffset + the clip's own start):

```javascript
      for (var pk = 0; pk < picked.length; pk++) {
        var vps = await callSec(picked[pk], 'getStartTime');
        targets.push({ item: picked[pk], vIdx: vIdx, aIdx: 0, align: true,
          isVideo: true, expStart: Math.max(0, timeOffset + (vps || 0)) });
      }
```

In the audio gather loop, replace:

```javascript
        for (var qk = 0; qk < apick.length; qk++) targets.push({ item: apick[qk], vIdx: 0, aIdx: aIdx, align: false });
```

with:

```javascript
        for (var qk = 0; qk < apick.length; qk++) {
          var aps = await callSec(apick[qk], 'getStartTime');
          targets.push({ item: apick[qk], vIdx: 0, aIdx: aIdx, align: false,
            isVideo: false, expStart: Math.max(0, timeOffset + (aps || 0)) });
        }
```

- [ ] **Step 4: Add the locate+trim pass after the clone transaction**

Directly after the clone `lockedAccess`/`executeTransaction` block (after line ~8486, before the summary `logLine`), insert:

```javascript
    // ── Clamp overflow: trim each clone to [Hlo, Hhi] on the parent timeline ──
    var Hlo = Math.max(winStart - UNNEST_PAD, 0);   // head never before timeline 0
    var Hhi = winEnd + UNNEST_PAD;
    var trims = [];   // { item, newIn, newStart, newOut }
    var headSkipped = 0, tailTrimmed = 0, headTrimmed = 0;

    for (var ti = 0; ti < targets.length; ti++) {
      var tg = targets[ti];
      // Locate the clone on its target track by matching expected start.
      var trk = await un(tg.isVideo ? parentSeq.getVideoTrack(tg.vIdx) : parentSeq.getAudioTrack(tg.aIdx));
      if (!trk) continue;
      var clips = await getClipItems(trk);
      var clone = null;
      for (var ci = 0; ci < clips.length; ci++) {
        var cst = await callSec(clips[ci], 'getStartTime');
        if (cst != null && Math.abs(cst - tg.expStart) < EPS) { clone = clips[ci]; break; }
      }
      if (!clone) { logLine('  · không tìm thấy clone để trim (bỏ qua)', 'warn'); continue; }

      var cS = await callSec(clone, 'getStartTime');
      var cE = await callSec(clone, 'getEndTime');
      var cIn = await callSec(clone, 'getInPoint');
      var cOut = await callSec(clone, 'getOutPoint');
      if (cS == null || cE == null || cIn == null || cOut == null) continue;

      var newStart = cS, newIn = cIn, newOut = cOut, changed = false;
      // Tail overflow → reduce outPoint so end lands at Hhi.
      if (cE > Hhi + EPS) { newOut = cOut - (cE - Hhi); changed = true; tailTrimmed++; }
      // Head overflow → advance start to Hlo and inPoint by the same delta.
      if (cS < Hlo - EPS) {
        var dHead = Hlo - cS;
        newStart = Hlo; newIn = cIn + dHead; changed = true; headTrimmed++;
      }
      if (changed) trims.push({ item: clone, newIn: newIn, newStart: newStart, newOut: newOut,
        doHead: (cS < Hlo - EPS) });
    }

    if (trims.length) {
      await project.lockedAccess(function () {
        project.executeTransaction(function (action) {
          for (var q = 0; q < trims.length; q++) {
            var t = trims[q];
            try {
              // TAIL (and set both in/out): confirmed via createSetInOutPointsAction.
              action.addAction(t.item.createSetInOutPointsAction(
                ppro.TickTime.createWithSeconds(Math.max(0, t.newIn)),
                ppro.TickTime.createWithSeconds(Math.max(0, t.newOut))));
              // HEAD: move the clip's start to Hlo (only when head was trimmed).
              if (t.doHead && typeof t.item.createMoveTrackItemAction === 'function') {
                action.addAction(t.item.createMoveTrackItemAction(
                  ppro.TickTime.createWithSeconds(Math.max(0, t.newStart)), false));
              } else if (t.doHead) {
                headSkipped++;
              }
            } catch (e) { logLine('  ✗ trim lỗi: ' + (e.message || e), 'err'); }
          }
        }, 'Un-nest: trim overflow ' + trims.length + ' clip');
      });
      logLine('✂ trim overflow: ' + tailTrimmed + ' tail + ' + headTrimmed + ' head (pad ' + UNNEST_PAD + 's)'
        + (headSkipped ? ' · ⚠ ' + headSkipped + ' head không trim được (API n/a) — giữ nguyên' : ''), 'ok');
    }
```

- [ ] **Step 5: Syntax check**

Run: `cd plugin && node --check main.js`
Expected: no output (exit 0).

- [ ] **Step 6: Manual verification in Premiere (25+)**

Reload the plugin. For each check, run un-nest (via Settings → Un-nest "Chạy trên clip đang chọn" or a hotkey) and inspect the timeline:

1. **Both-ends overflow:** nested seq mid-timeline containing a clip that overflows the region >2s each side → after `video`/`av`/`avt`: the clone's head starts exactly `winStart−2s`, tail ends exactly `winEnd+2s`; effects preserved (open Effect Controls). Log shows `✂ trim overflow`.
2. **Region starts <2s from 0:** move the nested clip so it starts ~0.5s from timeline start → head is trimmed at timeline 0 and the clip stays frame-aligned with sibling clips (scrub and confirm no shift). Log shows a head trim.
3. **No overflow:** a clip already within ±2s of the region → untouched (no trim logged for it).
4. **Reused track w/ neighbor in pad zone:** a reused track has a pre-existing clip sitting just outside the window but within the 2s pad → that neighbor is NOT trimmed (only clones matched by expected start are).

If HEAD trim was recorded "unavailable" in Task 1, confirm the fallback: tail still trims, head keeps whole, log shows the `⚠ … head không trim được` note — and no crash.

- [ ] **Step 7: Commit**

```bash
git add plugin/main.js
git commit -m "feat(unnest): clamp cloned-clip overflow to 2s; head aligned at timeline 0"
```

---

## Notes for the implementer

- The trim runs in its **own transaction** so a failure there cannot roll back the clones from TX1.
- `getClipItems`, `callSec`, `un`, `logLine`, `EPS`, and `TT` already exist in `expandViaClone`'s scope — do not redefine them.
- Match clones by `expStart` (computed pre-clamp as `max(0, timeOffset + sourceStart)`) — this is the same value `TT` used to place them, so the located clip is exactly our clone and never a pre-existing neighbor.
- Keep the change confined to `expandViaClone` + the two new constants. Do not touch `classifyVideoClip`, the mode filters, disable-original, or hotkey code.
