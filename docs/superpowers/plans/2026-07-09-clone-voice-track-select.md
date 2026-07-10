# Clone Voice Source-Track Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user choose which existing (non-empty) audio track to clone a voice from in Voice Gen → Create → Clone Voice, instead of always using A1.

**Architecture:** All JS lives in the existing Voice Create module (an IIFE in `plugin/main.js`, where the `vc*` element vars are declared ~line 7120 and the `vcGetClip` extract handler is ~line 7199). A small custom toggle-dropdown lists non-empty audio tracks and sets a module var `vcSelectedTrackIdx`; the extract handler reads that var instead of the hardcoded index 0. Markup goes in `#vcFromSequenceSection`; styles reuse existing dropdown classes.

**Tech Stack:** UXP plugin JavaScript (non-module `plugin/main.js`), Premiere 25+ `ppro` API. No build step, no automated test framework — `node --check` for syntax, manual verification in Premiere.

## Global Constraints

- Non-module script: no `import`/`export`.
- All Premiere API calls are async — wrap with the existing `un(...)` and `getClipItems(...)`; `getActiveSequence()` is available in this module.
- UXP: no `position:fixed`, `z-index`, `display:grid`, `new Audio()`, no `title=""`; `alert()` does NOT render. Use a custom toggle-dropdown, not a native `<select>`.
- Single-track selection only. Dropdown lists ONLY non-empty audio tracks (`count > 0`), labelled `A{index+1} ({count} clip)`, default = first non-empty. No persistence.
- `window.pluginIconSVG(name, size, color)` returns an inline SVG string (used for the dynamic button icon).
- Plugin-only change: touch only `plugin/index.html`, `plugin/main.js`, `plugin/styles.css`. Do NOT change the ElevenLabs clone request, Steps 2–3, or the "From File" path.
- Existing element vars in scope: `vcFromSeqSection` (=`#vcFromSequenceSection`), `vcGetClip`, `vcClipInfo`. Existing state var block is at ~line 7151. `vcSelectMethod(m)` ~line 7160; the `vcSource` radio handler ~line 7184; the `vcGetClip` click handler ~line 7199.

---

### Task 1: Track dropdown — markup, state, listing, render, wiring

**Files:**
- Modify: `plugin/index.html` — rename the segment label and add the dropdown inside `#vcFromSequenceSection`.
- Modify: `plugin/main.js` — Voice Create module: new state + `vcListAudioTracks` / `vcRefreshTrackList` / `vcRenderTrackSel`, dropdown toggle wiring, and refresh hooks in `vcSelectMethod` + the source radio + module init.
- Modify: `plugin/styles.css` — small `.vc-trackSel` spacing (reuse `vg-nameToolBtn`/`vg-namePanel`/`vg-nameRow`).
- No automated test (manual UXP verification).

**Interfaces:**
- Produces (used by Task 2): module var `vcSelectedTrackIdx` (0-based selected audio track index; defaults to the first non-empty track, or 0 if none).

- [ ] **Step 1: Rename the segment label + add the dropdown markup**

In `plugin/index.html`, change the sequence radio label (line ~484) from:

```html
                  <label class="vc-seg"><input type="radio" name="vcSource" value="sequence" checked /><span>From Timeline A1</span></label>
```

to:

```html
                  <label class="vc-seg"><input type="radio" name="vcSource" value="sequence" checked /><span>From Timeline</span></label>
```

Then, inside `#vcFromSequenceSection`, insert the dropdown BEFORE `#vcGetClip`:

```html
                <div id="vcFromSequenceSection">
                  <div class="vc-trackSel">
                    <div id="vcTrackSelBtn" class="vg-nameToolBtn" role="button">Track: A1 <span class="vg-caret">▾</span></div>
                    <div id="vcTrackSelPanel" class="vg-namePanel" hidden></div>
                  </div>
                  <div id="vcGetClip" class="vc-bigBtn vc-bigPrimary" role="button"><span data-ic="download" data-ic-size="13" data-ic-color="#ffffff"></span> Extract audio from Timeline A1</div>
```

(Leave the rest of `#vcFromSequenceSection` — `#vcGetClip`'s closing and `#vcClipInfo` — unchanged.)

- [ ] **Step 2: Add state vars**

In `plugin/main.js`, in the Voice Create state block (right after `var vcSelectedFilePath = '';` ~line 7151), add:

```javascript
    var vcSelectedTrackIdx = 0;  // 0-based source audio track for Clone Voice (first non-empty by default)
    var vcTrackList = [];        // cached [{ index, label, count }] of non-empty audio tracks
```

- [ ] **Step 3: Add the track-listing + render + refresh functions**

In the same module, after `vcRefreshCloneSteps` is defined (~line 7177, before the source-radio block), add:

```javascript
    // List non-empty audio tracks of the active sequence → [{ index, label, count }].
    async function vcListAudioTracks() {
      var out = [];
      try {
        var seq = await getActiveSequence();
        if (!seq) return out;
        var cnt = seq.getAudioTrackCount ? seq.getAudioTrackCount() : 0;
        if (cnt && typeof cnt.then === 'function') cnt = await cnt;
        cnt = cnt || 0;
        for (var i = 0; i < cnt; i++) {
          var trk = null;
          try { trk = seq.getAudioTrack(i); if (trk && typeof trk.then === 'function') trk = await trk; } catch (e) {}
          if (!trk) continue;
          var items = []; try { items = await getClipItems(trk); } catch (e) {}
          if (items && items.length) out.push({ index: i, label: 'A' + (i + 1), count: items.length });
        }
      } catch (e) {}
      return out;
    }
    function vcRenderTrackSel() {
      var btn = document.getElementById('vcTrackSelBtn');
      var panel = document.getElementById('vcTrackSelPanel');
      var sel = null;
      for (var i = 0; i < vcTrackList.length; i++) if (vcTrackList[i].index === vcSelectedTrackIdx) sel = vcTrackList[i];
      var hasAny = vcTrackList.length > 0;
      if (btn) btn.innerHTML = 'Track: ' + (sel ? (sel.label + ' (' + sel.count + ' clip)') : '(không có clip audio)') + ' <span class="vg-caret">▾</span>';
      if (vcGetClip) {
        vcGetClip.setAttribute('aria-disabled', hasAny ? 'false' : 'true');
        vcGetClip.classList.toggle('is-disabled', !hasAny);
        vcGetClip.innerHTML = window.pluginIconSVG('download', 13, '#ffffff') + ' ' + (hasAny && sel ? ('Extract audio from ' + sel.label) : 'Không có clip audio');
      }
      if (vcClipInfo) vcClipInfo.textContent = (hasAny && sel)
        ? ('Grabs every clip on audio track ' + sel.label + ' and joins them into one voice sample.')
        : 'Không có clip audio nào trên timeline.';
      if (panel) {
        panel.innerHTML = '';
        if (!hasAny) { panel.innerHTML = '<div class="vg-nameRow vg-nameRow--empty">(không có clip audio)</div>'; }
        else vcTrackList.forEach(function (t) {
          var row = document.createElement('div'); row.className = 'vg-nameRow';
          row.textContent = t.label + ' (' + t.count + ' clip)';
          row.onclick = function (e) { if (e && e.stopPropagation) e.stopPropagation(); vcSelectedTrackIdx = t.index; if (panel) panel.hidden = true; vcRenderTrackSel(); };
          panel.appendChild(row);
        });
      }
    }
    async function vcRefreshTrackList() {
      vcTrackList = await vcListAudioTracks();
      var found = false;
      for (var i = 0; i < vcTrackList.length; i++) if (vcTrackList[i].index === vcSelectedTrackIdx) found = true;
      if (!found) vcSelectedTrackIdx = vcTrackList.length ? vcTrackList[0].index : 0;
      vcRenderTrackSel();
    }
```

- [ ] **Step 4: Wire the dropdown toggle**

After the functions from Step 3, add:

```javascript
    (function () {
      var tb = document.getElementById('vcTrackSelBtn');
      var tp = document.getElementById('vcTrackSelPanel');
      if (tb) tb.addEventListener('click', function () { if (tp) tp.hidden = !tp.hidden; });
    })();
```

- [ ] **Step 5: Refresh the list when entering Clone + on source switch + at init**

In `vcSelectMethod(m)` (~line 7160), add a refresh when clone is chosen. After the lines that toggle `vcCloneSection`/`vcDesignSection` visibility, add at the end of the function body:

```javascript
      if (m === 'clone') { try { vcRefreshTrackList(); } catch (e) {} }
```

In the `vcSource` radio handler (~line 7184), replace the hardcoded A1 info line:

```javascript
        if (vcClipInfo) vcClipInfo.textContent = 'Grabs every clip on audio track A1 and joins them into one voice sample.';
```

with a refresh when switching to the sequence source (the render sets the info text):

```javascript
        if (fromSeq) { try { vcRefreshTrackList(); } catch (e) {} }
```

Finally, populate once at module init. Immediately after the dropdown-toggle IIFE from Step 4, add:

```javascript
    try { vcRefreshTrackList(); } catch (e) {}
```

- [ ] **Step 6: Add styles**

In `plugin/styles.css`, append near the other `.vc-*` rules:

```css
.vc-trackSel { margin-bottom: 8px; }
.vc-trackSel .vg-nameToolBtn { width: 100%; justify-content: center; box-sizing: border-box; }
.vc-bigBtn.is-disabled { opacity: 0.5; pointer-events: none; }
```

- [ ] **Step 7: Syntax check + manual UI verification**

Run: `cd plugin && node --check main.js`
Expected: exit 0, no output.

Reload the plugin, open Voice Gen → Create → Clone Voice → From Timeline:
- `Track: A1 (n clip) ▾` shows; clicking it lists only non-empty tracks with counts.
- Picking a track updates the button ("Extract audio from A3") and info text; the panel closes.
- With no audio clips on the timeline: button reads "Không có clip audio" and is disabled.
- (Extract still reads A1 until Task 2 — that's expected here.)

- [ ] **Step 8: Commit**

```bash
git add plugin/index.html plugin/main.js plugin/styles.css
git commit -m "feat(voicegen): source-track selector UI for Clone Voice"
```

---

### Task 2: Extract from the selected track

**Files:**
- Modify: `plugin/main.js` — the `vcGetClip` click handler (~lines 7199-7233): use `vcSelectedTrackIdx` on both track-access paths and in status/error text.
- No automated test (manual UXP verification).

**Interfaces:**
- Consumes (from Task 1): `vcSelectedTrackIdx` (0-based index of the chosen non-empty audio track).

- [ ] **Step 1: Compute the label + use the selected index on both paths**

In the `vcGetClip` click handler, replace this block:

```javascript
        if (vcClipInfo) vcClipInfo.textContent = 'Reading A1 clips…';
        vcGetClip.disabled = true;
        vcSelectedFilePath = '';
        vcRefreshCloneSteps(); // collapse Steps 2 & 3 while re-extracting
        try {
          if (!ppro) throw new Error('Premiere Pro API not available');
          var seq = await getActiveSequence();
          var track = null;

          // Path A: trackGroup API
          try {
            if (typeof seq.trackGroup === 'function' && ppro.Backend && ppro.Backend.MEDIATYPE_AUDIO !== undefined) {
              var aGroup = seq.trackGroup(ppro.Backend.MEDIATYPE_AUDIO);
              if (aGroup && aGroup.numTracks > 0) track = aGroup.getTrack(0);
            }
          } catch(eA) {}

          // Path B: getAudioTrack
          if (!track) {
            try {
              var cnt = seq.getAudioTrackCount && seq.getAudioTrackCount();
              if (cnt && typeof cnt.then === 'function') cnt = await cnt;
              if (cnt > 0) {
                track = seq.getAudioTrack && seq.getAudioTrack(0);
                if (track && typeof track.then === 'function') track = await track;
              }
            } catch(eB) {}
          }

          if (!track) throw new Error('Cannot access audio track A1');

          var items = await getClipItems(track);
          if (!items.length) throw new Error('No clips on audio track A1');
```

with:

```javascript
        var vcTrkLabel = 'A' + (vcSelectedTrackIdx + 1);
        if (vcClipInfo) vcClipInfo.textContent = 'Reading ' + vcTrkLabel + ' clips…';
        vcGetClip.disabled = true;
        vcSelectedFilePath = '';
        vcRefreshCloneSteps(); // collapse Steps 2 & 3 while re-extracting
        try {
          if (!ppro) throw new Error('Premiere Pro API not available');
          var seq = await getActiveSequence();
          var track = null;

          // Path A: trackGroup API
          try {
            if (typeof seq.trackGroup === 'function' && ppro.Backend && ppro.Backend.MEDIATYPE_AUDIO !== undefined) {
              var aGroup = seq.trackGroup(ppro.Backend.MEDIATYPE_AUDIO);
              if (aGroup && aGroup.numTracks > vcSelectedTrackIdx) track = aGroup.getTrack(vcSelectedTrackIdx);
            }
          } catch(eA) {}

          // Path B: getAudioTrack
          if (!track) {
            try {
              var cnt = seq.getAudioTrackCount && seq.getAudioTrackCount();
              if (cnt && typeof cnt.then === 'function') cnt = await cnt;
              if (cnt > vcSelectedTrackIdx) {
                track = seq.getAudioTrack && seq.getAudioTrack(vcSelectedTrackIdx);
                if (track && typeof track.then === 'function') track = await track;
              }
            } catch(eB) {}
          }

          if (!track) throw new Error('Cannot access audio track ' + vcTrkLabel);

          var items = await getClipItems(track);
          if (!items.length) throw new Error('No clips on audio track ' + vcTrkLabel);
```

- [ ] **Step 2: Syntax check**

Run: `cd plugin && node --check main.js`
Expected: exit 0, no output.

- [ ] **Step 3: Manual verification in Premiere (25+)**

Reload. Timeline with clips on A1 and A3 (A2 empty):
- Clone Voice → From Timeline → pick **A3** → Extract → the built sample comes from A3's clips (not A1); clone flow proceeds normally.
- Pick A1 → Extract → uses A1 (regression check).
- Trigger the error path (select a track then delete its clips before extracting) → error text names the selected track label, no crash.

- [ ] **Step 4: Commit**

```bash
git add plugin/main.js
git commit -m "feat(voicegen): extract Clone Voice sample from the selected audio track"
```

---

## Notes for the implementer

- `getActiveSequence`, `getClipItems`, `un`, `ppro`, and `window.pluginIconSVG` are all reachable in the Voice Create module.
- Do not use `alert()`.
- The dropdown must be a custom toggle-panel (reusing `vg-nameToolBtn`/`vg-namePanel`/`vg-nameRow`), not a native `<select>`.
- Keep changes within the Voice Create module + `#vcFromSequenceSection` markup + `.vc-*` styles. Do not touch the ElevenLabs clone request, the design-voice flow, or "From File".
