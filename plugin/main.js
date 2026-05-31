/* =========================================================
   Claude AI — Premiere Pro UXP Plugin  v1.3.1
   Single non-module script (no import/export).
   API confirmed from Adobe DVA internal plugins (text/copilot).
   Key pattern: trackGroup + ClipTrack.queryCast + getTrackItems(1,false)
   ========================================================= */

// ── Premiere API wrapper (async) ───────────────────────────────────────────

var ppro = null;
try { ppro = require('premierepro'); } catch(e) { console.warn('premierepro not available:', e.message); }

// Convert any TickTime/time object to seconds
// Premiere Pro 25.x TickTime has non-enumerable getters — try everything
function getTimeSec(t) {
  if (!t && t !== 0) return 0;
  if (typeof t === 'number') return t;
  if (typeof t.seconds === 'number') return t.seconds;
  if (typeof t.ticks   === 'number') return t.ticks / 254016000000;
  try { var s = t.seconds; if (typeof s === 'number') return s; } catch(e) {}
  try { var tk = t.ticks;  if (typeof tk === 'number') return tk / 254016000000; } catch(e) {}
  if (typeof t.getSeconds === 'function') { try { return t.getSeconds(); } catch(e) {} }
  if (typeof t.getValue   === 'function') { try { return t.getValue();   } catch(e) {} }
  if (t.time != null) return getTimeSec(t.time);
  return 0;
}
function secToTicks(s) { return Math.round((s || 0) * 254016000000); }

// Collection helper: works for both array and {numX, [i]} style collections
function collectionToArray(col) {
  if (!col) return [];
  if (Array.isArray(col)) return col;
  var count = col.numTracks || col.numItems || col.numSequences || col.length || 0;
  var arr = [];
  for (var i = 0; i < count; i++) arr.push(col[i]);
  return arr;
}

async function getActiveProject() {
  if (!ppro) throw new Error('Premiere API not available');
  // Modern UXP API: ppro.Project.getActiveProject() (async)
  if (ppro.Project && typeof ppro.Project.getActiveProject === 'function') {
    var p = await ppro.Project.getActiveProject();
    if (p) return p;
  }
  // Fallback: sync property paths
  var p2 = (ppro.app && ppro.app.project) || ppro.project || null;
  if (p2) return p2;
  throw new Error('No project open in Premiere');
}

async function getActiveSequence() {
  var proj = await getActiveProject();

  // 1. Async method (Premiere Pro 23+)
  if (typeof proj.getActiveSequence === 'function') {
    var s = await proj.getActiveSequence();
    if (s) return s;
  }
  // 2. Sync property
  if (proj.activeSequence) return proj.activeSequence;

  // DO NOT fall back to seqs[0] — that always returns the first sequence
  // regardless of which one is actually open in the timeline panel.
  throw new Error('No active sequence. Double-click a sequence in Premiere to open it.');
}

// ── Track/clip access ─────────────────────────────────────────────────────
// Confirmed API from Adobe DVA internal UXP plugins (com.adobe.dva.text):
//   seq.trackGroup(ppro.Backend.MEDIATYPE_VIDEO)  → TrackGroup (sync)
//   trackGroup.numTracks                           → count (property)
//   trackGroup.getTrack(i)                         → Track (sync)
//   ppro.ClipTrack.queryCast(track)                → ClipTrack or null
//   clipTrack.getTrackItems(1, false)              → TrackItem[] (1=CLIP type)
//   item.getStart()                                → TickTime {seconds, ticks}
//   item.getDuration()                             → TickTime {seconds, ticks}
// TrackItemType: EMPTY=0, CLIP=1, TRANSITION=2, PREVIEW=3

var TRACK_ITEM_TYPE_CLIP = 1; // from enum: e[e.CLIP=1]="CLIP"

// getTimeSec (above) handles all TickTime cases — getTickTimeSec is an alias
// kept here for internal calls within track/clip section:

// Get all clip items from a track.
// Method A (preferred): ClipTrack.queryCast(track).getTrackItems(CLIP=1, false)
// Method B (fallback):  track.getTrackItems(CLIP=1, false)  ← same signature, direct call
// The signature is (TrackItemType, includeDisabled) — NOT (startTicks, endTicks)!
// TrackItemType: EMPTY=0, CLIP=1, TRANSITION=2 (confirmed from DVA text plugin enum)
async function getClipItems(track) {
  if (!track) return [];
  try {
    // Method A: queryCast (cleaner, handles caption-only tracks gracefully)
    if (ppro.ClipTrack) {
      var ct = ppro.ClipTrack.queryCast(track);
      if (ct) {
        var items = ct.getTrackItems(TRACK_ITEM_TYPE_CLIP, false);
        if (items && typeof items.then === 'function') items = await items;
        if (!items) return [];
        return Array.isArray(items) ? items : Array.from({length: items.length||0}, function(_,i){return items[i];});
      }
    }
    // Method B: call directly on the track object
    var items2 = track.getTrackItems(TRACK_ITEM_TYPE_CLIP, false);
    if (items2 && typeof items2.then === 'function') items2 = await items2;
    if (!items2) return [];
    return Array.isArray(items2) ? items2 : Array.from({length: items2.length||0}, function(_,i){return items2[i];});
  } catch(e) {
    console.warn('[Plugin] getClipItems error on track:', e.message);
    return [];
  }
}

// Probe a clip on first call to log available properties
var _clipProbed = false;
function probeClipIfNeeded(clip) {
  if (_clipProbed || !clip) return;
  _clipProbed = true;
  var props = {};
  var KEYS = ['name','mediaType','type','inPoint','outPoint','start','end','duration',
               'getStart','getEnd','getInPoint','getOutPoint','getDuration','getGuid'];
  for (var i = 0; i < KEYS.length; i++) {
    try { var v = clip[KEYS[i]]; if (v !== undefined) props[KEYS[i]] = (typeof v === 'function') ? 'fn()' : String(v).slice(0,50); }
    catch(e) {}
  }
  // Try calling getStart
  try { var gs = clip.getStart(); props['getStart()'] = JSON.stringify({s: gs.seconds, t: gs.ticks}); } catch(e) {}
  try { var gd = clip.getDuration(); props['getDuration()'] = JSON.stringify({s: gd.seconds}); } catch(e) {}
  console.log('[Probe] ClipItem:', JSON.stringify(props));
}

// Helper: extract clip timing and push to array (async-aware)
async function pushClip(arr, item, trackIndex, trackType, clipIndex) {
  if (!item) return;
  probeClipIfNeeded(item);
  var startSec = 0, endSec = 0;
  // Modern Premiere UXP returns Promises from getters — await them
  try {
    var gs = item.getStart && item.getStart();
    if (gs && typeof gs.then === 'function') gs = await gs;
    startSec = (gs && typeof gs.seconds === 'number') ? gs.seconds
             : (gs && gs.ticks != null) ? Number(gs.ticks) / 254016000000 : 0;
  } catch(e) {}
  try {
    var ge = item.getEnd && item.getEnd();
    if (ge && typeof ge.then === 'function') ge = await ge;
    endSec = (ge && typeof ge.seconds === 'number') ? ge.seconds
           : (ge && ge.ticks != null) ? Number(ge.ticks) / 254016000000 : 0;
  } catch(e) {}
  // Fallback
  if (!startSec && !endSec) {
    startSec = getTimeSec(item.start || item.inPoint);
    endSec   = getTimeSec(item.end   || item.outPoint);
  }
  var name = item.name || '';
  if (!name && typeof item.getName === 'function') {
    try { var nm = item.getName(); if (nm && typeof nm.then === 'function') nm = await nm; if (nm) name = String(nm); } catch(e) {}
  }
  arr.push({ trackIndex: trackIndex, trackType: trackType, clipIndex: clipIndex,
    name: name || ('Clip ' + clipIndex), startSec: startSec, endSec: endSec });
}

// Get source file path from a timeline TrackItem.
// Tries getProjectItem() → ClipProjectItem.cast → getMediaFilePath, then
// .projectItem property, then direct item.getMediaFilePath as fallback.
async function vcGetTrackItemFilePath(item) {
  if (!item) return null;
  try {
    var pi = item.getProjectItem && item.getProjectItem();
    if (pi && typeof pi.then === 'function') pi = await pi;
    if (pi) {
      var cast = ppro && ppro.ClipProjectItem && ppro.ClipProjectItem.cast ? ppro.ClipProjectItem.cast(pi) : pi;
      var fp = (cast || pi).getMediaFilePath && (cast || pi).getMediaFilePath();
      if (fp && typeof fp.then === 'function') fp = await fp;
      if (typeof fp === 'string' && fp) return fp;
    }
  } catch(e) {}
  try {
    var pi2 = item.projectItem;
    if (pi2) {
      var cast2 = ppro && ppro.ClipProjectItem && ppro.ClipProjectItem.cast ? ppro.ClipProjectItem.cast(pi2) : pi2;
      var fp2 = (cast2 || pi2).getMediaFilePath && (cast2 || pi2).getMediaFilePath();
      if (fp2 && typeof fp2.then === 'function') fp2 = await fp2;
      if (typeof fp2 === 'string' && fp2) return fp2;
    }
  } catch(e) {}
  try {
    var fp3 = item.getMediaFilePath && item.getMediaFilePath();
    if (fp3 && typeof fp3.then === 'function') fp3 = await fp3;
    if (typeof fp3 === 'string' && fp3) return fp3;
  } catch(e) {}
  return null;
}

async function ppGetTimelineInfo() {
  try {
    var seq = await getActiveSequence();

    // ── Get tracks and clips ───────────────────────────────────────────────
    var clips = [], vCount = 0, aCount = 0, durationSec = 0;

    // Log available ppro API surface for debugging
    console.log('[Plugin] ppro.Backend:', typeof ppro.Backend,
                '| ppro.ClipTrack:', typeof ppro.ClipTrack,
                '| seq.trackGroup:', typeof seq.trackGroup);

    // ── Path A: trackGroup API (Adobe DVA internal plugins pattern) ──────
    // seq.trackGroup(mediaType) → sync TrackGroup {numTracks, getTrack(i)}
    var usedTrackGroup = false;
    if (typeof seq.trackGroup === 'function' && ppro.Backend && ppro.Backend.MEDIATYPE_VIDEO !== undefined) {
      try {
        var vGroup = seq.trackGroup(ppro.Backend.MEDIATYPE_VIDEO);
        var aGroup = seq.trackGroup(ppro.Backend.MEDIATYPE_AUDIO);
        if (vGroup && typeof vGroup.numTracks === 'number') {
          usedTrackGroup = true;
          vCount = vGroup.numTracks;
          aCount = (aGroup && typeof aGroup.numTracks === 'number') ? aGroup.numTracks : 0;
          console.log('[Plugin Path A] trackGroup vCount:', vCount, '| aCount:', aCount);
          for (var vi = 0; vi < vCount; vi++) {
            var vitems = await getClipItems(vGroup.getTrack(vi));
            console.log('[Plugin] Video track', vi, '→', vitems.length, 'clips');
            for (var ci = 0; ci < vitems.length; ci++) await pushClip(clips, vitems[ci], vi, 'video', ci);
          }
          for (var ai = 0; ai < aCount; ai++) {
            var aitems = await getClipItems(aGroup.getTrack(ai));
            console.log('[Plugin] Audio track', ai, '→', aitems.length, 'clips');
            for (var aci = 0; aci < aitems.length; aci++) await pushClip(clips, aitems[aci], ai, 'audio', aci);
          }
        }
      } catch(eA) { console.warn('[Plugin Path A] failed:', eA.message); }
    }

    // ── Path B: async getVideoTrack(i) + getClipItems (CLIP=1, false) ────
    // Works when trackGroup is unavailable. Uses same confirmed signature.
    if (!usedTrackGroup) {
      console.log('[Plugin Path B] using async getVideoTrack + getClipItems(1,false)');
      vCount = await seq.getVideoTrackCount();
      aCount = await seq.getAudioTrackCount();
      console.log('[Plugin Path B] vCount:', vCount, '| aCount:', aCount);
      for (var bvi = 0; bvi < vCount; bvi++) {
        var bvt = await seq.getVideoTrack(bvi);
        var bvitems = await getClipItems(bvt);
        console.log('[Plugin] Video track', bvi, '→', bvitems.length, 'clips');
        for (var bci = 0; bci < bvitems.length; bci++) await pushClip(clips, bvitems[bci], bvi, 'video', bci);
      }
      for (var bai = 0; bai < aCount; bai++) {
        var bat = await seq.getAudioTrack(bai);
        var baitems = await getClipItems(bat);
        console.log('[Plugin] Audio track', bai, '→', baitems.length, 'clips');
        for (var baci = 0; baci < baitems.length; baci++) await pushClip(clips, baitems[baci], bai, 'audio', baci);
      }
    }

    // Sequence duration
    try { var et = await seq.getEndTime(); durationSec = et.seconds || getTimeSec(et); } catch(e) {}
    console.log('[Plugin] Total clips:', clips.length, '| durationSec:', durationSec.toFixed(2));

    return { ok: true, data: {
      sequenceName:    seq.name,
      durationSec:     durationSec,
      videoTrackCount: vCount,
      audioTrackCount: aCount,
      clips:           clips
    }};
  } catch(e) {
    console.error('[Plugin] ppGetTimelineInfo error:', e.message, e.stack);
    return { ok: false, error: e.message };
  }
}

async function ppExecuteAction(actionObj) {
  var action = actionObj.action;
  try {
    if (action === 'get_timeline_info') return await ppGetTimelineInfo();

    // Push script/sfx text to Voice Gen tab (cross-tab communication)
    if (action === 'voicegen_script') {
      if (typeof window.VoiceGenPushScript === 'function') {
        window.VoiceGenPushScript(
          actionObj.text || '',
          actionObj.voiceId || null,
          !!actionObj.autoGenerate
        );
      }
      return { ok: true, data: { message: 'Script pushed to Voice Gen tab' } };
    }
    if (action === 'voicegen_sfx') {
      if (typeof window.VoiceGenPushSFX === 'function') {
        window.VoiceGenPushSFX(
          actionObj.text || '',
          !!actionObj.autoGenerate
        );
      }
      return { ok: true, data: { message: 'SFX prompt pushed to Voice Gen tab' } };
    }

    // Push an organized cutsheet into the Autocut tab's spreadsheet.
    // Accepts SAC-native rows {text, time, src} OR cutlist-style rows
    // {script, source, sourceIn, sourceOut} (seconds → "m:ss-m:ss").
    if (action === 'autocut_load') {
      var fmtSec = function(s) {
        s = Math.max(0, Math.round(Number(s) || 0));
        var m = Math.floor(s / 60), sec = s % 60;
        return m + ':' + (sec < 10 ? '0' + sec : sec);
      };
      var rawRows = Array.isArray(actionObj.rows) ? actionObj.rows : [];
      var rows = rawRows.map(function(r) {
        var text = r.text != null ? r.text : (r.script || '');
        var src  = r.src  != null ? r.src  : (r.source || '');
        var time = r.time || '';
        if (!time) {
          if (r.sourceIn != null && r.sourceOut != null) time = fmtSec(r.sourceIn) + '-' + fmtSec(r.sourceOut);
          else if (r.sourceIn != null) time = fmtSec(r.sourceIn);
        }
        return { text: String(text).trim(), time: String(time).trim(), src: String(src).trim() };
      });
      if (typeof window.AutocutPushRows === 'function') window.AutocutPushRows(rows);
      return { ok: true, data: { message: 'Loaded ' + rows.length + ' rows into Autocut tab' } };
    }

    var seq = await getActiveSequence();

    if (action === 'cut_clip') {
      // trackType: 'audio' or 'video' (default video). audioIndex/videoIndex maps to track.
      var trackType  = (actionObj.trackType || 'video').toLowerCase();
      var trackIdx   = actionObj.trackIndex || 0;
      var atSec      = Number(actionObj.time || 0);
      var trackObj   = trackType === 'audio'
        ? await seq.getAudioTrack(trackIdx)
        : await seq.getVideoTrack(trackIdx);
      if (!trackObj) throw new Error(trackType + ' track ' + trackIdx + ' not found');

      // Find the trackItem that contains atSec on its timeline range (inline async probe)
      async function clipStart(item) {
        try { var gs = await item.getStart(); return (gs && gs.seconds) || 0; } catch(e) { return 0; }
      }
      async function clipDur(item) {
        try {
          var gs = await item.getStart();
          var ge = await item.getEnd();
          return ((ge && ge.seconds) || 0) - ((gs && gs.seconds) || 0);
        } catch(e) { return 0; }
      }
      var items = await getClipItems(trackObj);
      var target = null;
      console.log('[cut_clip] scanning', items.length, 'items on', trackType, 'track', trackIdx, 'for time', atSec);
      for (var i = 0; i < items.length; i++) {
        var s = await clipStart(items[i]);
        var d = await clipDur(items[i]);
        console.log('[cut_clip]   [' + i + '] "' + (items[i].name || '?') + '" start=' + s + ' dur=' + d);
        if (atSec > s + 0.001 && atSec < s + d - 0.001) {
          target = { item: items[i], startSec: s, durSec: d };
          break;
        }
      }
      if (!target) throw new Error('No ' + trackType + ' clip on track ' + trackIdx + ' contains time ' + atSec + 's');

      // Try multiple razor approaches — UXP API varies
      var atTick = ppro.TickTime.createWithSeconds(atSec);
      var project = await getActiveProject();
      var razorDone = false;

      // Approach 1: sequence-level razor methods
      try {
        if (typeof seq.razor === 'function') {
          var r = seq.razor(atTick);
          if (r && typeof r.then === 'function') await r;
          razorDone = true;
        } else if (typeof seq.razorAll === 'function') {
          var ra = seq.razorAll(atTick);
          if (ra && typeof ra.then === 'function') await ra;
          razorDone = true;
        }
      } catch(e) { console.warn('[cut_clip] razor() failed:', e.message); }

      // Approach 2: SequenceEditor createRazorAction (if exists)
      if (!razorDone && ppro.SequenceEditor) {
        try {
          var editor = ppro.SequenceEditor.getEditor(seq);
          if (editor && typeof editor.createRazorAction === 'function') {
            await project.lockedAccess(function() {
              project.executeTransaction(function(action) {
                action.addAction(editor.createRazorAction(atTick));
              }, 'Razor at ' + atSec + 's');
            });
            razorDone = true;
          } else if (editor && typeof editor.createRazorAtTimeAction === 'function') {
            await project.lockedAccess(function() {
              project.executeTransaction(function(action) {
                action.addAction(editor.createRazorAtTimeAction(atTick));
              }, 'Razor at ' + atSec + 's');
            });
            razorDone = true;
          }
        } catch(e) { console.warn('[cut_clip] editor.createRazorAction failed:', e.message); }
      }

      // Approach 3: trackItem split (if available)
      if (!razorDone) {
        try {
          if (typeof target.item.createSplitAction === 'function') {
            await project.lockedAccess(function() {
              project.executeTransaction(function(action) {
                action.addAction(target.item.createSplitAction(atTick));
              }, 'Split at ' + atSec + 's');
            });
            razorDone = true;
          }
        } catch(e) { console.warn('[cut_clip] split failed:', e.message); }
      }

      if (!razorDone) {
        // No razor API available — dump what we know
        var seqMethods = [];
        for (var k in seq) if (typeof seq[k] === 'function' && /razor|split|cut/i.test(k)) seqMethods.push(k);
        var edMethods = [];
        if (ppro.SequenceEditor) {
          try {
            var ed = ppro.SequenceEditor.getEditor(seq);
            for (var k2 in ed) if (typeof ed[k2] === 'function' && /razor|split|cut/i.test(k2)) edMethods.push(k2);
          } catch(e) {}
        }
        throw new Error('No razor API in this Premiere version. Tried: seq.razor, editor.createRazorAction, item.createSplitAction. seq methods found: [' + seqMethods.join(',') + '], editor methods: [' + edMethods.join(',') + ']');
      }
      return { ok: true, data: { message: 'Razor cut ' + trackType + ' track ' + trackIdx + ' at ' + atSec + 's' } };
    }
    if (action === 'add_marker') {
      var m = await seq.markers.createMarker(secToTicks(actionObj.time));
      if (actionObj.name) m.name = actionObj.name;
      return { ok: true, data: { message: 'Marker "' + actionObj.name + '" added at ' + actionObj.time + 's' } };
    }
    if (action === 'add_subtitle') {
      var ct     = collectionToArray(seq.captionTracks);
      var ctrack = ct[actionObj.captionTrackIndex || 0];
      if (!ctrack) throw new Error('No caption track found. Create one in Premiere first.');
      var clipEl = await ctrack.createCaption(
        { ticks: secToTicks(actionObj.startTime) },
        { ticks: secToTicks(actionObj.endTime) });
      if (clipEl) clipEl.text = actionObj.text;
      return { ok: true, data: { message: 'Subtitle added: "' + actionObj.text + '"' } };
    }
    if (action === 'set_volume') {
      var atrack = collectionToArray(seq.audioTracks)[actionObj.trackIndex];
      var aclip  = atrack && collectionToArray(atrack.clips)[actionObj.clipIndex];
      if (!aclip) throw new Error('Audio clip not found');
      var comps = collectionToArray(aclip.audioComponents);
      for (var i = 0; i < comps.length; i++) {
        if (comps[i].displayName === 'Volume') {
          comps[i].properties.getPropertyByDisplayName('Level').setValue(actionObj.volumeDb, true);
          break;
        }
      }
      return { ok: true, data: { message: 'Volume set to ' + actionObj.volumeDb + 'dB' } };
    }
    if (action === 'move_clip') {
      var mvtrack = collectionToArray(seq.videoTracks)[actionObj.trackIndex];
      var mvclip  = mvtrack && collectionToArray(mvtrack.clips)[actionObj.clipIndex];
      if (!mvclip) throw new Error('Clip not found');
      mvclip.start = { ticks: secToTicks(actionObj.newStart) };
      return { ok: true, data: { message: 'Clip moved to ' + actionObj.newStart + 's' } };
    }
    if (action === 'trim_clip') {
      var tmtrack = collectionToArray(seq.videoTracks)[actionObj.trackIndex];
      var tmclip  = tmtrack && collectionToArray(tmtrack.clips)[actionObj.clipIndex];
      if (!tmclip) throw new Error('Clip not found');
      if (actionObj.newIn  != null) tmclip.inPoint  = { ticks: secToTicks(actionObj.newIn) };
      if (actionObj.newOut != null) tmclip.outPoint = { ticks: secToTicks(actionObj.newOut) };
      return { ok: true, data: { message: 'Clip trimmed' } };
    }
    return { ok: false, error: 'Unknown action: ' + action };
  } catch(e) { return { ok: false, error: e.message }; }
}

// ── Premiere event listeners (real-time sequence tracking) ─────────────────

async function registerTimelineEvents() {
  if (!ppro) return;

  var handler = function() {
    console.log('[Plugin] Sequence change detected');
    refreshTimeline();
  };

  // Candidate event names across different Premiere Pro versions
  var EVENT_NAMES = [
    'onActiveSequenceChanged',
    'activeSequenceChanged',
    'onSequenceActivated',
    'sequenceActivated',
    'onActiveItemChanged',
  ];

  // Candidate objects to attach listeners to
  var targets = [ppro, ppro.app, ppro.Project].filter(Boolean);

  // Also try the project instance
  try {
    var proj = await getActiveProject();
    if (proj) targets.push(proj);
  } catch(e) {}

  var registered = 0;
  targets.forEach(function(target) {
    if (typeof target.addEventListener !== 'function') return;
    EVENT_NAMES.forEach(function(name) {
      try {
        target.addEventListener(name, handler);
        registered++;
        console.log('[Plugin] Listening:', name, 'on', target);
      } catch(e) { /* not supported */ }
    });
  });

  // Also listen to VideoTrack/AudioTrack class-level events (track content changes)
  var TRACK_EVENTS = [
    ppro.VideoTrack && ppro.VideoTrack.EVENT_TRACK_CHANGED,
    ppro.VideoTrack && ppro.VideoTrack.EVENT_TRACK_INFO_CHANGED,
    ppro.AudioTrack && ppro.AudioTrack.EVENT_TRACK_CHANGED,
  ].filter(Boolean);

  TRACK_EVENTS.forEach(function(evtName) {
    try {
      ppro.app && ppro.app.addEventListener(evtName, handler);
    } catch(e) {}
  });

  console.log('[Plugin] Event registrations attempted:', registered);
}

// ── Version ────────────────────────────────────────────────────────────────
var PLUGIN_VERSION = 'v4.2.0-beta.22';

// ── State ──────────────────────────────────────────────────────────────────

var BRIDGE_URL      = 'http://localhost:3030';
var CLAUDE_MODEL    = 'claude-sonnet-4-6';
var ANTHROPIC_KEY   = ''; // user-provided API key (optional)
var ELEVENLABS_KEY  = '03dcac8c36d58c119bbc3f070afb142de39d019444ac20311682eb2b42e6c900'; // default key — overridden by user Settings
var EL_PROFILES     = []; // [{id, name, key}, ...] — saved ElevenLabs key profiles
var EL_ACTIVE_PROFILE_ID = null; // id of the profile whose key is in ELEVENLABS_KEY
var RATE_LIMIT_UNTIL = 0; // epoch ms — until when we shouldn't retry CLI
var messages        = [];
var timelineContext = null;
var isStreaming     = false;
var attachedImages  = []; // [{name, mediaType, base64, dataUrl}]

// ── DOM ────────────────────────────────────────────────────────────────────

var chatArea       = document.getElementById('chat-area');
var emptyState     = document.getElementById('empty-state');
var msgInput       = document.getElementById('message-input');
var sendBtn        = document.getElementById('send-btn');
var statusDot      = document.getElementById('status-dot');
var statusText     = document.getElementById('status-text');
var timelineInfo   = document.getElementById('timeline-info');
var contextPanel   = document.getElementById('context-panel');
var contextContent = document.getElementById('context-content');
var settingsModal  = document.getElementById('settings-modal');
var bridgeUrlInput = document.getElementById('bridge-url-input');

// ── Init ───────────────────────────────────────────────────────────────────

document.getElementById('plugin-version').textContent = PLUGIN_VERSION;
console.log('[Claude AI Plugin] Loaded', PLUGIN_VERSION);

loadSettings();
checkBridge();
refreshTimeline();
registerTimelineEvents();        // primary: event-driven
setInterval(checkBridge, 15000); // health check every 15s
setInterval(pollTimeline, 5000); // fallback poll every 5s (skips if unchanged)
setTimeout(checkPluginUpdate, 4000); // version check after bridge has time to connect

// ── Bridge health ──────────────────────────────────────────────────────────

var REQUIRED_BRIDGE = '1.2.0'; // Plugin v1.4.5+ requires bridge ≥1.2.0
var bridgeHealth = null;

function checkBridge() {
  setStatus('connecting', 'Connecting to bridge...');
  var xhr = new XMLHttpRequest();
  xhr.timeout = 4000;
  xhr.open('GET', BRIDGE_URL + '/health', true);
  xhr.onload = function() {
    if (xhr.status === 200) {
      try {
        bridgeHealth = JSON.parse(xhr.responseText);
        // Check version — warn if too old (multimodal capability missing)
        var caps = bridgeHealth.capabilities || {};
        if (!caps.multimodal) {
          setStatus('warn', 'Bridge v' + (bridgeHealth.version || '?') +
            ' too old — restart server.js (need ≥' + REQUIRED_BRIDGE + ')');
          return;
        }
        setStatus('connected', 'Bridge v' + bridgeHealth.version +
          ' · ' + (bridgeHealth.mode === 'api-key' ? 'API' : 'CLI'));
      } catch(e) {
        setStatus('connected', 'Bridge connected');
      }
    } else {
      setStatus('offline', 'Bridge error: ' + xhr.status);
    }
  };
  xhr.onerror   = function() { setStatus('offline', 'Bridge offline — run start.command'); };
  xhr.ontimeout = function() { setStatus('offline', 'Bridge timeout — is it running?'); };
  xhr.send();
}

function setStatus(state, text) {
  statusDot.className = state === 'connected' ? 'connected'
                      : state === 'connecting' ? 'connecting'
                      : state === 'warn' ? 'warn'
                      : '';
  statusText.textContent = text;
}

// ── Plugin auto-update ─────────────────────────────────────────────────────

var _pluginUpdateDismissed = false;

function checkPluginUpdate() {
  if (_pluginUpdateDismissed) return;
  var current = PLUGIN_VERSION.replace(/^v/, '');
  var xhr = new XMLHttpRequest();
  xhr.timeout = 10000;
  xhr.open('POST', BRIDGE_URL + '/plugin/check-update', true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onload = function() {
    try {
      var data = JSON.parse(xhr.responseText);
      if (data.ok && data.hasUpdate) showPluginUpdateBanner(data.latestVersion, data.downloadUrl);
    } catch(e) {}
  };
  xhr.onerror = function() {};
  xhr.ontimeout = function() {};
  xhr.send(JSON.stringify({ currentVersion: current }));
}

function showPluginUpdateBanner(latestVersion, downloadUrl) {
  var banner  = document.getElementById('pluginUpdateBanner');
  var msg     = document.getElementById('pluginUpdateMsg');
  var updateBtn = document.getElementById('pluginUpdateBtn');
  var dismissBtn = document.getElementById('pluginUpdateDismiss');
  if (!banner || !msg) return;

  msg.textContent = 'Plugin v' + latestVersion + ' available';
  banner.hidden = false;

  updateBtn.onclick = function() {
    updateBtn.disabled = true;
    updateBtn.textContent = 'Downloading…';
    msg.textContent = 'Downloading Plugin v' + latestVersion + '…';
    var xhr2 = new XMLHttpRequest();
    xhr2.timeout = 60000;
    xhr2.open('POST', BRIDGE_URL + '/plugin/update', true);
    xhr2.setRequestHeader('Content-Type', 'application/json');
    xhr2.onload = function() {
      try {
        var data = JSON.parse(xhr2.responseText);
        if (data.ok) {
          msg.textContent = 'Creative Cloud đang mở — click Install, sau đó Reload plugin trong Premiere';
          updateBtn.hidden = true;
        } else {
          msg.textContent = '✗ ' + (data.error || 'Update failed');
          updateBtn.disabled = false;
          updateBtn.textContent = 'Retry';
        }
      } catch(e) {}
    };
    xhr2.onerror = function() {
      msg.textContent = '✗ Bridge offline';
      updateBtn.disabled = false;
      updateBtn.textContent = 'Retry';
    };
    xhr2.send(JSON.stringify({ downloadUrl: downloadUrl, version: latestVersion }));
  };

  dismissBtn.onclick = function() {
    banner.hidden = true;
    _pluginUpdateDismissed = true;
  };
}

// ── Timeline context ───────────────────────────────────────────────────────

var _lastSeqFingerprint = null;

// A cheap fingerprint of the sequence: name + track counts + clip count.
// Changes here trigger a full refresh (so editor adding a clip is detected).
async function getSeqFingerprint() {
  try {
    var seq = await getActiveSequence();
    if (!seq) return null;
    var vc = await seq.getVideoTrackCount();
    var ac = await seq.getAudioTrackCount();
    var clipCount = 0;
    for (var i = 0; i < vc; i++) {
      var t = await seq.getVideoTrack(i);
      var items = await getClipItems(t);
      clipCount += items.length;
    }
    for (var j = 0; j < ac; j++) {
      var ta = await seq.getAudioTrack(j);
      var itemsa = await getClipItems(ta);
      clipCount += itemsa.length;
    }
    return seq.name + '|v' + vc + '|a' + ac + '|c' + clipCount;
  } catch(e) {
    return null;
  }
}

async function pollTimeline() {
  var fp = await getSeqFingerprint();
  if (fp !== _lastSeqFingerprint) {
    _lastSeqFingerprint = fp;
    if (fp === null) {
      timelineContext = null;
      timelineInfo.textContent = 'No active sequence';
      contextPanel.classList.remove('visible');
    } else {
      await refreshTimeline();
    }
  }
}

async function refreshTimeline() {
  var result = await ppGetTimelineInfo();
  if (result.ok) {
    timelineContext = result.data;
    var d = result.data;
    timelineInfo.textContent = d.sequenceName + ' · ' + d.clips.length + ' clips';
    contextPanel.classList.add('visible');
    var shapeInfo = d._apiShape
      ? ' <span style="color:#555;font-size:10px;">[track:' + (d._apiShape.trackCountProp||'?') +
        ' clip:' + (d._apiShape.clipCountProp||'?') + ']</span>'
      : '';
    contextContent.innerHTML =
      '<div class="ctx-row">' +
        '<span><span class="ctx-label">Sequence:</span> ' + esc(d.sequenceName) + '</span>' +
        '<span><span class="ctx-label">Duration:</span> ' + d.durationSec.toFixed(1) + 's</span>' +
        '<span><span class="ctx-label">Video:</span> ' + d.videoTrackCount + ' tracks</span>' +
        '<span><span class="ctx-label">Audio:</span> ' + d.audioTrackCount + ' tracks</span>' +
        '<span><span class="ctx-label">Clips:</span> ' + d.clips.length + '</span>' +
        shapeInfo +
      '</div>';
  } else {
    timelineContext = null;
    timelineInfo.textContent = 'No active sequence';
    contextPanel.classList.remove('visible');
  }
}

// ── Send message ───────────────────────────────────────────────────────────

function sendMessage() {
  var content = (msgInput.value == null ? '' : String(msgInput.value)).trim();
  // Allow send if EITHER text OR images present
  if ((!content && attachedImages.length === 0) || isStreaming) return;

  msgInput.value = '';
  autoResize();
  isStreaming = true;
  sendBtn.disabled = true;
  emptyState.style.display = 'none';

  // Build content array (multimodal). If only text, send plain string for backward compat.
  var userMessage;
  if (attachedImages.length > 0) {
    var parts = attachedImages.map(function(img) {
      return { type: 'image', mediaType: img.mediaType, data: img.base64, name: img.name };
    });
    if (content) parts.push({ type: 'text', text: content });
    else         parts.push({ type: 'text', text: 'Parse this cutsheet into a cutlist action.' });
    userMessage = { role: 'user', content: parts };
  } else {
    userMessage = { role: 'user', content: content };
  }

  messages.push(userMessage);
  appendMessageWithAttachments('user', content, attachedImages);

  // Clear attachments after sending (dropzone will hide because messages>0)
  attachedImages = [];
  if (typeof window.refreshDropzoneState === 'function') window.refreshDropzoneState();

  // Detect voice-related messages — inject available voices for auto-pick
  var voiceContext = null;
  if (content && /voice|narrat|speak|script.*gen|gen.*voice|audio.*gen|pick.*voice|choose.*voice/i.test(content)) {
    if (typeof window.VoiceGenGetVoices === 'function') {
      var vList = window.VoiceGenGetVoices().filter(function(v){ return !v.isSep; });
      if (vList.length > 0) {
        voiceContext = vList.map(function(v){ return v.voice_id + ': ' + v.label; }).join('\n');
      }
    }
  }

  var typingEl        = appendTyping();
  var xhr             = new XMLHttpRequest();
  var lastLen         = 0;
  var assistantEl     = null;
  var bubbleEl        = null;
  var fullText        = '';
  var typingRemoved   = false;
  var finished        = false;
  var pendingRateLimit = null; // deferred — only shown if no text follows

  // Lazy helpers so we don't depend on readyState 2 firing
  function removeTyping() {
    if (!typingRemoved) {
      typingRemoved = true;
      if (typingEl.parentNode) typingEl.remove();
    }
  }

  function ensureBubble() {
    if (!assistantEl) {
      assistantEl = appendMessage('assistant', '');
      bubbleEl    = assistantEl.querySelector('.bubble');
    }
  }

  function parseSSE() {
    var text  = xhr.responseText || '';
    var chunk = text.slice(lastLen);
    lastLen   = text.length;
    if (!chunk) return;

    chunk.split('\n').forEach(function(line) {
      if (!line.startsWith('data: ')) return;
      var raw = line.slice(6);
      if (raw === '[DONE]') return;
      try {
        var ev = JSON.parse(raw);
        if (ev.type === 'text') {
          removeTyping();
          ensureBubble();
          fullText += ev.content;
          bubbleEl.innerHTML = renderMd(fullText);
          chatArea.scrollTop = chatArea.scrollHeight;
        } else if (ev.type === 'tool_use') {
          // Show "calling tool: Read" so user knows CLI is working
          ensureBubble();
          var toolNote = '<div style="color:#888;font-style:italic;font-size:11px;">⚙ ' +
                         esc('Claude calling tool: ' + (ev.name || 'unknown')) + '</div>';
          if (!fullText) bubbleEl.innerHTML = toolNote;
        } else if (ev.type === 'heartbeat') {
          // heartbeat — typing indicator still visible; no tooltip in UXP
        } else if (ev.type === 'rate_limit') {
          // Defer rendering — Claude Code CLI often auto-retries and succeeds.
          // Only render the bubble in finishStreaming if no text came after this.
          var resetAt = ev.resetAt || null;
          if (resetAt) RATE_LIMIT_UNTIL = resetAt;
          pendingRateLimit = { resetAt: resetAt, source: ev.source, raw: ev.raw };
        } else if (ev.type === 'error') {
          removeTyping();
          ensureBubble();
          bubbleEl.innerHTML = '<span style="color:var(--error)">' + esc(ev.content) + '</span>';
        } else if (ev.type === 'done') {
          removeTyping();
        }
      } catch(e) { /* skip */ }
    });
  }

  xhr.open('POST', BRIDGE_URL + '/chat', true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.responseType = 'text';

  xhr.onreadystatechange = function() {
    // Parse any new SSE data on every progress event
    if (xhr.readyState === 3 || xhr.readyState === 4) {
      parseSSE();
    }

    if (xhr.readyState === 4 && !finished) {
      finished = true;
      removeTyping();

      if (assistantEl) {
        finishStreaming(fullText, assistantEl, pendingRateLimit); // async, fire-and-forget ok
      } else if (pendingRateLimit) {
        // Rate-limit fired but no text was streamed at all
        var rlMsg = appendMessage('assistant', '');
        var rlBubble = rlMsg ? (rlMsg.querySelector('.bubble') || rlMsg) : null;
        if (rlBubble) renderRateLimitBubble(rlBubble, pendingRateLimit.resetAt, pendingRateLimit.source, pendingRateLimit.raw);
        resetInput();
      } else {
        // Got a response but no text events — check status
        var statusMsg = xhr.status === 0
          ? '❌ Không kết nối được bridge.\n\nMở Terminal và chạy:\n  cd /Users/crossian/premiere-claude-plugin/bridge\n  node server.js'
          : '❌ Bridge trả về lỗi HTTP ' + xhr.status;
        appendMessage('assistant', statusMsg);
        resetInput();
      }
    }
  };

  xhr.onerror = function() {
    if (finished) return;
    finished = true;
    removeTyping();
    appendMessage('assistant', '❌ Không kết nối được bridge.\n\nMở Terminal và chạy:\n  cd /Users/crossian/premiere-claude-plugin/bridge\n  node server.js');
    resetInput();
  };

  xhr.ontimeout = function() {
    if (finished) return;
    finished = true;
    removeTyping();
    appendMessage('assistant', '❌ Request timeout — bridge quá chậm hoặc không phản hồi.');
    resetInput();
  };

  xhr.timeout = 300000; // 5 min — CLI image parsing can be slow
  xhr.send(JSON.stringify({
    messages:        messages,
    timelineContext: timelineContext,
    model:           CLAUDE_MODEL,
    apiKey:          ANTHROPIC_KEY || undefined,
    voiceContext:    voiceContext || undefined,
  }));
}

async function finishStreaming(fullText, assistantEl, pendingRateLimit) {
  messages.push({ role: 'assistant', content: fullText });

  // Only show rate-limit bubble if no text was received (CLI didn't auto-recover)
  if (pendingRateLimit && !fullText) {
    var bEl = assistantEl ? (assistantEl.querySelector('.bubble') || assistantEl) : null;
    if (bEl) renderRateLimitBubble(bEl, pendingRateLimit.resetAt, pendingRateLimit.source, pendingRateLimit.raw);
  }

  var actions = parseActions(fullText);
  if (actions.length > 0) {
    await executeActions(actions, assistantEl);
    refreshTimeline(); // async, fire-and-forget
  }
  resetInput();
}

function resetInput() {
  isStreaming      = false;
  sendBtn.disabled = false;
  msgInput.focus();
}

// ── Parse ```actions blocks ────────────────────────────────────────────────

function parseActions(text) {
  var results = [];
  var re = /```actions\s*([\s\S]*?)```/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    try {
      var parsed = JSON.parse(m[1].trim());
      results = results.concat(Array.isArray(parsed) ? parsed : [parsed]);
    } catch(e) { /* skip */ }
  }
  return results;
}

async function executeActions(actions, parentEl) {
  var bubbleEl = parentEl.querySelector('.bubble') || parentEl;

  var divider = document.createElement('div');
  divider.style.cssText = 'border-top:1px solid #2d4a2d;margin-top:8px;padding-top:8px;';
  bubbleEl.appendChild(divider);

  for (var i = 0; i < actions.length; i++) {
    var action = actions[i];
    var chip   = document.createElement('div');
    chip.className   = 'action-result';
    chip.textContent = '⚙ ' + action.action + '…';
    bubbleEl.appendChild(chip);

    var result = await ppExecuteAction(action);   // ← await async API
    if (result.ok) {
      chip.textContent = '✓ ' + (result.data.message || action.action);
    } else {
      chip.className   = 'action-result error';
      chip.textContent = '✗ ' + action.action + ': ' + result.error;
    }
    chatArea.scrollTop = chatArea.scrollHeight;
  }
}

// ── DOM helpers ────────────────────────────────────────────────────────────

function appendMessage(role, content) {
  return appendMessageWithAttachments(role, content, []);
}

function appendMessageWithAttachments(role, content, attachments) {
  var wrapper  = document.createElement('div');
  wrapper.className = 'message ' + role;

  var roleEl = document.createElement('span');
  roleEl.className = 'role';
  roleEl.textContent = role === 'user' ? 'You' : 'Claude';

  var bubbleEl = document.createElement('div');
  bubbleEl.className = 'bubble';

  // Render attached images first
  if (attachments && attachments.length > 0) {
    var attachWrap = document.createElement('div');
    attachWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;';
    attachments.forEach(function(att) {
      var thumb = document.createElement('img');
      thumb.src = att.dataUrl;
      thumb.alt = att.name || 'image';

      thumb.style.cssText = 'max-width:200px;max-height:200px;border-radius:6px;border:1px solid var(--border);cursor:pointer;';
      thumb.onclick = function() {
        // Toggle full-size view
        if (thumb.style.maxWidth === '100%') {
          thumb.style.maxWidth = '200px';
          thumb.style.maxHeight = '200px';
        } else {
          thumb.style.maxWidth = '100%';
          thumb.style.maxHeight = 'none';
        }
      };
      attachWrap.appendChild(thumb);
    });
    bubbleEl.appendChild(attachWrap);
  }

  var textEl = document.createElement('div');
  textEl.innerHTML = renderMd(content || '');
  bubbleEl.appendChild(textEl);

  wrapper.appendChild(roleEl);
  wrapper.appendChild(bubbleEl);
  chatArea.appendChild(wrapper);
  chatArea.scrollTop = chatArea.scrollHeight;
  return wrapper;
}

function appendTyping() {
  var wrapper  = document.createElement('div');
  wrapper.className = 'message assistant';

  var roleEl = document.createElement('span');
  roleEl.className = 'role';
  roleEl.textContent = 'Claude';

  var indic = document.createElement('div');
  indic.className = 'typing-indicator';
  for (var i = 0; i < 3; i++) {
    var dot = document.createElement('span');
    indic.appendChild(dot);
  }

  wrapper.appendChild(roleEl);
  wrapper.appendChild(indic);
  chatArea.appendChild(wrapper);
  chatArea.scrollTop = chatArea.scrollHeight;
  return wrapper;
}

// Minimal markdown: code blocks, inline code, bold, newlines
// Hides ```actions blocks from the chat display
function renderMd(text) {
  return esc(text)
    .replace(/```actions[\s\S]*?```/g, '')
    .replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

function esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── UXP keyboard focus helper ──────────────────────────────────────────────
// While a textarea has focus, Premiere Pro's keyboard shortcuts (e.g. B→Brush, V→Move)
// would fire if we don't claim keyboard focus. setKeyboardFocus(true) prevents that.
(function() {
  var _uxpHost = null;
  try { var _u = window.require && window.require('uxp'); if (_u && _u.host) _uxpHost = _u.host; } catch(e) {}

  window.claimKeyboard = function() {
    if (_uxpHost && typeof _uxpHost.setKeyboardFocus === 'function') {
      try { _uxpHost.setKeyboardFocus(true); } catch(e) {}
    }
  };
  window.releaseKeyboard = function() {
    if (_uxpHost && typeof _uxpHost.setKeyboardFocus === 'function') {
      try { _uxpHost.setKeyboardFocus(false); } catch(e) {}
    }
  };
})();


// Wire keyboard focus for every text input/textarea in the Claude tab
// Wire all text inputs in the settings panel and Claude tab
(function() {
  var inputs = document.querySelectorAll(
    '#bridge-url-input, #api-key-input, #model-select'
  );
  inputs.forEach(function(el) {
    el.addEventListener('focus', window.claimKeyboard);
    el.addEventListener('blur',  window.releaseKeyboard);
  });
})();

// ── Auto-resize textarea ───────────────────────────────────────────────────

function autoResize() {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 180) + 'px';
}

// VoiceGen textarea auto-resize: set height to '1px' first so the browser is forced
// to reflow and report the true content height via scrollHeight, then lock that in.
// Sizer div drives wrapper height — no scrollHeight tricks needed (UXP-safe).
function vgAutoResize(el) {
  var sizer = el.parentNode && el.parentNode.querySelector('.vg-scriptSizer');
  if (!sizer) return;
  sizer.textContent = (el.value || '') + '\n';
}

msgInput.addEventListener('input', autoResize);
msgInput.addEventListener('focus', window.claimKeyboard);
msgInput.addEventListener('blur',  window.releaseKeyboard);
msgInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
sendBtn.addEventListener('click', sendMessage);

// ── Quick action buttons + Custom shortcuts ────────────────────────────────

// Built-in "Parse cutsheet" button
document.querySelectorAll('.quick-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    msgInput.value = btn.dataset.prompt;
    autoResize();
    msgInput.focus();
  });
});

// Custom shortcuts — stored in localStorage as [{name, prompt}]
function loadShortcuts() {
  try { return JSON.parse(localStorage.getItem('claude-shortcuts') || '[]'); } catch(e) { return []; }
}
function saveShortcuts(arr) {
  try { localStorage.setItem('claude-shortcuts', JSON.stringify(arr)); } catch(e) {}
}

function renderShortcuts() {
  var container = document.getElementById('quick-actions');
  var addBtn    = document.getElementById('add-shortcut-btn');
  if (!container || !addBtn) return;
  // Remove any previously rendered custom buttons (class = custom-shortcut-btn)
  container.querySelectorAll('.custom-shortcut-btn').forEach(function(el) { el.remove(); });
  var shortcuts = loadShortcuts();
  shortcuts.forEach(function(sc, idx) {
    var btn = document.createElement('button');
    btn.className = 'quick-btn custom-shortcut-btn';
    btn.textContent = sc.name || ('Shortcut ' + (idx + 1));
    btn.dataset.promptFull = sc.prompt; // stored for reference, no title (UXP tooltip renders wrong)
    btn.dataset.prompt = sc.prompt;
    btn.addEventListener('click', function() {
      msgInput.value = sc.prompt;
      autoResize();
      msgInput.focus();
    });
    // Long-press / right-click to delete
    btn.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      if (confirm('Delete shortcut "' + sc.name + '"?')) {
        var arr = loadShortcuts();
        arr.splice(idx, 1);
        saveShortcuts(arr);
        renderShortcuts();
      }
    });
    container.insertBefore(btn, addBtn);
  });
}

var _scPopup = null;
function closeShortcutPopup() {
  if (_scPopup && _scPopup.parentNode) _scPopup.parentNode.removeChild(_scPopup);
  _scPopup = null;
  document.removeEventListener('click', _scOutsideHandler, true);
  // Restore the textarea row
  var inputRow = document.getElementById('input-row');
  if (inputRow) inputRow.style.display = '';
}
function _scOutsideHandler(e) {
  if (_scPopup && !_scPopup.contains(e.target) && e.target.id !== 'add-shortcut-btn') {
    closeShortcutPopup();
  }
}
function showAddShortcutPopup() {
  if (_scPopup) { closeShortcutPopup(); return; }
  var triggerBtn  = document.getElementById('add-shortcut-btn');
  var quickActions = document.getElementById('quick-actions');
  var inputRow    = document.getElementById('input-row');

  // ── Hide the main textarea while popup is open ─────────────────────────
  // Native <textarea> in UXP/Chromium renders in a higher compositor layer
  // and always paints above any absolutely-positioned element.
  // Hiding #input-row eliminates the overlap completely.
  if (inputRow) inputRow.style.display = 'none';

  var popup = document.createElement('div');
  popup.className = 'shortcut-popup';
  _scPopup = popup;

  popup.innerHTML =
    '<div class="sp-title">New shortcut</div>' +
    '<input class="sp-name" placeholder="Button label…" maxlength="24">' +
    '<textarea class="sp-prompt" placeholder="Prompt text…" rows="3"></textarea>' +
    '<div class="sp-actions">' +
      '<button class="sp-cancel">Cancel</button>' +
      '<button class="sp-save">Save</button>' +
    '</div>';

  // Append to #tab-claude (position:relative, overflow:visible) so the popup
  // isn't clipped by #claude-content (overflow:hidden).
  var container = document.getElementById('tab-claude') || document.body;
  container.appendChild(popup);

  // ── Position: left-aligned, bottom just above #quick-actions ──────────
  // Measure after appending so the browser knows the popup dimensions.
  var contRect = container.getBoundingClientRect();
  var pw       = Math.min(220, (contRect.width || 240) - 16);
  popup.style.width = pw + 'px';

  // Horizontal: 8 px from panel left edge
  popup.style.left = '8px';

  // Vertical: anchor popup bottom to quick-actions top, 8 px gap
  var anchor = quickActions || triggerBtn;
  if (anchor) {
    var anchorRect  = anchor.getBoundingClientRect();
    var anchorTopRel = anchorRect.top - contRect.top; // relative to #tab-claude
    var popH = popup.offsetHeight || 178;
    var top  = anchorTopRel - popH - 8;
    if (top < 4) top = 4;
    popup.style.top = top + 'px';
  }

  popup.querySelector('.sp-cancel').addEventListener('click', function(e) {
    e.stopPropagation(); closeShortcutPopup();
  });
  popup.querySelector('.sp-save').addEventListener('click', function(e) {
    e.stopPropagation();
    var name   = popup.querySelector('.sp-name').value.trim();
    var prompt = popup.querySelector('.sp-prompt').value.trim();
    if (!name || !prompt) { alert('Name and prompt are required.'); return; }
    var arr = loadShortcuts();
    arr.push({ name: name, prompt: prompt });
    saveShortcuts(arr);
    renderShortcuts();
    closeShortcutPopup();
  });

  setTimeout(function() {
    document.addEventListener('click', _scOutsideHandler, true);
    try { popup.querySelector('.sp-name').focus(); } catch(e) {}
  }, 20);
}

document.getElementById('add-shortcut-btn').addEventListener('click', function(e) {
  e.stopPropagation();
  showAddShortcutPopup();
});

// Initial render
renderShortcuts();

// ── Clear chat ─────────────────────────────────────────────────────────────

document.getElementById('clear-btn').addEventListener('click', function() {
  messages = [];
  attachedImages = [];
  chatArea.innerHTML = '';
  emptyState.style.display = '';
  chatArea.appendChild(emptyState);
  if (typeof window.refreshDropzoneState === 'function') window.refreshDropzoneState();
});

// ── Refresh button ─────────────────────────────────────────────────────────

document.getElementById('refresh-btn').addEventListener('click', function() {
  console.log('[Plugin] Manual refresh triggered');
  _lastSeqFingerprint = null; // invalidate cache, force full re-scan
  refreshTimeline();
  checkBridge();
});

// ── Settings ───────────────────────────────────────────────────────────────

var modelSelect = document.getElementById('model-select');
var apiKeyInput = document.getElementById('api-key-input');
var apiKeyStatus = document.getElementById('apikey-status');
// ElevenLabs key is now managed in the Voice Gen tab settings panel, not here.
var elKeyInput = null; // removed from Claude Settings panel
var elStatus   = null;

// UXP localStorage CAN persist across plugin reloads but is sometimes wiped
// when the plugin is reloaded via UXP Developer Tool (vs. just panel close).
// We also persist to UXP's local data folder as a backup.
async function persistSettingsToFile(obj) {
  try {
    var uxp = window.require && window.require('uxp');
    if (!uxp || !uxp.storage) return;
    var lfs = uxp.storage.localFileSystem;
    var dataFolder = await lfs.getDataFolder();
    var file = await dataFolder.createFile('settings.json', { overwrite: true });
    await file.write(JSON.stringify(obj));
    console.log('[Settings] persisted to UXP data folder:', dataFolder.nativePath);
  } catch(e) { console.warn('[Settings] file persist failed:', e.message); }
}

async function loadSettingsFromFile() {
  try {
    var uxp = window.require && window.require('uxp');
    if (!uxp || !uxp.storage) return null;
    var lfs = uxp.storage.localFileSystem;
    var dataFolder = await lfs.getDataFolder();
    var entries = await dataFolder.getEntries();
    var file = entries.find(function(e) { return e.name === 'settings.json'; });
    if (!file) return null;
    var text = await file.read();
    return JSON.parse(text);
  } catch(e) { console.warn('[Settings] file load failed:', e.message); return null; }
}

function applySettings(s) {
  if (!s) return;
  if (s.bridgeUrl)     BRIDGE_URL    = s.bridgeUrl;
  if (s.claudeModel)   CLAUDE_MODEL  = s.claudeModel;
  if (s.anthropicKey)  ANTHROPIC_KEY = s.anthropicKey;
  if (s.elevenlabsKey) ELEVENLABS_KEY = s.elevenlabsKey;
  // Load profiles; migrate legacy single-key to a Default profile
  if (Array.isArray(s.elevenlabsProfiles) && s.elevenlabsProfiles.length) {
    EL_PROFILES = s.elevenlabsProfiles;
    EL_ACTIVE_PROFILE_ID = s.elevenlabsActiveProfileId || EL_PROFILES[0].id;
    var active = EL_PROFILES.find(function(p) { return p.id === EL_ACTIVE_PROFILE_ID; });
    if (active) ELEVENLABS_KEY = active.key;
  } else if (s.elevenlabsKey && !EL_PROFILES.length) {
    var defId = 'p_default';
    EL_PROFILES = [{ id: defId, name: 'Default', key: s.elevenlabsKey }];
    EL_ACTIVE_PROFILE_ID = defId;
  }
  // Always guarantee at least one profile (uses the built-in default key).
  if (!EL_PROFILES.length) {
    EL_PROFILES = [{ id: 'p_default', name: 'Default', key: ELEVENLABS_KEY }];
    EL_ACTIVE_PROFILE_ID = 'p_default';
  }
  if (bridgeUrlInput) bridgeUrlInput.value = BRIDGE_URL;
  if (modelSelect)    modelSelect.value = CLAUDE_MODEL;
  if (apiKeyInput)    apiKeyInput.value = ANTHROPIC_KEY;
  if (elKeyInput)     elKeyInput.value  = ELEVENLABS_KEY;
  updateApiKeyStatus();
  updateElStatus();
}

function loadSettings() {
  // First try localStorage (sync, fast)
  try {
    var s = JSON.parse(localStorage.getItem('claude-plugin-settings') || '{}');
    applySettings(s);
    console.log('[Settings] loaded from localStorage — el-key len:', (ELEVENLABS_KEY||'').length);
  } catch(e) { console.warn('[Settings] localStorage load failed:', e.message); }

  // Then try UXP data folder (async, fallback for fresh localStorage)
  loadSettingsFromFile().then(function(fileSettings) {
    if (fileSettings) {
      // Only apply file settings if they have more data than what we already have
      var hasNew = false;
      if (fileSettings.elevenlabsKey && !ELEVENLABS_KEY) { ELEVENLABS_KEY = fileSettings.elevenlabsKey; hasNew = true; }
      if (fileSettings.anthropicKey  && !ANTHROPIC_KEY)  { ANTHROPIC_KEY  = fileSettings.anthropicKey;  hasNew = true; }
      if (Array.isArray(fileSettings.elevenlabsProfiles) && fileSettings.elevenlabsProfiles.length && !EL_PROFILES.length) {
        EL_PROFILES = fileSettings.elevenlabsProfiles;
        EL_ACTIVE_PROFILE_ID = fileSettings.elevenlabsActiveProfileId || EL_PROFILES[0].id;
        var fp = EL_PROFILES.find(function(p) { return p.id === EL_ACTIVE_PROFILE_ID; });
        if (fp) ELEVENLABS_KEY = fp.key;
        hasNew = true;
      }
      if (hasNew) {
        if (elKeyInput)  elKeyInput.value  = ELEVENLABS_KEY;
        if (apiKeyInput) apiKeyInput.value = ANTHROPIC_KEY;
        updateApiKeyStatus();
        updateElStatus();
        console.log('[Settings] hydrated from file backup');
        if (typeof window.VoiceGenOnKeyChange === 'function') window.VoiceGenOnKeyChange();
      }
    }
  });
}

function updateElStatus() {
  if (!elStatus) return;
  if (ELEVENLABS_KEY) {
    // Show preview: first 4 + last 4 chars (e.g. "sk_5...574f")
    var k = ELEVENLABS_KEY;
    var preview = k.length > 12 ? (k.slice(0, 5) + '…' + k.slice(-4)) : 'ready';
    elStatus.textContent = preview;
    elStatus.classList.add('is-api');
  } else {
    elStatus.textContent = 'not set';
    elStatus.classList.remove('is-api');
  }
}
function updateApiKeyStatus() {
  if (!apiKeyStatus) return;
  if (ANTHROPIC_KEY) {
    var k = ANTHROPIC_KEY;
    var preview = k.length > 12 ? (k.slice(0, 7) + '…' + k.slice(-4)) : 'ready';
    apiKeyStatus.textContent = 'API · ' + preview;
    apiKeyStatus.classList.add('is-api');
  } else {
    apiKeyStatus.textContent = 'CLI mode';
    apiKeyStatus.classList.remove('is-api');
  }
}

function populateBridgeInfo() {
  var statusEl  = document.getElementById('bridge-info-status');
  var modeEl    = document.getElementById('bridge-info-mode');
  var whisperEl = document.getElementById('bridge-info-whisper');
  if (!statusEl) return;

  statusEl.textContent  = 'Checking…';
  modeEl.textContent    = '—';
  whisperEl.textContent = '—';

  var xhr = new XMLHttpRequest();
  xhr.open('GET', BRIDGE_URL + '/health', true);
  xhr.timeout = 4000;
  xhr.onload = function() {
    try {
      var d = JSON.parse(xhr.responseText);
      statusEl.innerHTML = '<span class="ok">connected</span> v' + (d.version || '?');
      modeEl.textContent = d.mode === 'api-key'
        ? 'API key (Anthropic SDK)'
        : 'CLI OAuth (Claude Code)';
      if (d.whisper) {
        whisperEl.innerHTML = (d.whisper.ok
          ? '<span class="ok">found</span>'
          : '<span class="fail">missing</span>') +
          ' · model=' + d.whisper.model + ' · lang=' + d.whisper.lang;
      }
    } catch(e) {
      statusEl.innerHTML = '<span class="fail">parse error</span>';
    }
  };
  xhr.onerror   = function() { statusEl.innerHTML = '<span class="fail">offline</span>'; };
  xhr.ontimeout = function() { statusEl.innerHTML = '<span class="fail">timeout</span>'; };
  xhr.send();
}

// Settings panel is position:absolute inside #tab-claude.
// Measure the actual header height at open time so we don't overlap it.
function openSettingsPanel() {
  var header     = document.getElementById('header');
  var statusBar  = document.getElementById('status-bar');
  var headerH    = header    ? (header.offsetTop    + header.offsetHeight)    : 40;
  var statusH    = statusBar ? (statusBar.offsetTop + statusBar.offsetHeight) : 0;
  var topPx      = Math.max(headerH, statusH) + 2;
  settingsModal.style.top = topPx + 'px';
  settingsModal.style.display = 'block';
  populateBridgeInfo();
  var spv = document.getElementById('settings-plugin-version');
  if (spv) spv.textContent = PLUGIN_VERSION;
  var cuStatus = document.getElementById('check-update-status');
  if (cuStatus) cuStatus.textContent = '';
}
function closeSettingsPanel() {
  settingsModal.style.display = 'none';
}

document.getElementById('settings-btn').addEventListener('click', function(e) {
  e.stopPropagation();
  if (settingsModal.style.display === 'block') closeSettingsPanel();
  else openSettingsPanel();
});
document.getElementById('close-settings').addEventListener('click', closeSettingsPanel);

document.getElementById('check-update-btn').addEventListener('click', function() {
  var btn      = document.getElementById('check-update-btn');
  var cuStatus = document.getElementById('check-update-status');
  btn.disabled = true;
  if (cuStatus) cuStatus.textContent = 'Checking…';
  var current = PLUGIN_VERSION.replace(/^v/, '');
  var xhr = new XMLHttpRequest();
  xhr.timeout = 10000;
  xhr.open('POST', BRIDGE_URL + '/plugin/check-update', true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onload = function() {
    btn.disabled = false;
    try {
      var data = JSON.parse(xhr.responseText);
      if (data.ok && data.hasUpdate) {
        if (cuStatus) cuStatus.textContent = 'v' + data.latestVersion + ' available!';
        _pluginUpdateDismissed = false;
        showPluginUpdateBanner(data.latestVersion, data.downloadUrl);
      } else if (data.ok) {
        if (cuStatus) cuStatus.textContent = 'Up to date ✓';
      } else {
        if (cuStatus) cuStatus.textContent = 'Check failed';
      }
    } catch(e) { if (cuStatus) cuStatus.textContent = 'Error'; }
  };
  xhr.onerror   = function() { btn.disabled = false; if (cuStatus) cuStatus.textContent = 'Bridge offline'; };
  xhr.ontimeout = function() { btn.disabled = false; if (cuStatus) cuStatus.textContent = 'Timeout'; };
  xhr.send(JSON.stringify({ currentVersion: current }));
});

// Click outside to close (check via DOM containment)
document.addEventListener('click', function(e) {
  if (settingsModal.style.display !== 'block') return;
  if (settingsModal.contains(e.target)) return;
  var btn = document.getElementById('settings-btn');
  if (btn && btn.contains(e.target)) return;
  closeSettingsPanel();
});
document.getElementById('save-settings').addEventListener('click', function() {
  // Defensive: in UXP webview, input.value can be null for empty password fields
  function readInput(el) {
    if (!el) return '';
    var v = el.value;
    if (v == null) return '';
    return String(v).trim();
  }
  console.log('[Settings] Save clicked. el-key-input element:', !!elKeyInput,
              '| value type:', elKeyInput ? typeof elKeyInput.value : 'N/A');
  BRIDGE_URL     = readInput(bridgeUrlInput) || 'http://localhost:3030';
  CLAUDE_MODEL   = (modelSelect && modelSelect.value) || CLAUDE_MODEL;
  ANTHROPIC_KEY  = readInput(apiKeyInput);
  // ElevenLabs key is managed in Voice Gen tab — don't overwrite it here
  console.log('[Settings] saved — anthropic:', ANTHROPIC_KEY.length, 'chars | elevenlabs managed in VoiceGen tab');
  var settingsObj = {
    bridgeUrl:                  BRIDGE_URL,
    claudeModel:                CLAUDE_MODEL,
    anthropicKey:               ANTHROPIC_KEY,
    elevenlabsKey:              ELEVENLABS_KEY,
    elevenlabsProfiles:         EL_PROFILES,
    elevenlabsActiveProfileId:  EL_ACTIVE_PROFILE_ID,
  };
  localStorage.setItem('claude-plugin-settings', JSON.stringify(settingsObj));
  // Also persist to UXP data folder as backup (survives some localStorage clears)
  persistSettingsToFile(settingsObj);
  updateApiKeyStatus();
  updateElStatus();
  if (ANTHROPIC_KEY) RATE_LIMIT_UNTIL = 0;
  closeSettingsPanel();
  checkBridge();
  // Notify Voice Gen module to refresh
  if (typeof window.VoiceGenOnKeyChange === 'function') window.VoiceGenOnKeyChange();
});

// ═══════════════════════════════════════════════════════════════════════════
// RATE-LIMIT COUNTDOWN BUBBLE
// ═══════════════════════════════════════════════════════════════════════════
function renderRateLimitBubble(bubbleEl, resetAtMs, source, rawEvent) {
  function fmt(s) {
    if (s <= 0) return '0:00';
    var m = Math.floor(s / 60), sec = s % 60;
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }
  var countdownBlock;
  if (resetAtMs) {
    // Real countdown from CLI event
    countdownBlock = '<div class="rl-countdown" id="rl-cd">--:--</div>' +
      '<div style="font-size:10px;color:var(--text-dim);">' +
        '✓ Reset time từ field <code>' + esc(source || 'unknown') + '</code>' +
      '</div>';
  } else {
    // Unknown — be honest, don't fake a countdown
    countdownBlock = '<div class="rl-countdown" style="color:#888;">unknown</div>' +
      '<div style="font-size:10px;color:var(--text-dim);">' +
        'CLI không expose reset time. ' +
        '<a href="#" id="rl-show-raw" style="color:#a855f7;">Show raw event</a>' +
      '</div>';
  }
  bubbleEl.innerHTML =
    '<div class="rate-limit-bubble">' +
      '<div class="rl-title">⚠ Claude subscription bị rate-limited</div>' +
      '<div>Subscription quota tạm hết. ' +
        (resetAtMs ? 'Đợi đến khi reset:' : 'Reset thời gian không xác định.') + '</div>' +
      countdownBlock +
      '<div class="rl-hint">' +
        '<b>Cách khác (không cần đợi):</b><br>' +
        '• Settings <code>⚙</code> → paste <code>ANTHROPIC_API_KEY</code> để dùng API mode<br>' +
        '• Mở tab <b>AUTOCUT</b> → <b>Manual Paste</b> → paste text trực tiếp (3 cột)' +
      '</div>' +
    '</div>';

  if (resetAtMs) {
    function tick() {
      var remain = Math.max(0, Math.ceil((resetAtMs - Date.now()) / 1000));
      var cd = document.getElementById('rl-cd');
      if (cd) cd.textContent = fmt(remain) + (remain > 0 ? '' : ' — ready');
      if (remain <= 0) clearInterval(timerId);
    }
    tick();
    var timerId = setInterval(tick, 1000);
  } else {
    // Show raw event on click — helps user paste exact JSON to me for further fix
    var link = document.getElementById('rl-show-raw');
    if (link && rawEvent) {
      link.addEventListener('click', function(e) {
        e.preventDefault();
        var pre = document.createElement('pre');
        pre.style.cssText = 'background:#111;padding:8px;border-radius:4px;font-size:10px;margin-top:6px;max-height:200px;overflow:auto;color:#888;';
        pre.textContent = JSON.stringify(rawEvent, null, 2);
        link.parentNode.appendChild(pre);
        link.style.display = 'none';
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// IMAGE ATTACH — attach button + drag-drop + clipboard paste
// (New layout: big dropzone replaced by small attach button; chips in #chips-row)
// ═══════════════════════════════════════════════════════════════════════════
(function() {
  var dropzone   = document.getElementById('dropzone');   // hidden, events-only
  var inputArea  = document.getElementById('input-area'); // drag target
  var dzChips    = document.getElementById('dropzone-chips');
  var chipsRow   = document.getElementById('chips-row');
  var attachBtn  = document.getElementById('attach-btn');

  var SUPPORTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
  var MAX_SIZE_MB = 8;

  // Convert ArrayBuffer to base64 (chunked to avoid call-stack overflow)
  function bufToBase64(buf) {
    var bytes = new Uint8Array(buf);
    var bin = '';
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function inferMediaType(name, fallback) {
    var lower = (name || '').toLowerCase();
    if (lower.endsWith('.png'))  return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif'))  return 'image/gif';
    return fallback || 'image/png';
  }

  function fmtSize(n) {
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + 'KB';
    return (n / (1024 * 1024)).toFixed(1) + 'MB';
  }

  // Single-image policy: always replace the existing attachment.
  function addAttachment(att) { addAttachmentSingle(att); }

  // Single attachment policy: replace existing if user picks a new one
  function addAttachmentSingle(att) {
    attachedImages = [att]; // overwrite any previous
    renderAttachBar();
  }

  window.renderAttachBar = function() {
    if (dzChips) dzChips.innerHTML = '';
    var hasChip = attachedImages.length > 0;

    if (hasChip) {
      if (chipsRow) chipsRow.removeAttribute('hidden');
      if (attachBtn) attachBtn.classList.add('has-file');

      var att = attachedImages[0];
      var chip = document.createElement('div');
      chip.className = 'attach-chip';
      chip.innerHTML =
        '<img src="' + att.dataUrl + '" alt="">' +
        '<div class="attach-meta">' +
          '<span class="attach-name" title="' + esc(att.name) + '">' + esc(att.name) + '</span>' +
          '<span class="attach-size">' + fmtSize(att.size || 0) + '</span>' +
        '</div>' +
        '<button class="attach-remove" title="Remove">&times;</button>';
      chip.querySelector('.attach-remove').addEventListener('click', function(e) {
        e.stopPropagation();
        attachedImages = [];
        window.renderAttachBar();
      });
      chip.querySelector('img').addEventListener('click', function(e) {
        e.stopPropagation();
        var img = e.target;
        if (img.style.width === '160px') { img.style.width = '40px'; img.style.height = '40px'; }
        else                              { img.style.width = '160px'; img.style.height = 'auto'; }
      });
      if (dzChips) dzChips.appendChild(chip);
    } else {
      if (chipsRow) chipsRow.setAttribute('hidden', '');
      if (attachBtn) attachBtn.classList.remove('has-file');
    }
  };

  // Expose so other parts of main.js can trigger re-render after messages change
  window.refreshDropzoneState = function() { window.renderAttachBar(); };

  // ── File picker (UXP storage API) ───────────────────────────────────────
  async function pickAndAttachFile() {
    try {
      var uxp = window.require && window.require('uxp');
      if (!uxp || !uxp.storage) {
        alert('UXP storage API not available');
        return;
      }
      var lfs = uxp.storage.localFileSystem;
      var formats = uxp.storage.formats;
      var file = await lfs.getFileForOpening({
        types: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
        allowMultiple: false,
      });
      if (!file) return; // user cancelled

      var buf = await file.read({ format: formats.binary });
      var size = buf.byteLength || buf.length;
      var sizeMB = size / (1024 * 1024);
      if (sizeMB > MAX_SIZE_MB) {
        alert('Image too large (' + sizeMB.toFixed(1) + 'MB). Max ' + MAX_SIZE_MB + 'MB.');
        return;
      }
      var b64 = bufToBase64(buf);
      var mediaType = inferMediaType(file.name);
      addAttachment({
        name: file.name,
        mediaType: mediaType,
        size: size,
        base64: b64,
        dataUrl: 'data:' + mediaType + ';base64,' + b64,
      });
    } catch(e) {
      console.error('[attach] file error:', e);
      alert('Failed to read file: ' + e.message);
    }
  }

  // ── Read File/Blob (from clipboard or drop) ─────────────────────────────
  function attachFromBlob(blob, fallbackName) {
    if (!blob) return;
    var sizeMB = blob.size / (1024 * 1024);
    if (sizeMB > MAX_SIZE_MB) {
      alert('Image too large (' + sizeMB.toFixed(1) + 'MB). Max ' + MAX_SIZE_MB + 'MB.');
      return;
    }
    if (SUPPORTED_TYPES.indexOf(blob.type) < 0) {
      alert('Unsupported image type: ' + blob.type);
      return;
    }
    var reader = new FileReader();
    reader.onload = function(e) {
      var dataUrl = e.target.result; // "data:image/png;base64,..."
      var commaIdx = dataUrl.indexOf(',');
      var b64 = dataUrl.slice(commaIdx + 1);
      addAttachment({
        name: blob.name || fallbackName || ('clipboard-' + Date.now() + '.png'),
        mediaType: blob.type,
        size: blob.size,
        base64: b64,
        dataUrl: dataUrl,
      });
    };
    reader.onerror = function() { alert('Failed to read image'); };
    reader.readAsDataURL(blob);
  }

  // ── Attach button → file picker ──────────────────────────────────────────
  if (attachBtn) {
    attachBtn.addEventListener('click', function() { pickAndAttachFile(); });
  }

  // ── Drag & drop on #input-area ────────────────────────────────────────────
  var dragTarget = inputArea || dropzone;
  ['dragenter', 'dragover'].forEach(function(evt) {
    dragTarget.addEventListener(evt, function(e) {
      e.preventDefault();
      e.stopPropagation();
      dragTarget.classList.add('is-drag-over');
    });
  });
  dragTarget.addEventListener('dragleave', function(e) {
    e.preventDefault();
    e.stopPropagation();
    if (dragTarget.contains(e.relatedTarget)) return;
    dragTarget.classList.remove('is-drag-over');
  });

  // Helper: try to read a file path via UXP storage API
  async function tryLoadByPath(filePath) {
    try {
      var uxp = window.require && window.require('uxp');
      if (!uxp || !uxp.storage) return false;
      var lfs = uxp.storage.localFileSystem;
      var formats = uxp.storage.formats;
      // file:// URL requires exactly three slashes for an absolute path:  file:///path
      var fileUrl = 'file://' + (filePath.startsWith('/') ? '' : '/') + filePath;
      var file = await lfs.getEntryWithUrl
        ? await lfs.getEntryWithUrl(fileUrl)
        : (lfs.getFileForPath ? await lfs.getFileForPath(filePath) : null);
      if (!file || file.isFolder) return false;
      var buf = await file.read({ format: formats.binary });
      var size = buf.byteLength || buf.length;
      var b64 = bufToBase64(buf);
      var mediaType = inferMediaType(file.name);
      addAttachment({
        name: file.name, mediaType: mediaType, size: size,
        base64: b64, dataUrl: 'data:' + mediaType + ';base64,' + b64,
      });
      return true;
    } catch(e) {
      console.warn('[drop] tryLoadByPath failed:', filePath, e.message);
      return false;
    }
  }

  // Helper: fallback — ask bridge to read the file and return base64
  async function tryLoadViaBridge(filePath) {
    try {
      var res = await fetch(BRIDGE_URL + '/api/read-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: filePath }),
      });
      if (!res.ok) return false;
      var data = await res.json();
      if (!data.base64) return false;
      var mediaType = data.mediaType || inferMediaType(filePath);
      var fileName  = filePath.split('/').pop() || 'image.png';
      addAttachment({
        name: fileName, mediaType: mediaType, size: data.size || 0,
        base64: data.base64, dataUrl: 'data:' + mediaType + ';base64,' + data.base64,
      });
      return true;
    } catch(e) {
      console.warn('[drop] tryLoadViaBridge failed:', filePath, e.message);
      return false;
    }
  }

  dragTarget.addEventListener('drop', async function(e) {
    e.preventDefault();
    e.stopPropagation();
    dragTarget.classList.remove('is-drag-over');

    var dt = e.dataTransfer;
    if (!dt) {
      console.warn('[drop] no dataTransfer');
      return;
    }

    // Diagnostic logging — helps see what UXP exposes
    var info = {
      types: dt.types ? Array.prototype.slice.call(dt.types) : [],
      filesLength: (dt.files && dt.files.length) || 0,
      itemsLength: (dt.items && dt.items.length) || 0,
    };
    console.log('[drop] dataTransfer:', JSON.stringify(info));

    var attached = 0;

    // ── Method 1: dataTransfer.files (standard HTML5) ─────────────────────
    if (dt.files && dt.files.length > 0) {
      for (var i = 0; i < dt.files.length; i++) {
        var f = dt.files[i];
        console.log('[drop] file[' + i + ']:', f.name, f.type, f.size);
        if (f.type && f.type.startsWith('image/')) { attachFromBlob(f); attached++; }
        else if (f.name && /\.(png|jpg|jpeg|webp|gif)$/i.test(f.name)) { attachFromBlob(f); attached++; }
      }
    }

    // ── Method 2: dataTransfer.items[].getAsFile() ────────────────────────
    if (attached === 0 && dt.items && dt.items.length > 0) {
      for (var k = 0; k < dt.items.length; k++) {
        var item = dt.items[k];
        console.log('[drop] item[' + k + ']:', item.kind, item.type);
        if (item.kind === 'file') {
          try {
            var blob = item.getAsFile();
            if (blob) {
              console.log('[drop]   getAsFile →', blob.name, blob.type, blob.size);
              if (blob.type.startsWith('image/') || /\.(png|jpg|jpeg|webp|gif)$/i.test(blob.name || '')) {
                attachFromBlob(blob);
                attached++;
              }
            }
          } catch(err) { console.warn('[drop]   getAsFile error:', err.message); }
        }
      }
    }

    // ── Method 3: text/uri-list or text/plain → file path via UXP storage ──
    var uriPaths = [];
    if (attached === 0) {
      var pathStr = '';
      try { pathStr = dt.getData('text/uri-list') || dt.getData('text/plain') || ''; } catch(e) {}
      console.log('[drop] text data:', pathStr.slice(0, 200));
      var paths = pathStr.split(/[\r\n]+/).map(function(s){return s.trim();}).filter(Boolean);
      for (var p = 0; p < paths.length; p++) {
        var raw = paths[p];
        // Strip the file:// prefix to get an absolute POSIX path for UXP
        var pth = raw.replace(/^file:\/\//, '');
        if (/\.(png|jpg|jpeg|webp|gif)$/i.test(pth)) {
          uriPaths.push(pth);
          var ok = await tryLoadByPath(pth);
          if (ok) attached++;
        }
      }
    }

    // ── Method 4: bridge fallback — bridge reads the file server-side ───────
    if (attached === 0 && uriPaths.length > 0) {
      console.log('[drop] UXP storage failed, trying bridge fallback…');
      for (var bp = 0; bp < uriPaths.length; bp++) {
        var bok = await tryLoadViaBridge(uriPaths[bp]);
        if (bok) attached++;
      }
    }

    if (attached === 0) {
      console.warn('[drop] no images attached — UXP may not support Finder drag-drop and bridge fallback failed.');
      dragTarget.classList.add('drop-failed');
      setTimeout(function() { dragTarget.classList.remove('drop-failed'); }, 600);
    } else {
      console.log('[drop] attached', attached, 'image(s)');
    }
  });

  // ── Clipboard paste (works inside textarea OR dropzone) ─────────────────
  function handlePaste(e) {
    if (!e.clipboardData || !e.clipboardData.items) return;
    var items = e.clipboardData.items;
    var attached = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault();
        var blob = items[i].getAsFile();
        attachFromBlob(blob, 'pasted-' + Date.now() + '.png');
        attached++;
      }
    }
  }
  msgInput.addEventListener('paste', handlePaste);
  // Also listen on the whole input area so paste works anywhere in that zone
  if (inputArea) inputArea.addEventListener('paste', handlePaste);

  // Init
  window.renderAttachBar();
})();

// ═══════════════════════════════════════════════════════════════════════════
// TAB SWITCHING
// ═══════════════════════════════════════════════════════════════════════════
document.querySelectorAll('.tab-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.toggle('active', b === btn); });
    document.querySelectorAll('.tab-panel').forEach(function(p) {
      p.classList.toggle('active', p.id === 'tab-' + tab);
    });
    closeSettingsPanel();
    // Resize VoiceGen textareas when tab becomes visible
    if (tab === 'voicegen') {
      var _vgScript = document.getElementById('vgScript');
      var _vgSfx    = document.getElementById('vgSfxText');
      var _vgMusic  = document.getElementById('vgMusicPrompt');
      if (_vgScript) vgAutoResize(_vgScript);
      if (_vgSfx)    vgAutoResize(_vgSfx);
      if (_vgMusic)  vgAutoResize(_vgMusic);
    }
    // Close voice dropdown (panel is portaled to body, close directly)
    var _vdp = document.getElementById('vgVoiceDropPanel');
    if (_vdp) _vdp.style.display = 'none';
    var _vdt = document.getElementById('vgVoiceDropTrigger');
    if (_vdt) _vdt.classList.remove('is-open');
  });
});

// ── SAC: Project bin traversal (premierepro UXP API) ──────────────────────
// The modern API uses the cast() pattern (like ClipProjectItem.cast above):
//   project.getRootItem()        → root FolderItem
//   ppro.FolderItem.cast(item)   → FolderItem or null (null = not a folder)
//   folderItem.getItems()        → child ProjectItem[]
//   item.name / item.getName()   → display name

async function sacGetItemName(item) {
  if (!item) return '';
  try { if (item.name) return String(item.name); } catch(e) {}
  if (typeof item.getName === 'function') {
    try { var n = item.getName(); if (n && typeof n.then === 'function') n = await n; if (n) return String(n); } catch(e) {}
  }
  return '';
}

// Return child items of a folder, or [] if it's not a folder (clip/sequence).
async function sacGetFolderChildren(item) {
  if (!item) return [];
  var folder = item;
  // Cast to FolderItem; null means this item has no children to traverse.
  try {
    if (ppro && ppro.FolderItem && typeof ppro.FolderItem.cast === 'function') {
      var f = ppro.FolderItem.cast(item);
      if (!f) return [];
      folder = f;
    }
  } catch(e) { return []; }
  try {
    if (typeof folder.getItems === 'function') {
      var items = folder.getItems();
      if (items && typeof items.then === 'function') items = await items;
      return collectionToArray(items);
    }
  } catch(e) { console.warn('[SAC] getItems err:', e.message); }
  return [];
}

// Walk the whole project tree (BFS) and return [{name, item, parent}, ...].
// `parent` is the immediate folder's name ('' for top-level items) — needed to
// match cutsheet entries like "Senyue 70" = folder "Senyue" + clip "70".
async function sacCollectBinItems(rootItem) {
  var out = [];
  var queue = [{ item: rootItem, name: '' }]; // root parent is '' (no prefix)
  var guard = 0;
  while (queue.length && guard < 10000) {
    guard++;
    var node = queue.shift();
    var children = await sacGetFolderChildren(node.item);
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      var name  = await sacGetItemName(child);
      out.push({ name: name, item: child, parent: node.name });
      queue.push({ item: child, name: name }); // [] for clips → no infinite loop
    }
  }
  return out;
}

// Normalize: lowercase, collapse all whitespace runs to a single space, trim.
// Collapsing whitespace matters — bin names may have double spaces / NBSP.
function sacNorm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Match a target name against collected items.
// Two passes: (1) exact (ext-tolerant), (2) prefix at a word boundary so a
// cutsheet name "Sandy 100" matches a bin clip "Sandy 100 S3A4232.MP4".
function sacMatchBinItem(items, targetName) {
  var t    = sacNorm(targetName);
  var tNoX = t.replace(/\.[^.]+$/, '');

  // Pass 1: exact match (with or without file extension)
  for (var i = 0; i < items.length; i++) {
    var cn    = sacNorm(items[i].name);
    var cnNoX = cn.replace(/\.[^.]+$/, '');
    if (cn === t || cnNoX === t || cn === tNoX || cnNoX === tNoX) return items[i].item;
  }
  // Pass 2: bin name starts with the target followed by a boundary char
  for (var k = 0; k < items.length; k++) {
    var name = sacNorm(items[k].name);
    if (tNoX && name.indexOf(tNoX) === 0) {
      var next = name.charAt(tNoX.length);
      if (next === '' || /[\s._\-]/.test(next)) return items[k].item;
    }
  }
  // Pass 3: folder + clip. Cutsheet "Senyue 62" → a clip named "62" inside a
  // folder whose name *contains* "Senyue" (e.g. "Studio Senyue/62.MOV").
  // Try every split: leading tokens = folder hint, trailing tokens = clip name.
  var toks = t.split(' ').filter(Boolean);
  if (toks.length >= 2) {
    for (var s = 1; s < toks.length; s++) {
      var folderPart = toks.slice(0, s).join(' ');
      var clipPart   = toks.slice(s).join(' ');
      if (folderPart.length < 2) continue;
      for (var m = 0; m < items.length; m++) {
        if (!items[m].parent) continue;
        var nameNoX = sacNorm(items[m].name).replace(/\.[^.]+$/, '');
        var par     = sacNorm(items[m].parent);
        // clip name: exact, OR ends with " <token>", OR starts with "<token> " / "<token>("
        var clipOk = (nameNoX === clipPart) ||
                     (nameNoX.length > clipPart.length &&
                       nameNoX.slice(-(clipPart.length + 1)) === (' ' + clipPart)) ||
                     (nameNoX.length > clipPart.length &&
                       nameNoX.indexOf(clipPart) === 0 &&
                       /[\s._\-\(]/.test(nameNoX.charAt(clipPart.length)));
        var folderOk = par.indexOf(folderPart) !== -1;
        if (clipOk && folderOk) return items[m].item;
      }
    }
  }
  return null;
}

// Count how many DISTINCT bin items a plain source name (no folder prefix)
// matches via Pass 1 + Pass 2 only. Used to detect ambiguous names.
function sacCountBinMatches(items, targetName) {
  var t    = sacNorm(targetName);
  var tNoX = t.replace(/\.[^.]+$/, '');
  return items.filter(function(b) {
    var cn   = sacNorm(b.name);
    var cnNoX = cn.replace(/\.[^.]+$/, '');
    if (cn === t || cnNoX === t || cn === tNoX || cnNoX === tNoX) return true;
    if (tNoX && cn.indexOf(tNoX) === 0) {
      var next = cn.charAt(tNoX.length);
      if (next === '' || /[\s._\-]/.test(next)) return true;
    }
    return false;
  }).length;
}

// ═══════════════════════════════════════════════════════════════════════════
// SUPER AUTO CUT MODULE — Phase 1: Spreadsheet UI + Block Parsing
// ═══════════════════════════════════════════════════════════════════════════
(function() {
  'use strict';
  var $ = function(id) { return document.getElementById(id); };

  var rowSeq = 0;
  var parsedBlocks = [];
  var sacSourceMap = {}; // name → ProjectItem|null, populated by sacValidateSources
  var sacBinItems  = []; // full flat list from last bin scan (persisted for hint UI)
  var sacVoicePath = null; // native path of the chosen/generated voice file (Phase 4)

  var sacValidatePassed = false;
  var sacVoiceReady     = false;
  var sacNoVoiceMode    = false; // set by "Without voice" button

  // Show the cut panel (hides voice panel), update label
  function sacShowCutPanel() {
    $('sacVoicePanel').style.display = 'none';
    var lbl = $('sacCutLabel');
    if (lbl) {
      if (sacNoVoiceMode) {
        lbl.textContent = '✂ Without voice';
      } else {
        var info = $('sacVoiceInfo');
        lbl.textContent = info ? info.textContent : '✅ Voice ready';
      }
    }
    $('sacCutPanel').style.display = 'flex';
  }

  function sacHideCutPanel() {
    $('sacCutPanel').style.display = 'none';
    $('sacNewSeqForm').style.display = 'none';
    $('sacVoicePanel').style.display = 'flex';
  }

  function sacUpdateRunVisibility() {
    if (sacValidatePassed && (sacVoiceReady || sacNoVoiceMode)) {
      sacShowCutPanel();
    } else {
      sacHideCutPanel();
    }
  }

  // ── Method switching ────────────────────────────────────────────────────
  document.querySelectorAll('.sac-methodBtn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.sac-methodBtn').forEach(function(b) {
        b.classList.remove('is-active');
      });
      btn.classList.add('is-active');
      var method = btn.dataset.method;
      $('sacPanelManual').style.display     = (method === 'manual')     ? 'flex' : 'none';
      $('sacPanelScreenshot').style.display = (method === 'screenshot') ? 'flex' : 'none';
    });
  });

  // ── TSV parser — handles quoted cells with embedded newlines ────────────
  // Google Sheets wraps cells containing \n or \t in double-quotes.
  // Standard: tab = col sep, \n = row sep, "" inside quotes = literal "
  function parseTSV(text) {
    var rows = [], row = [], cell = '', inQ = false, i = 0, ch, nx;
    while (i < text.length) {
      ch = text[i]; nx = text[i + 1];
      if (inQ) {
        if (ch === '"' && nx === '"') { cell += '"'; i += 2; }       // escaped quote
        else if (ch === '"')          { inQ = false; i++; }          // end quote
        else                          { cell += ch; i++; }
      } else {
        if      (ch === '"')                      { inQ = true; i++; }
        else if (ch === '\t')                     { row.push(cell); cell = ''; i++; }
        else if (ch === '\n' || ch === '\r') {
          row.push(cell); cell = '';
          if (row.some(function(c) { return c !== ''; })) rows.push(row);
          row = [];
          if (ch === '\r' && nx === '\n') i++;    // CRLF
          i++;
        } else { cell += ch; i++; }
      }
    }
    // flush last cell/row
    row.push(cell);
    if (row.some(function(c) { return c !== ''; })) rows.push(row);
    return rows;
  }

  // ── Expand multi-line / multi-value cells into separate rows ─────────────
  // Handles three cases:
  //   A) text cell has \n  → split text into rows (first keeps time+src)
  //   B) time cell has \n  → split time values into rows (first keeps text+src)
  //   C) time cell has space-separated timestamps like "0:04 0:07 0:13"
  var TS_RE = /^\d+:\d+(?:-\d+:\d+)?$/; // e.g. "0:04" or "0:01-0:08"
  function splitTimes(t) {
    if (!t) return [t];
    if (t.indexOf('\n') !== -1) return t.split('\n').map(function(s){ return s.trim(); }).filter(Boolean);
    var parts = t.trim().split(/\s+/);
    if (parts.length > 1 && parts.every(function(p){ return TS_RE.test(p); })) return parts;
    return [t];
  }
  function expandRows(rows) {
    var out = [];
    var i = 0;
    while (i < rows.length) {
      var cols = rows[i];
      var text = cols[0] || '', time = cols[1] || '', src = cols[2] || '';

      // A: multi-line text cell
      // Zip with subsequent rows that have EMPTY text — lets Google Sheets layout like:
      //   Row 1: "Line A\nLine B" | 0:04-0:05 | ClipX       ← multiline text cell
      //   Row 2: ""               | 0:35-0:37 | ClipY       ← empty text, carries data for Line B
      // → expand to: ["Line A"|0:04-0:05|ClipX], ["Line B"|0:35-0:37|ClipY]
      if (text.indexOf('\n') !== -1) {
        var lines = text.split('\n').filter(function(l) { return l.trim(); });
        var extra = 0; // number of subsequent rows consumed
        lines.forEach(function(line, li) {
          var t = time, s = src;
          if (li > 0) {
            var nextIdx = i + li;
            if (nextIdx < rows.length && !((rows[nextIdx][0] || '').trim())) {
              // Next row has empty text → zip it with this line
              t = rows[nextIdx][1] || '';
              s = rows[nextIdx][2] || '';
              extra = li; // track how many extra rows we'll skip
            } else {
              t = ''; s = ''; // no matching row → empty time/src
            }
          }
          out.push([line.trim(), t, s]);
        });
        i += extra + 1;
        continue;
      }

      // B+C: multi-value time cell
      var times = splitTimes(time);
      if (times.length > 1) {
        var srcLines = src.indexOf('\n') !== -1
          ? src.split('\n').map(function(s){ return s.trim(); }).filter(Boolean)
          : [src];
        var zipSrc = srcLines.length === times.length;
        times.forEach(function(t, ti) {
          out.push([ ti === 0 ? text : '', t, zipSrc ? srcLines[ti] : src ]);
        });
        i++;
        continue;
      }

      out.push(cols);
      i++;
    }
    return out;
  }

  // ── Row factory ─────────────────────────────────────────────────────────
  function makeInput(placeholder) {
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'sac-input';
    inp.placeholder = placeholder;
    inp.addEventListener('focus', function() {
      if (window.claimKeyboard) window.claimKeyboard();
    });
    inp.addEventListener('blur', function() {
      if (window.releaseKeyboard) window.releaseKeyboard();
    });
    // Multi-row paste from Google Sheets / Excel
    inp.addEventListener('paste', function(e) {
      var text = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!text || text.indexOf('\n') === -1) return; // single cell → normal paste
      e.preventDefault();
      var rows = expandRows(parseTSV(text));
      if (rows.length === 0) return;
      $('sacBody').innerHTML = '';
      rowSeq = 0;
      rows.forEach(function(cols) {
        createRow(
          cols[0] ? cols[0].trim() : '',
          cols[1] ? cols[1].trim() : '',
          cols[2] ? cols[2].trim() : ''
        );
      });
    });
    return inp;
  }

  function makeCell(colClass) {
    var cell = document.createElement('div');
    cell.className = 'sac-cell ' + colClass;
    return cell;
  }

  // afterRow: if provided, insert new row after that element; else append
  function createRow(text, time, src, afterRow) {
    var id = ++rowSeq;
    var row = document.createElement('div');
    row.className = 'sac-row';
    row.dataset.rowId = String(id);

    var inpText = makeInput('Script text...');
    var inpTime = makeInput('0:00-0:10');
    var inpSrc  = makeInput('Source name');
    if (text) inpText.value = text;
    if (time) inpTime.value = time;
    if (src)  inpSrc.value  = src;

    var delBtn = document.createElement('button');
    delBtn.className = 'sac-rowBtn sac-delBtn';
    delBtn.title = 'Xoá dòng này';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', function() { row.remove(); });

    var insBtn = document.createElement('button');
    insBtn.className = 'sac-rowBtn sac-insBtn';
    insBtn.title = 'Thêm dòng bên dưới';
    insBtn.textContent = '+';
    insBtn.addEventListener('click', function() { createRow('', '', '', row); });

    // Reset validate gate whenever source is edited (hint added or name changed)
    inpSrc.addEventListener('input', function() {
      if (sacValidatePassed) { sacValidatePassed = false; sacUpdateRunVisibility(); }
    });

    // Folder hint button — suggests parent folders from the last bin scan
    var hintBtn = document.createElement('button');
    hintBtn.className = 'sac-rowBtn sac-hintBtn';
    hintBtn.title = 'Thêm folder hint';
    hintBtn.textContent = '📁';
    hintBtn.addEventListener('click', function() { sacShowFolderHints(inpSrc.value.trim(), inpSrc); });

    var cText = makeCell('sac-col-text'); cText.appendChild(inpText);
    var cTime = makeCell('sac-col-time'); cTime.appendChild(inpTime);
    var cSrc  = makeCell('sac-col-src');  cSrc.appendChild(inpSrc); cSrc.appendChild(hintBtn);
    var cAct  = makeCell('sac-col-act');
    cAct.appendChild(insBtn);
    cAct.appendChild(delBtn);

    row.appendChild(cText);
    row.appendChild(cTime);
    row.appendChild(cSrc);
    row.appendChild(cAct);

    var body = $('sacBody');
    if (afterRow && afterRow.nextSibling) {
      body.insertBefore(row, afterRow.nextSibling);
    } else {
      body.appendChild(row);
    }
    return row;
  }

  // ── Block parsing ───────────────────────────────────────────────────────
  // Rule:
  //   • Both text + source non-empty → NEW block
  //   • Only text non-empty          → add text to current block
  //   • Only source non-empty        → add source to current block
  //   • Both empty                   → skip
  function parseBlocks() {
    var rows = Array.from($('sacBody').querySelectorAll('.sac-row'));
    var data = rows.map(function(row) {
      var inputs = row.querySelectorAll('.sac-input');
      return {
        text: inputs[0] ? inputs[0].value.trim() : '',
        time: inputs[1] ? inputs[1].value.trim() : '',
        src:  inputs[2] ? inputs[2].value.trim() : '',
      };
    });

    var blocks  = [];
    var current = null;

    data.forEach(function(r) {
      var hasText = r.text !== '';
      var hasSrc  = r.src  !== '';
      if (!hasText && !hasSrc) return; // skip blank rows

      if (hasText && hasSrc) {
        // Both → start new block
        current = { texts: [r.text], sources: [{ name: r.src, time: r.time }] };
        blocks.push(current);
      } else if (hasText) {
        // Text only → add to current block
        if (!current) { current = { texts: [], sources: [] }; blocks.push(current); }
        current.texts.push(r.text);
      } else {
        // Source only → add to current block
        if (!current) { current = { texts: [], sources: [] }; blocks.push(current); }
        current.sources.push({ name: r.src, time: r.time });
      }
    });

    return blocks;
  }

  // ── Block preview ───────────────────────────────────────────────────────
  var BLOCK_COLORS = ['#a855f7','#f59e0b','#10b981','#3b82f6','#ef4444','#ec4899'];
  var BLOCK_BG     = ['rgba(168,85,247,0.12)','rgba(245,158,11,0.1)','rgba(16,185,129,0.1)',
                      'rgba(59,130,246,0.1)','rgba(239,68,68,0.1)','rgba(236,72,153,0.1)'];

  function renderBlocks(blocks) {
    var list = $('sacBlockList');
    list.innerHTML = '';
    $('sacBlockCount').textContent = blocks.length + ' block' + (blocks.length !== 1 ? 's' : '');

    blocks.forEach(function(block, i) {
      var color = BLOCK_COLORS[i % BLOCK_COLORS.length];
      var bg    = BLOCK_BG[i % BLOCK_BG.length];

      var card = document.createElement('div');
      card.className = 'sac-blockCard';

      // Header (click to collapse/expand)
      var header = document.createElement('div');
      header.className = 'sac-blockCardHeader';
      header.style.color = color;
      header.style.background = bg;

      var chevron = document.createElement('span');
      chevron.className = 'sac-blockChevron';
      chevron.textContent = '▾';
      header.appendChild(chevron);

      var label = document.createElement('span');
      label.textContent = 'Block ' + (i + 1)
        + '  ·  ' + block.texts.length + ' text'
        + (block.texts.length !== 1 ? 's' : '')
        + '  ·  ' + block.sources.length + ' source'
        + (block.sources.length !== 1 ? 's' : '');
      header.appendChild(label);

      // Voice duration badge — filled in by sacAlignVoice() after alignment
      var voiceBadge = document.createElement('span');
      voiceBadge.className = 'sac-blockVoiceBadge';
      voiceBadge.dataset.blockIdx = String(i);
      header.appendChild(voiceBadge);

      card.appendChild(header);

      // Body
      var body = document.createElement('div');
      body.className = 'sac-blockCardBody';

      header.addEventListener('click', function() {
        var collapsed = body.style.display === 'none';
        body.style.display = collapsed ? '' : 'none';
        chevron.textContent = collapsed ? '▾' : '▸';
      });

      block.texts.forEach(function(t) {
        var el = document.createElement('div');
        el.className = 'sac-blockText';
        el.textContent = '💬 ' + t;
        body.appendChild(el);
      });

      if (block.texts.length > 0 && block.sources.length > 0) {
        var div = document.createElement('div');
        div.className = 'sac-blockDivider';
        body.appendChild(div);
      }

      block.sources.forEach(function(s, si) {
        var el = document.createElement('div');
        el.className = 'sac-blockSrc';
        el.dataset.srcName  = s.name; // for async status update
        el.dataset.blockIdx = String(i);
        el.dataset.srcIdx   = String(si);
        var nameSpan = document.createElement('span');
        nameSpan.className = 'sac-srcName';
        nameSpan.textContent = '🎬 ' + s.name;
        el.appendChild(nameSpan);
        if (s.time) {
          var badge = document.createElement('span');
          badge.className = 'sac-blockTimeBadge';
          badge.textContent = s.time;
          el.appendChild(badge);
        }
        var statusSpan = document.createElement('span');
        statusSpan.className = 'sac-srcStatus';
        statusSpan.textContent = '⌛';
        el.appendChild(statusSpan);
        body.appendChild(el);
      });

      card.appendChild(body);
      list.appendChild(card);
    });

    parsedBlocks = blocks;
    $('sacBlockSection').style.display = 'flex';
    // Re-rendering invalidates both gates — must re-validate + re-align.
    sacValidatePassed = false;
    sacVoiceReady = false;
    sacHideCutPanel();
  }

  // ── Source validation (Phase 3) ─────────────────────────────────────────
  // Updates the ✓/✗ icons on each source row. Returns a promise resolving to
  // { missing: [names], premiereAvailable: bool }.
  async function sacValidateSources(blocks) {
    var names = [];
    blocks.forEach(function(b) {
      b.sources.forEach(function(s) {
        if (s.name && names.indexOf(s.name) === -1) names.push(s.name);
      });
    });
    if (names.length === 0) return { missing: [], premiereAvailable: true };

    sacSourceMap = {};

    var rootItem = null;
    try {
      var proj = await getActiveProject();
      if (typeof proj.getRootItem === 'function') {
        rootItem = proj.getRootItem();
        if (rootItem && typeof rootItem.then === 'function') rootItem = await rootItem;
      }
      if (!rootItem) rootItem = proj.rootItem || null; // legacy fallback
    } catch(e) {
      // Not running inside Premiere — clear spinners (dev mode, can't verify bin)
      document.querySelectorAll('.sac-srcStatus').forEach(function(el) { el.textContent = ''; });
      return { missing: [], premiereAvailable: false };
    }

    // One full traversal; persist for hint UI; log for debugging.
    var binItems = rootItem ? (await sacCollectBinItems(rootItem)) : [];
    sacBinItems = binItems; // persist so 📁 button can suggest folders later
    console.log('[SAC] Bin items found (' + binItems.length + '):',
      binItems.map(function(b) { return b.name; }));

    // Detect ambiguous names: same plain name matches 2+ distinct bin clips.
    // NOTE: only warns for names without a folder hint already (no spaces / single token).
    var ambiguousNames = {};
    names.forEach(function(name) {
      var count = sacCountBinMatches(binItems, name);
      if (count > 1) ambiguousNames[name] = count;
    });

    var allRows = document.querySelectorAll('.sac-blockSrc');
    console.log('[SAC validate] names:', names, '| DOM rows found:', allRows.length);
    allRows.forEach(function(el) {
      console.log('[SAC validate] row srcName="' + el.dataset.srcName + '" blockIdx=' + el.dataset.blockIdx);
    });

    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var item = sacMatchBinItem(binItems, name);
      sacSourceMap[name] = item || null;
      var isAmbiguous = !!ambiguousNames[name];
      console.log('[SAC validate] "' + name + '" →', item ? '✓ found' : '✗ missing', '| ambiguous:', isAmbiguous);

      // Update every source row with this name (may appear in multiple blocks)
      document.querySelectorAll('.sac-blockSrc').forEach(function(el) {
        if (el.dataset.srcName !== name) return;
        var statusEl = el.querySelector('.sac-srcStatus');
        console.log('[SAC validate] updating row "' + name + '" → statusEl:', statusEl ? 'found' : 'NULL');
        if (!statusEl) return;
        if (isAmbiguous) {
          statusEl.className = 'sac-srcStatus sac-srcAmbiguous';
          statusEl.textContent = '⚠';
          statusEl.title = ambiguousNames[name] + ' clips trùng tên — thêm folder hint (📁)';
        } else if (item) {
          statusEl.className = 'sac-srcStatus sac-srcOk';
          statusEl.textContent = '✓';
        } else {
          statusEl.className = 'sac-srcStatus sac-srcMissing';
          statusEl.textContent = '✗';
          // Add Skip button for missing sources
          sacAddSkipButton(el);
        }
      });
    }

    var missingNames = names.filter(function(n) { return !sacSourceMap[n]; });
    // Log candidates matching ANY token (incl. folder name), showing
    // "<folder>/<clip>" so name/structure mismatches are obvious.
    missingNames.forEach(function(mn) {
      var toks = sacNorm(mn).split(' ').filter(Boolean);
      var cands = binItems.filter(function(b) {
        var hay = sacNorm((b.parent || '') + ' ' + b.name);
        return toks.some(function(tk) { return hay.indexOf(tk) !== -1; });
      }).map(function(b) { return (b.parent ? b.parent + '/' : '') + b.name; });
      console.log('[SAC] "' + mn + '" không khớp. Gần đúng:', cands);
    });

    var ambiguousNames = names.filter(function(n) {
      return sacCountBinMatches(binItems, n) > 1;
    });

    window.sacSourceMap = sacSourceMap; // expose for Phase 5 assembly
    return { missing: missingNames, ambiguous: ambiguousNames, premiereAvailable: true };
  }

  // ── Skip source button ──────────────────────────────────────────────────────
  // Appears on source rows with ✗ validation. Marks the source as skipped so
  // assembly replaces it with a 1s gap instead of a real clip.
  function sacAddSkipButton(srcEl) {
    if (srcEl.querySelector('.sac-skipBtn')) return; // already added
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sac-skipBtn';
    btn.textContent = 'Skip';
    btn.addEventListener('click', function() {
      var bIdx = parseInt(srcEl.dataset.blockIdx, 10);
      var sIdx = parseInt(srcEl.dataset.srcIdx,   10);
      var src  = parsedBlocks[bIdx] && parsedBlocks[bIdx].sources[sIdx];
      if (!src) return;

      src.skipped = !src.skipped;

      var statusEl = srcEl.querySelector('.sac-srcStatus');
      var nameSpan = srcEl.querySelector('.sac-srcName');
      if (src.skipped) {
        btn.textContent = 'Undo';
        btn.classList.add('is-active');
        if (statusEl) { statusEl.textContent = '⏭'; statusEl.className = 'sac-srcStatus sac-srcSkipped'; }
        if (nameSpan)  { nameSpan.style.opacity = '0.4'; nameSpan.style.textDecoration = 'line-through'; }
      } else {
        btn.textContent = 'Skip';
        btn.classList.remove('is-active');
        if (statusEl) { statusEl.textContent = '✗'; statusEl.className = 'sac-srcStatus sac-srcMissing'; }
        if (nameSpan)  { nameSpan.style.opacity = ''; nameSpan.style.textDecoration = ''; }
      }

      // Re-check if all missing sources are now skipped → open Run gate
      sacCheckSkipGate();
    });
    srcEl.appendChild(btn);
  }

  // After each skip toggle: if every missing source is now skipped, pass the
  // validate gate so the Run button appears (skipped sources → 1s gap in assembly).
  function sacCheckSkipGate() {
    if (!parsedBlocks.length) return;
    var allResolved = parsedBlocks.every(function(block) {
      return (block.sources || []).every(function(src) {
        return !!(sacSourceMap[src.name]) || !!src.skipped;
      });
    });
    if (allResolved) {
      sacValidatePassed = true;
      var st = $('sacStatus');
      if (st) {
        st.textContent = '✅ Tất cả sources đã resolved (validate ✓ hoặc skip ⏭).';
        st.style.display = 'block';
      }
    } else {
      sacValidatePassed = false;
    }
    sacUpdateRunVisibility();
  }

  // ── Folder hint UI ─────────────────────────────────────────────────────────
  // Shows folder options (from last bin scan) in the status area so user can
  // prepend the right folder to disambiguate a source name.
  function sacShowFolderHints(srcName, inputEl) {
    var statusEl = $('sacStatus');
    if (!srcName) {
      statusEl.textContent = '⚠ Nhập tên source trước khi chọn folder hint.';
      statusEl.style.display = 'block'; return;
    }
    if (!sacBinItems.length) {
      statusEl.textContent = '⚠ Bấm Validate trước để load danh sách bin — sau đó bấm 📁 lại.';
      statusEl.style.display = 'block'; return;
    }

    // Collect all bin items that match this source name (Pass 1+2 only)
    var t = sacNorm(srcName), tNoX = t.replace(/\.[^.]+$/, '');
    var matches = sacBinItems.filter(function(b) {
      var cn = sacNorm(b.name), cnNoX = cn.replace(/\.[^.]+$/, '');
      if (cn === t || cnNoX === t || cn === tNoX || cnNoX === tNoX) return true;
      if (tNoX && cn.indexOf(tNoX) === 0) {
        var nx = cn.charAt(tNoX.length);
        if (nx === '' || /[\s._\-]/.test(nx)) return true;
      }
      return false;
    });

    if (!matches.length) {
      statusEl.textContent = '⚠ "' + srcName + '" không tìm thấy trong bin. Kiểm tra lại tên.';
      statusEl.style.display = 'block'; return;
    }

    // Unique parent folders
    var folders = [];
    matches.forEach(function(b) {
      if (b.parent && folders.indexOf(b.parent) === -1) folders.push(b.parent);
    });

    if (folders.length === 1) {
      // Only one folder → apply directly, no need to ask
      inputEl.value = folders[0] + ' ' + srcName;
      statusEl.textContent = '✓ Đã thêm hint "' + folders[0] + '". Validate lại để xác nhận.';
      statusEl.style.display = 'block';
      sacValidatePassed = false; sacUpdateRunVisibility();
      return;
    }

    // Multiple folders → show choice panel
    statusEl.innerHTML = '';
    statusEl.style.display = 'block';
    var msg = document.createElement('div');
    msg.textContent = '"' + srcName + '" có trong ' + folders.length + ' folder — chọn đúng:';
    msg.style.cssText = 'font-size:10px;margin-bottom:6px;color:rgba(255,255,255,0.6);';
    statusEl.appendChild(msg);

    var btnWrap = document.createElement('div');
    btnWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;';
    folders.forEach(function(folder) {
      var btn = document.createElement('button');
      btn.className = 'sac-folderHintBtn';
      btn.textContent = folder;
      btn.addEventListener('click', function() {
        inputEl.value = folder + ' ' + srcName;
        statusEl.innerHTML = '';
        statusEl.textContent = '✓ Đã thêm hint "' + folder + '". Validate lại để xác nhận.';
        sacValidatePassed = false; sacUpdateRunVisibility();
      });
      btnWrap.appendChild(btn);
    });
    statusEl.appendChild(btnWrap);
  }

  // ── Populate from AI-parsed data (used by Phase 2 screenshot parser) ────
  window.sacLoadBlocks = function(blocks) {
    renderBlocks(blocks);
  };

  window.sacLoadRows = function(rows) {
    $('sacBody').innerHTML = '';
    rowSeq = 0;
    rows.forEach(function(r) { createRow(r.text, r.time, r.src); });
  };

  // ── Cross-tab entry point: Claude Chat → Autocut ─────────────────────────
  // Called from ppExecuteAction (action: 'autocut_load'). Switches to the
  // Autocut tab + Manual panel, then fills the spreadsheet with {text,time,src}
  // rows (passed through expandRows so multi-line / multi-timestamp cells split
  // the same way pasting or the screenshot parser does).
  window.AutocutPushRows = function(rows) {
    // 1. Switch to the Autocut tab
    var tabBtn = document.querySelector('.tab-btn[data-tab="autocut"]');
    if (tabBtn) tabBtn.click();
    // 2. Force the Manual panel active
    document.querySelectorAll('.sac-methodBtn').forEach(function(b) {
      b.classList.toggle('is-active', b.dataset.method === 'manual');
    });
    $('sacPanelManual').style.display = 'flex';
    $('sacPanelScreenshot').style.display = 'none';
    // 3. Reset block preview/status from any previous run
    $('sacBlockSection').style.display = 'none';
    $('sacStatus').style.display = 'none';
    parsedBlocks = [];
    // 4. Fill the spreadsheet
    $('sacBody').innerHTML = ''; rowSeq = 0;
    var expanded = expandRows((rows || []).map(function(r) {
      return [ r.text || '', r.time || '', r.src || '' ];
    }));
    if (expanded.length === 0) { createRow(); createRow(); createRow(); return; }
    expanded.forEach(function(cols) { createRow(cols[0], cols[1], cols[2]); });
  };

  // ── Voice pipeline (Phase 4a) ────────────────────────────────────────────
  // Pick a single voice file covering the whole cutsheet, transcribe + align it
  // per block, and attach voiceStart/voiceEnd/voiceDuration to each block.
  function sacPickVoiceFile() {
    try {
      var uxp = require('uxp');
      uxp.storage.localFileSystem.getFileForOpening({
        types: ['mp3','wav','m4a','aac','ogg','flac'],
      }).then(function(file) {
        if (!file) return;
        var fp = file.nativePath || file.path || '';
        if (!fp) { sacSetVoiceInfo('❌ Không lấy được đường dẫn file'); return; }
        sacAlignVoice(fp);
      }).catch(function(e) { console.error('[SAC] voice picker:', e); });
    } catch(e) {
      sacSetVoiceInfo('❌ File picker không khả dụng: ' + e.message);
    }
  }

  function sacSetVoiceInfo(msg) {
    var el = $('sacVoiceInfo');
    if (el) el.textContent = msg;
  }

  // ── Mini audio player (Approach B) ────────────────────────────────────────
  // UXP can't play audio inline → playback goes through the bridge (/tts/play
  // = afplay) just like the Voice Gen tab. We only drive the DOM + a timer.
  var sacVP = { path: null, playing: false, dur: 0, startedAt: 0, ticker: null };
  function sacVPFmt(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }
  function sacVPTick() {
    var el = (Date.now() - sacVP.startedAt) / 1000;
    if (sacVP.dur > 0 && el > sacVP.dur) el = sacVP.dur;
    $('sacVoiceTime').textContent = sacVPFmt(el) + ' / ' + sacVPFmt(sacVP.dur);
    $('sacVoiceFill').style.width = sacVP.dur > 0 ? (el / sacVP.dur * 100).toFixed(1) + '%' : '0%';
  }
  function sacVPStop() {
    if (sacVP.ticker) { clearInterval(sacVP.ticker); sacVP.ticker = null; }
    sacVP.playing = false;
    var btn = $('sacVoicePlay'); if (btn) btn.textContent = '▶';
    fetch(BRIDGE_URL + '/tts/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(function(){});
  }
  function sacVPPlay() {
    if (!sacVP.path) return;
    sacVP.playing = true; sacVP.startedAt = Date.now();
    var btn = $('sacVoicePlay'); if (btn) btn.textContent = '⏸';
    sacVP.ticker = setInterval(sacVPTick, 200);
    fetch(BRIDGE_URL + '/tts/play', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: sacVP.path }),
    }).then(function(r) { return r.json(); }).then(function() {
      if (sacVP.ticker) { clearInterval(sacVP.ticker); sacVP.ticker = null; }
      sacVP.playing = false;
      var b = $('sacVoicePlay'); if (b) b.textContent = '▶';
      $('sacVoiceFill').style.width = sacVP.dur > 0 ? '100%' : '0%';
    }).catch(function() {
      sacVP.playing = false; var b = $('sacVoicePlay'); if (b) b.textContent = '▶';
    });
  }
  function sacVoicePlayerSetSrc(path) {
    if (sacVP.playing) sacVPStop();
    sacVP.path = path; sacVP.dur = 0;
    $('sacVoicePlayer').style.display = 'flex';
    $('sacVoiceFill').style.width = '0%';
    $('sacVoiceTime').textContent = '0:00 / ?';
    fetch(BRIDGE_URL + '/tts/duration', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioPath: path }),
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d && d.ok && d.duration > 0) {
        sacVP.dur = d.duration;
        $('sacVoiceTime').textContent = '0:00 / ' + sacVPFmt(d.duration);
      }
    }).catch(function(){});
  }

  // ── Gen voice = jump to Voice Gen tab with the script pre-filled ──────────
  // Reuses the Voice Gen tab fully (its own searchable dropdown + generate).
  // After generating there, the user clicks "→ Autocut" to push the audio back.
  function sacGenVoice() {
    var blocks = parseBlocks();
    if (blocks.length === 0) { sacSetVoiceInfo('⚠ Chưa có script để gen.'); return; }
    // Join all block texts in cutsheet order — one block per line.
    var text = blocks.map(function(b) { return b.texts.join(' '); }).join('\n');
    if (typeof window.VoiceGenPushScript === 'function') {
      window.VoiceGenPushScript(text, null, false); // switch tab + fill script, no auto-gen
      sacSetVoiceInfo('→ Đã đẩy script sang Voice Gen. Chọn giọng + Generate, rồi bấm "→ Autocut".');
    } else {
      sacSetVoiceInfo('❌ Voice Gen chưa sẵn sàng.');
    }
  }

  // Transcribe + align the voice file against the current blocks, then update
  // each block's voice badge and store timing on parsedBlocks. Shared by the
  // voice picker and the VoiceGen "Move to Autocut" cross-tab entry.
  async function sacAlignVoice(audioPath) {
    // Always align against the CURRENT spreadsheet, not the last-validated blocks.
    // (User may have edited/pasted script without re-validating.)
    var fresh = parseBlocks();
    if (fresh.length === 0) {
      sacSetVoiceInfo('⚠ Chưa có script. Điền/paste script rồi chọn voice lại.');
      sacVoicePath = audioPath;
      return;
    }
    // Re-render block cards if they're stale vs the spreadsheet, so the voice
    // badges map onto blocks that actually match the current script.
    var freshKey = JSON.stringify(fresh.map(function(b) { return b.texts; }));
    var shownKey = JSON.stringify(parsedBlocks.map(function(b) { return b.texts; }));
    if (freshKey !== shownKey) renderBlocks(fresh);

    sacVoicePath = audioPath;
    sacVoicePlayerSetSrc(audioPath); // show mini player for any voice source
    var shortName = audioPath.split('/').pop();
    sacSetVoiceInfo('⏳ Align: ' + shortName + '...');

    try {
      var resp = await fetch(BRIDGE_URL + '/superautocut/voice-align', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioPath: audioPath,
          blocks: parsedBlocks.map(function(b) { return { texts: b.texts }; }),
        }),
      });
      var d = await resp.json();
      if (!d.ok) { sacSetVoiceInfo('❌ ' + (d.error || 'align lỗi')); return; }

      // Log what Whisper heard so content mismatches are easy to spot.
      console.log('[SAC] Voice transcript:', d.fullText || '(rỗng)');

      var matched = 0;
      (d.alignments || []).forEach(function(a, i) {
        if (!parsedBlocks[i]) return;
        parsedBlocks[i].voiceStart    = a.start;
        parsedBlocks[i].voiceEnd      = a.end;
        parsedBlocks[i].voiceDuration = a.duration;
        var ok = (a.duration != null);
        if (ok) matched++; // count regardless of whether the badge DOM exists
        // NB: dataset.blockIdx → attribute "data-block-idx" (kebab-case)
        var badge = document.querySelector('.sac-blockVoiceBadge[data-block-idx="' + i + '"]');
        if (badge) {
          if (ok) {
            badge.textContent = '🎤 ' + a.duration.toFixed(1) + 's';
            badge.className = 'sac-blockVoiceBadge ' + (a.status === 'matched' ? 'sac-voiceOk' : 'sac-voiceWeak');
          } else {
            badge.textContent = '🎤 ?';
            badge.className = 'sac-blockVoiceBadge sac-voiceMissing';
          }
        }
      });
      window.sacVoicePath = sacVoicePath; // expose for Phase 5
      sacVoiceReady = (matched > 0);
      sacUpdateRunVisibility();
      if (matched === 0) {
        sacSetVoiceInfo('⚠ Khớp 0/' + parsedBlocks.length + ' — voice không trùng script (Console)');
      } else {
        var hint = sacValidatePassed ? ' — Run đã mở' : ' — Validate để mở Run';
        sacSetVoiceInfo('✅ Khớp ' + matched + '/' + parsedBlocks.length + ' blocks' + hint);
      }
    } catch(e) {
      sacSetVoiceInfo('❌ Bridge offline: ' + e.message);
    }
  }

  // Cross-tab entry: VoiceGen "Move to Autocut" → reuse a generated audio file.
  window.AutocutPushVoice = function(audioPath) {
    var tabBtn = document.querySelector('.tab-btn[data-tab="autocut"]');
    if (tabBtn) tabBtn.click();
    document.querySelectorAll('.sac-methodBtn').forEach(function(b) {
      b.classList.toggle('is-active', b.dataset.method === 'manual');
    });
    $('sacPanelManual').style.display = 'flex';
    $('sacPanelScreenshot').style.display = 'none';
    sacAlignVoice(audioPath);
  };

  // ── Screenshot: UXP file picker ─────────────────────────────────────────
  var sacImgDataUrl = null;

  function sacLoadImageFile(file) {
    file.read({ format: require('uxp').storage.formats.binary })
      .then(function(data) {
        var bytes = new Uint8Array(data);
        var bin = '';
        for (var b = 0; b < bytes.length; b++) bin += String.fromCharCode(bytes[b]);
        var ext  = file.name.split('.').pop().toLowerCase();
        var mime = (ext === 'png') ? 'image/png' : 'image/jpeg';
        sacImgDataUrl = 'data:' + mime + ';base64,' + btoa(bin);

        // Plain <img> preview — reliable in UXP (canvas + new Image() is flaky)
        var preview = $('sacImgPreview');
        preview.src = sacImgDataUrl;
        preview.hidden = false;
        preview.style.display = 'block';
        // swap the card into "has image" mode: hide the prompt, show preview
        $('sacDrop').classList.add('has-image');
        $('sacDropPrompt').style.display = 'none';
        $('sacParseImg').disabled = false;
        $('sacImgStatus').textContent = '';
        $('sacImgStatus').style.display = 'none';
      })
      .catch(function(e) {
        $('sacImgStatus').textContent = '❌ Không đọc được file: ' + e.message;
        $('sacImgStatus').style.display = 'block';
      });
  }

  function sacOpenImagePicker() {
    try {
      var storage = require('uxp').storage;
      storage.localFileSystem.getFileForOpening({
        allowMultiple: false,
        types: storage.fileTypes.images,
      }).then(function(file) {
        if (!file) return;
        sacLoadImageFile(file);
      }).catch(function(e) {
        console.error('[SAC] file picker:', e);
      });
    } catch(e) {
      $('sacImgStatus').textContent = '❌ File picker không khả dụng: ' + e.message;
      $('sacImgStatus').style.display = 'block';
    }
  }

  // Clicking anywhere on the big card opens the picker (also re-picks to swap image)
  var sacDrop = $('sacDrop');
  if (sacDrop) sacDrop.addEventListener('click', sacOpenImagePicker);

  // ── Event listeners ──────────────────────────────────────────────────────
  $('sacAddRow').addEventListener('click', function() { createRow(); });

  $('sacClearBoard').addEventListener('click', function() {
    $('sacBody').innerHTML = '';
    rowSeq = 0;
    $('sacBlockSection').style.display = 'none';
    $('sacStatus').style.display = 'none';
    parsedBlocks = [];
    createRow(); createRow(); createRow();
  });

  // Validate = render blocks + check sources in bin + check structure (1 click).
  $('sacPreviewBtn').addEventListener('click', sacValidateAll);

  async function sacValidateAll() {
    var btn = $('sacPreviewBtn');
    var status = $('sacStatus');
    var blocks = parseBlocks();
    if (blocks.length === 0) {
      status.textContent = 'Chưa có dữ liệu. Điền ít nhất 1 dòng có cả Script và Source.';
      status.style.display = 'block';
      return;
    }

    renderBlocks(blocks); // shows block cards with ⌛ on each source
    btn.disabled = true;
    var oldLabel = btn.textContent;
    btn.textContent = '⏳ Validating...';
    status.textContent = '⏳ Đang kiểm tra source + cấu trúc...';
    status.style.display = 'block';

    try {
      // 1) Source validation against the Premiere bin (updates ✓/✗ icons)
      var srcResult = await sacValidateSources(blocks);

      // 2) Structure validation via bridge
      var resp = await fetch(BRIDGE_URL + '/superautocut/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks: blocks }),
      });
      var d = await resp.json();

      if (!d.ok) {
        status.textContent = '❌ ' + (d.errors ? d.errors.join(' | ') : d.error);
        sacValidatePassed = false;
      } else if (srcResult.missing.length > 0) {
        status.textContent = '⚠ Cấu trúc OK nhưng thiếu source trong bin: '
          + srcResult.missing.join(', ') + ' (xem Console).';
        sacValidatePassed = false;
      } else if (srcResult.ambiguous && srcResult.ambiguous.length > 0) {
        // Ambiguous sources: structure OK + all found, but some names match multiple clips
        status.textContent = '⚠ Source trùng tên — cần folder hint (bấm 📁): '
          + srcResult.ambiguous.join(', ');
        sacValidatePassed = false;
      } else {
        var note = srcResult.premiereAvailable ? '' : ' (dev mode — chưa kiểm tra bin)';
        sacValidatePassed = true;
        status.textContent = sacVoiceReady
          ? ('✅ ' + d.blockCount + ' blocks OK + voice sẵn sàng. Bấm "Run AutoCut".' + note)
          : ('✅ ' + d.blockCount + ' blocks hợp lệ. Thêm voice (⚡ Gen / 📂) để mở Run.' + note);
      }
      sacUpdateRunVisibility();
    } catch(e) {
      status.textContent = '❌ Bridge offline: ' + e.message;
      sacValidatePassed = false;
      sacUpdateRunVisibility();
    } finally {
      btn.disabled = false;
      btn.textContent = oldLabel;
    }
  }

  // ── Parse với AI (screenshot → rows) ────────────────────────────────────
  var sacParseImg = $('sacParseImg');
  if (sacParseImg) {
    sacParseImg.addEventListener('click', function() {
      if (!sacImgDataUrl) return;
      sacParseImg.disabled = true;
      sacParseImg.textContent = '⏳ Đang phân tích...';
      $('sacImgStatus').textContent = '';
      $('sacImgStatus').style.display = 'none';

      fetch(BRIDGE_URL + '/superautocut/parse-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: sacImgDataUrl }),
      })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          sacParseImg.disabled = false;
          sacParseImg.textContent = 'Parse với AI →';
          if (!d.ok || !d.rows || d.rows.length === 0) {
            $('sacImgStatus').textContent = '❌ ' + (d.error || 'Không parse được.');
            $('sacImgStatus').style.display = 'block';
            return;
          }
          // Switch to manual tab and load rows
          document.querySelectorAll('.sac-methodBtn').forEach(function(b) {
            b.classList.toggle('is-active', b.dataset.method === 'manual');
          });
          $('sacPanelManual').style.display = 'flex';
          $('sacPanelScreenshot').style.display = 'none';
          $('sacBody').innerHTML = ''; rowSeq = 0;
          var expanded = expandRows(d.rows.map(function(r) {
            return [ r.text || '', r.time || '', r.source || '' ];
          }));
          expanded.forEach(function(cols) {
            createRow(cols[0], cols[1], cols[2]);
          });
        })
        .catch(function(e) {
          sacParseImg.disabled = false;
          sacParseImg.textContent = 'Parse với AI →';
          $('sacImgStatus').textContent = '❌ Bridge lỗi: ' + e.message;
          $('sacImgStatus').style.display = 'block';
        });
    });
  }

  $('sacClearBlocks').addEventListener('click', function() {
    $('sacBlockSection').style.display = 'none';
    parsedBlocks = [];
  });

  // ── Cut panel buttons ───────────────────────────────────────────────────

  // "Without voice" button (in voice panel) → enter no-voice cut mode
  var sacCutNoVoiceBtn = $('sacCutNoVoiceBtn');
  if (sacCutNoVoiceBtn) sacCutNoVoiceBtn.addEventListener('click', function() {
    if (!sacValidatePassed) return;
    sacNoVoiceMode = true;
    sacUpdateRunVisibility();
  });

  // [✕] back — return to voice panel
  var sacCutBackBtn = $('sacCutBack');
  if (sacCutBackBtn) sacCutBackBtn.addEventListener('click', function() {
    sacNoVoiceMode = false;
    sacHideCutPanel();
    sacUpdateRunVisibility();
  });

  // [▶ This seq] — run assembly into current active sequence
  var sacCutThisBtn = $('sacCutThis');
  if (sacCutThisBtn) sacCutThisBtn.addEventListener('click', function() {
    sacRunAutoCut('current');
  });

  // [▶ New seq] — run assembly into a new sequence (uses form settings)
  var sacCutNewBtn = $('sacCutNew');
  if (sacCutNewBtn) sacCutNewBtn.addEventListener('click', function() {
    sacRunAutoCut('new');
  });

  // [⚙] — toggle new seq settings form
  var sacCutNewSettingsBtn = $('sacCutNewSettings');
  if (sacCutNewSettingsBtn) sacCutNewSettingsBtn.addEventListener('click', function() {
    var form = $('sacNewSeqForm');
    if (!form) return;
    var open = form.style.display !== 'none';
    form.style.display = open ? 'none' : 'flex';
    sacCutNewSettingsBtn.classList.toggle('is-active', !open);
    // Pre-fill name with timestamp default on first open
    if (!open) {
      var inp = $('sacNewSeqName');
      if (inp && !inp.value) inp.value = 'AutoCut';
    }
  });

  // Keyboard claim/release for new seq name input
  var sacNewSeqNameInp = $('sacNewSeqName');
  if (sacNewSeqNameInp) {
    sacNewSeqNameInp.addEventListener('focus', function() { if (window.claimKeyboard) window.claimKeyboard(); });
    sacNewSeqNameInp.addEventListener('blur',  function() { if (window.releaseKeyboard) window.releaseKeyboard(); });
  }

  // ── Success panel buttons ────────────────────────────────────────────────
  var sacBackToScriptBtn = $('sacBackToScript');
  if (sacBackToScriptBtn) sacBackToScriptBtn.addEventListener('click', function() {
    $('sacSuccessPanel').style.display = 'none';
    $('sacPanelManual').style.display = 'flex';
  });

  var sacNewAutocutBtn = $('sacNewAutocut');
  if (sacNewAutocutBtn) sacNewAutocutBtn.addEventListener('click', function() {
    $('sacSuccessPanel').style.display = 'none';
    parsedBlocks = [];
    sacSourceMap = {};
    sacVoicePath = null;
    window.sacVoicePath = null;
    sacValidatePassed = false;
    sacVoiceReady = false;
    sacNoVoiceMode = false;
    $('sacBlockSection').style.display = 'none';
    $('sacVoicePlayer').style.display = 'none';
    $('sacVoiceInfo').textContent = 'Chưa có voice';
    $('sacStatus').style.display = 'none';
    $('sacNewSeqForm').style.display = 'none';
    $('sacBody').innerHTML = '';
    rowSeq = 0;
    createRow(); createRow(); createRow();
    $('sacPanelManual').style.display = 'flex';
    sacUpdateRunVisibility();
  });

  // Voice controls (Phase 4a / Approach B)
  var sacVoiceBtn = $('sacVoiceBtn');
  if (sacVoiceBtn) sacVoiceBtn.addEventListener('click', sacPickVoiceFile);
  var sacVoiceGenBtn = $('sacVoiceGenBtn');
  if (sacVoiceGenBtn) sacVoiceGenBtn.addEventListener('click', sacGenVoice);
  var sacVoicePlay = $('sacVoicePlay');
  if (sacVoicePlay) sacVoicePlay.addEventListener('click', function() {
    if (sacVP.playing) sacVPStop(); else sacVPPlay();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 5 — Assembly  (UXP API: SequenceEditor + transaction)
  // Ref: https://developer.adobe.com/premiere-pro/uxp/ppro_reference/classes/sequenceeditor/
  // ═══════════════════════════════════════════════════════════════════════════

  // Parse "M:SS" or "M:SS-M:SS" → {inSec, outSec}. Single ts defaults to 3s.
  function parseSourceTime(str) {
    if (!str || !str.trim()) return { inSec: 0, outSec: 3 };
    var s = str.trim();
    var m = s.match(/^(\d+):(\d+)(?:-(\d+):(\d+))?$/);
    if (!m) return { inSec: 0, outSec: 3 };
    var inSec  = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    var outSec = (m[3] != null)
      ? parseInt(m[3], 10) * 60 + parseInt(m[4], 10)
      : inSec + 3;
    return { inSec: inSec, outSec: Math.max(outSec, inSec + 0.1) };
  }

  // TickTime via ppro.TickTime.createWithSeconds (official UXP API).
  function sacMakeTime(seconds) {
    if (ppro && ppro.TickTime) {
      try { return ppro.TickTime.createWithSeconds(seconds); } catch(e) {}
    }
    return { seconds: seconds, ticks: secToTicks(seconds) };
  }

  // Return seconds position of the last clip on V1 (append cursor).
  // Scan one track for the furthest clip end (seconds).
  async function sacScanTrackEnd(track, endRef) {
    if (!track) return;
    try {
      var items = await getClipItems(track);
      for (var i = 0; i < items.length; i++) {
        try {
          var e = items[i].getEnd && items[i].getEnd();
          if (e && typeof e.then === 'function') e = await e;
          var eSec = getTimeSec(e);
          if (eSec > endRef.v) endRef.v = eSec;
        } catch(er) {}
      }
    } catch(er) {}
  }

  // Return the end position (seconds) of the last clip across ALL tracks.
  // Checks video+audio via multiple API paths so the cursor never resets to 0.
  async function sacGetSequenceEnd(seq) {
    var endRef = { v: 0 }; // use object so sacScanTrackEnd can mutate it

    // Path A: trackGroup API (if ppro.Backend exists)
    try {
      if (ppro.Backend && seq.trackGroup) {
        var TYPES = [ppro.Backend.MEDIATYPE_VIDEO, ppro.Backend.MEDIATYPE_AUDIO];
        for (var ti = 0; ti < TYPES.length; ti++) {
          var grp = seq.trackGroup(TYPES[ti]);
          if (!grp) continue;
          for (var gi = 0; gi < grp.numTracks; gi++) {
            await sacScanTrackEnd(grp.getTrack(gi), endRef);
          }
        }
      }
    } catch(eA) {}

    // Path B: getVideoTrack / getAudioTrack (async per-track API)
    if (endRef.v === 0) {
      var trackGetters = [
        { cntFn: 'getVideoTrackCount', getFn: 'getVideoTrack' },
        { cntFn: 'getAudioTrackCount', getFn: 'getAudioTrack' },
      ];
      for (var p = 0; p < trackGetters.length; p++) {
        try {
          var cnt = seq[trackGetters[p].cntFn] && seq[trackGetters[p].cntFn]();
          if (cnt && typeof cnt.then === 'function') cnt = await cnt;
          cnt = Number(cnt) || 0;
          for (var idx = 0; idx < cnt; idx++) {
            var tr = seq[trackGetters[p].getFn] && seq[trackGetters[p].getFn](idx);
            if (tr && typeof tr.then === 'function') tr = await tr;
            await sacScanTrackEnd(tr, endRef);
          }
        } catch(eB) {}
      }
    }

    // Path C: sequence duration as last resort
    if (endRef.v === 0) {
      try {
        var dur = seq.getDuration && seq.getDuration();
        if (dur && typeof dur.then === 'function') dur = await dur;
        var d = getTimeSec(dur);
        if (d > 0) endRef.v = d;
      } catch(eC) {}
    }

    console.log('[SAC] sacGetSequenceEnd =', endRef.v.toFixed(2) + 's');
    return endRef.v;
  }

  // Find or import a file: search bin first, only import if not already in project.
  // Prevents duplicate imports when Run AutoCut is called multiple times.
  async function sacFindOrImportFile(filePath) {
    var proj = await getActiveProject();
    var rootItem = null;
    if (typeof proj.getRootItem === 'function') {
      rootItem = proj.getRootItem();
      if (rootItem && typeof rootItem.then === 'function') rootItem = await rootItem;
    }
    if (!rootItem) rootItem = proj.rootItem;

    var fname = filePath.split('/').pop().split('\\').pop();
    var binItems = rootItem ? (await sacCollectBinItems(rootItem)) : [];

    // Search existing bin first
    var found = binItems.find(function(b) { return b.name === fname; });
    if (found) {
      console.log('[SAC] Voice already in project bin:', fname);
      return found.item;
    }

    // Not found — import
    if (typeof proj.importFiles === 'function') {
      await proj.importFiles([filePath]);
    } else if (typeof proj.importFile === 'function') {
      await proj.importFile(filePath);
    } else {
      throw new Error('No importFiles API on project');
    }
    // Re-scan bin to find the newly imported item
    var binItems2 = rootItem ? (await sacCollectBinItems(rootItem)) : [];
    var found2 = binItems2.find(function(b) { return b.name === fname; });
    return found2 ? found2.item : null;
  }

  // Commit a single lockedAccess/executeTransaction and await if needed.
  async function sacCommitTx(project, fn, label) {
    var r = project.lockedAccess(function() {
      project.executeTransaction(fn, label || 'SAC tx');
    });
    if (r && typeof r.then === 'function') await r;
  }

  // Place a clip on the timeline.
  // TWO separate committed transactions: (1) set source in/out, (2) insert.
  // Reason: in a combined transaction, createSetInOutPointsAction on a shared
  // master clip (e.g. the voice file) takes effect after the transaction commits,
  // not before the insert action inside the SAME transaction. Splitting into two
  // separate commits ensures in/out is fully applied before the insert runs.
  // vIdx = video track (0=V1), 5 = far-away track (effectively skip). aIdx similar.
  async function sacInsertClipAt(project, seqEditor, item, atSec, inSec, outSec, vIdx, aIdx) {
    var timeAt = sacMakeTime(atSec);
    var inPt   = sacMakeTime(inSec);
    var outPt  = sacMakeTime(outSec);

    var clipItem = null;
    if (ppro.ClipProjectItem) {
      try { clipItem = ppro.ClipProjectItem.cast(item); } catch(e) {}
    }

    // Tx 1: commit in/out change first
    if (clipItem && typeof clipItem.createSetInOutPointsAction === 'function') {
      await sacCommitTx(project, function(ca) {
        ca.addAction(clipItem.createSetInOutPointsAction(inPt, outPt));
      }, 'SAC set in/out');
    }

    // Tx 2: insert — master clip in/out is now committed, insert uses it
    await sacCommitTx(project, function(ca) {
      ca.addAction(seqEditor.createOverwriteItemAction(item, timeAt, vIdx, aIdx));
    }, 'SAC insert clip');
  }

  async function sacRunAutoCut(seqMode) {
    seqMode = seqMode || 'current';
    var status = $('sacStatus');
    status.style.display = 'block';
    status.textContent = '⏳ Đang khởi động assembly...';

    try {
      if (!ppro) throw new Error('Premiere Pro API không khả dụng — chạy trong Premiere');
      if (!ppro.SequenceEditor) throw new Error('ppro.SequenceEditor không có — Premiere 25.x+ required');

      var blocks = parsedBlocks.filter(function(b) {
        return (b.sources && b.sources.length > 0) || (!sacNoVoiceMode && b.voiceStart != null);
      });
      if (blocks.length === 0) throw new Error('Không có blocks — validate + align voice trước');

      var project = await getActiveProject();
      var seq, cursor;

      if (seqMode === 'new') {
        status.textContent = '⏳ Tạo sequence mới...';
        // Read settings from form (use defaults if form not visible)
        var nameInp  = $('sacNewSeqName');
        var ratioSel = $('sacNewSeqRatio');
        var fpsSel   = $('sacNewSeqFps');
        var seqName  = (nameInp && nameInp.value.trim()) || 'AutoCut';
        var ratio    = ratioSel ? ratioSel.value : 'match';
        var fps      = fpsSel  ? parseFloat(fpsSel.value) : 29.97;

        // Create sequence: "match" = createSequenceFromMedia (matches first source clip)
        // Other ratios = createSequence then attempt setSettings if API available
        var firstSrcItem = null;
        for (var bi = 0; bi < blocks.length && !firstSrcItem; bi++) {
          for (var si = 0; si < (blocks[bi].sources || []).length; si++) {
            var sn = blocks[bi].sources[si];
            if (!sn.skipped) { firstSrcItem = sacSourceMap[sn.name] || window.sacSourceMap[sn.name]; break; }
          }
        }

        if (ratio === 'match' && firstSrcItem && typeof project.createSequenceFromMedia === 'function') {
          seq = await project.createSequenceFromMedia(seqName, [firstSrcItem]);
        }
        if (!seq) {
          seq = await project.createSequence(seqName);
        }
        if (!seq) throw new Error('Không tạo được sequence mới');

        // Apply custom ratio/fps via createSetSettingsAction (correct UXP API).
        if (ratio !== 'match') {
          try {
            var parts = ratio.split('x');
            var w = parseInt(parts[0]), h = parseInt(parts[1]);
            var settings = await seq.getSettings();
            if (!settings) throw new Error('getSettings returned null');

            // Log available methods for debugging
            var settingsMethods = Object.getOwnPropertyNames(
              Object.getPrototypeOf(settings) || {}
            ).filter(function(k) { try { return typeof settings[k] === 'function'; } catch(e) { return false; } });
            console.log('[SAC] SequenceSettings methods:', settingsMethods.join(', '));

            // Frame dimensions via RectF — each step isolated
            if (w && h) {
              try {
                var frameRect = await settings.getVideoFrameRect();
                frameRect.width  = w;
                frameRect.height = h;
                await settings.setVideoFrameRect(frameRect);
                console.log('[SAC] Frame rect set:', w + 'x' + h);
              } catch(eRect) { console.warn('[SAC] setVideoFrameRect failed:', eRect.message); }
            }

            // Frame rate — try known method names
            if (fps > 0) {
              try {
                var frMethods = ['setVideoFrameRate','setFrameRate','setVideoFrameRateAsFrameRate'];
                var frSet = false;
                for (var fri = 0; fri < frMethods.length && !frSet; fri++) {
                  if (typeof settings[frMethods[fri]] === 'function') {
                    var fr = ppro.FrameRate ? ppro.FrameRate.createWithValue(fps)
                           : ppro.TickTime.createWithSeconds(1 / fps);
                    var frr = settings[frMethods[fri]](fr);
                    if (frr && typeof frr.then === 'function') await frr;
                    console.log('[SAC] FPS set via', frMethods[fri]);
                    frSet = true;
                  }
                }
                if (!frSet) console.warn('[SAC] No setVideoFrameRate method found');
              } catch(eFps) { console.warn('[SAC] fps set failed:', eFps.message); }
            }

            // Apply via transaction
            var rs = project.lockedAccess(function() {
              project.executeTransaction(function(ca) {
                ca.addAction(seq.createSetSettingsAction(settings));
              }, 'SAC set seq settings');
            });
            if (rs && typeof rs.then === 'function') await rs;
            console.log('[SAC] createSetSettingsAction committed');
          } catch(es) { console.warn('[SAC] createSetSettingsAction failed:', es.message); }
        }

        if (typeof project.openSequence    === 'function') await project.openSequence(seq);
        if (typeof project.setActiveSequence === 'function') await project.setActiveSequence(seq);
        cursor = 0;
        console.log('[SAC] New sequence:', seqName, '| ratio:', ratio, '| fps:', fps);
      } else {
        seq    = await getActiveSequence();
        status.textContent = '⏳ Tìm vị trí cuối timeline...';
        cursor = await sacGetSequenceEnd(seq);
      }

      var seqEditor = ppro.SequenceEditor.getEditor(seq); // sync, no await
      if (!seqEditor) throw new Error('Không lấy được SequenceEditor');
      console.log('[SAC] Assembly start at', cursor.toFixed(2) + 's, blocks:', blocks.length,
        sacNoVoiceMode ? '(without voice)' : '');

      // Import voice file once — skip if Without Voice mode
      var voiceItem = null;
      if (!sacNoVoiceMode) {
        var voicePath = sacVoicePath || window.sacVoicePath;
        if (voicePath) {
          status.textContent = '⏳ Import voice...';
          try {
            voiceItem = await sacFindOrImportFile(voicePath);
            console.log('[SAC] Voice:', voiceItem ? 'ok' : 'not found in bin');
          } catch(e) { console.warn('[SAC] Voice import failed:', e.message); }
        }
      }

      var placed = 0;
      for (var i = 0; i < blocks.length; i++) {
        var block      = blocks[i];
        var blockStart = cursor;
        var srcTotal   = 0;
        status.textContent = '⏳ Block ' + (i + 1) + '/' + blocks.length + '...';

        // Place each source clip on V1 (video only), source audio → A2
        for (var j = 0; j < (block.sources || []).length; j++) {
          var src = block.sources[j];

          // Skip check MUST come before srcItem lookup — skipped sources have no item
          if (src.skipped) {
            console.log('[SAC] V1 "' + src.name + '" SKIPPED — 1s gap @' + cursor.toFixed(2) + 's');
            srcTotal += 1.0;
            cursor   += 1.0;
            continue;
          }

          var srcItem = (sacSourceMap[src.name] || window.sacSourceMap[src.name]);
          if (!srcItem) { console.warn('[SAC] Missing source:', src.name); continue; }

          var ts      = parseSourceTime(src.time);
          var clipDur = ts.outSec - ts.inSec;

          await sacInsertClipAt(project, seqEditor, srcItem, cursor, ts.inSec, ts.outSec, 0, 1);
          console.log('[SAC] V1 "' + src.name + '" [' + ts.inSec + '-' + ts.outSec +
            ']s @' + cursor.toFixed(2) + 's');

          srcTotal += clipDur;
          cursor   += clipDur;
        }

        // Place voice segment on A1 (skipped in Without Voice mode)
        if (!sacNoVoiceMode && voiceItem && block.voiceStart != null && block.voiceEnd != null) {
          var vDur = block.voiceDuration || (block.voiceEnd - block.voiceStart);
          var vOut = block.voiceEnd + 0.2;

          await sacInsertClipAt(project, seqEditor, voiceItem, blockStart,
                                block.voiceStart, vOut, 5, 0);
          console.log('[SAC] A1 voice [' + block.voiceStart.toFixed(2) + '-' +
            vOut.toFixed(2) + ']s @' + blockStart.toFixed(2) + 's');

          if (vDur > srcTotal) cursor = blockStart + vDur;
        }

        cursor += 1.0; // 1s gap between blocks
        placed++;
        await new Promise(function(r) { setTimeout(r, 300); });
      }

      // ── Show success panel ────────────────────────────────────────────────
      var statsEl = $('sacSuccessStats');
      if (statsEl) {
        statsEl.textContent = placed + ' blocks · ' + cursor.toFixed(1) + 's' +
          (sacNoVoiceMode ? ' · without voice' : '');
      }
      status.style.display = 'none';
      $('sacPanelManual').style.display = 'none';
      $('sacSuccessPanel').style.display = 'flex';

    } catch(e) {
      status.textContent = '❌ ' + e.message;
      console.error('[SAC] sacRunAutoCut error:', e);
    }
  }

  // ── Collapse/expand the script input section ─────────────────────────────
  var sacScriptToggle = $('sacScriptToggle');
  if (sacScriptToggle) {
    sacScriptToggle.addEventListener('click', function() {
      var wrap = $('sacTableWrap');
      var footer = $('sacTableFooter');
      var wasCollapsed = wrap.style.display === 'none';
      wrap.style.display   = wasCollapsed ? '' : 'none';
      footer.style.display = wasCollapsed ? '' : 'none';
      $('sacScriptChevron').textContent = wasCollapsed ? '▾' : '▸';
      // When script is hidden, let the blocks section grow to fill the panel.
      // (default is a fixed 220px height — see .sac-blockSection)
      $('sacBlockSection').style.flex = wasCollapsed ? '' : '1 1 0';
    });
  }

  // ── Init: 3 empty rows ───────────────────────────────────────────────────
  createRow(); createRow(); createRow();

})(); // END Super Auto Cut module

// ═══════════════════════════════════════════════════════════════════════════
// VOICE GEN MODULE (ElevenLabs)
// ═══════════════════════════════════════════════════════════════════════════
(function() {
  var $ = function(id) { return document.getElementById(id); };
  var els = {
    statusDot:    $('vgStatusDot'),
    statusText:   $('vgStatusText'),
    btnRefresh:   $('vgRefreshVoices'),
    voiceSelect:  $('vgVoiceSelect'),
    customVoiceId: $('vgCustomVoiceId'),
    voiceSource:  $('vgVoiceSource'),
    modelSelect:  $('vgModelSelect'),
    script:       $('vgScript'),
    charCount:    $('vgCharCount'),
    outputFolder: $('vgOutputFolder'),
    btnBrowseFolder: $('vgBrowseFolder'),
    btnResetFolder:  $('vgResetFolder'),
    filename:     $('vgFilename'),
    twoVariations: $('vg2Variations'),
    btnGenerate:  $('vgGenerate'),
    resultSection: $('vgResultSection'),
    var1:         $('vgVar1'),
    var1Size:     $('vgVar1Size'),
    var1Import:   $('vgVar1Import'),
    var2:         $('vgVar2'),
    var2Size:     $('vgVar2Size'),
    var2Import:   $('vgVar2Import'),
    importStatus: $('vgImportStatus'),
  };

  var voicesLoaded = false;
  var customOutputFolder = ''; // empty = use bridge default
  var lastVariations = []; // [{audioPath, previewUrl, sizeBytes, filename}, ...]
  var currentMode = 'tts'; // 'tts' | 'sfx' | 'music'
  var players = {}; // { var1: {audio, isPlaying}, var2: {...} }

  // ── Multi-speaker state ─────────────────────────────────────────────────
  var VG_SPEAKER_COLORS = ['#a855f7','#3b82f6','#22c55e','#f59e0b','#ef4444','#06b6d4'];
  var VG_SPEAKERS = [
    { id: 's1', voiceId: '21m00Tcm4TlvDq8ikWAM', voiceName: 'Rachel', color: '#a855f7' }
  ];
  var VG_ACTIVE_SPEAKER = 's1';
  var VG_SPEAKER_TEXTS = { s1: '' };
  var VG_PREVIEW_URLS  = {}; // voiceId → ElevenLabs CDN preview_url string
  var VG_PREVIEW_CACHE = {}; // voiceId → local bridge URL (cached after first fetch)
  var VG_VOICES_DATA   = []; // { voice_id, label, preview_url, isCustom, isSep }
  var VG_DROP_BTNS     = {}; // voiceId → ▶ button DOM element in dropdown
  var VG_PREV_ACTIVE   = null; // voiceId currently being previewed
  var vgDropResizeHandler = null; // window resize handler while dropdown is open

  function saveCurrentSpeakerText() {
    if (els.script) {
      var v = els.script.value;
      VG_SPEAKER_TEXTS[VG_ACTIVE_SPEAKER] = (v == null ? '' : String(v));
    }
    var sp = VG_SPEAKERS.find(function(s) { return s.id === VG_ACTIVE_SPEAKER; });
    if (sp && els.voiceSelect) {
      sp.voiceId = els.voiceSelect.value || sp.voiceId;
      sp.voiceName = vgVoiceName(sp.voiceId);
    }
  }

  function renderSpeakerBar() {
    var bar = $('vgSpeakerBar');
    if (!bar) return;
    var addBtn = $('vgAddSpeaker');
    // Remove all speaker tabs (keep addBtn)
    var tabs = bar.querySelectorAll('.vg-speakerTab');
    tabs.forEach(function(t) { bar.removeChild(t); });

    VG_SPEAKERS.forEach(function(sp) {
      // Use <div role="button"> instead of <button> to avoid UXP nested-button bug
      // (UXP Chromium doesn't fire click on a <button> nested inside another <button>)
      var tab = document.createElement('div');
      tab.className = 'vg-speakerTab' + (sp.id === VG_ACTIVE_SPEAKER ? ' is-active' : '');
      tab.setAttribute('role', 'button');
      tab.setAttribute('tabindex', '0');
      tab.dataset.speakerId = sp.id;
      tab.style.setProperty('--sp-color', sp.color);

      var nameSpan = document.createElement('span');
      nameSpan.textContent = sp.voiceName;
      tab.appendChild(nameSpan);

      if (VG_SPEAKERS.length > 1) {
        var rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'vg-speakerRemove';
        rm.textContent = '×';
        (function(spId) {
          rm.addEventListener('click', function(e) {
            e.stopPropagation();
            e.preventDefault();
            removeSpeaker(spId);
          });
        })(sp.id);
        tab.appendChild(rm);
      }

      (function(spId) {
        tab.addEventListener('click', function(e) {
          // Ignore if the remove button was clicked (stopPropagation may not fire first in UXP)
          if (e.target && e.target.classList && e.target.classList.contains('vg-speakerRemove')) return;
          switchSpeaker(spId);
        });
        tab.addEventListener('keydown', function(e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchSpeaker(spId); }
        });
      })(sp.id);

      bar.insertBefore(tab, addBtn);
    });
  }

  function switchSpeaker(newId) {
    saveCurrentSpeakerText();
    VG_ACTIVE_SPEAKER = newId;
    var sp = VG_SPEAKERS.find(function(s) { return s.id === newId; });
    if (sp) {
      if (els.script) { els.script.value = VG_SPEAKER_TEXTS[newId] || ''; vgAutoResize(els.script); }
      vgSetVoice(sp.voiceId);
    }
    renderSpeakerBar();
  }

  function addSpeaker() {
    saveCurrentSpeakerText();
    var newId = 's' + Date.now();
    var colorIdx = VG_SPEAKERS.length % VG_SPEAKER_COLORS.length;
    VG_SPEAKERS.push({
      id: newId,
      voiceId: 'pNInz6obpgDQGcFmaJgB', // Adam — distinct default second voice
      voiceName: 'Adam',
      color: VG_SPEAKER_COLORS[colorIdx],
    });
    VG_SPEAKER_TEXTS[newId] = '';
    switchSpeaker(newId);
  }

  function removeSpeaker(id) {
    if (VG_SPEAKERS.length <= 1) return;
    var idx = VG_SPEAKERS.findIndex(function(s) { return s.id === id; });
    if (idx < 0) return;
    VG_SPEAKERS.splice(idx, 1);
    delete VG_SPEAKER_TEXTS[id];
    if (VG_ACTIVE_SPEAKER === id) {
      switchSpeaker(VG_SPEAKERS[Math.max(0, idx - 1)].id);
    } else {
      renderSpeakerBar();
    }
  }

  // ── Audio engine: delegate to bridge (afplay on macOS) ───────────────────
  // UXP has no HTMLMediaElement and no AudioContext — the bridge runs afplay
  // and holds the HTTP connection open until playback finishes. Aborting the
  // fetch from the plugin side auto-signals the bridge to kill afplay via
  // a concurrent /tts/stop call.
  var vgIsPlaying    = false;
  var vgAbortCtrl    = null;
  var vgOnStopCb     = null;

  // url must be a full URL like http://localhost:3030/tts/audio/xxx.mp3
  // onEnd() fires when playback ends naturally OR is stopped.
  // onError(msg) fires on bridge/network errors.
  // onProgress is accepted but unused (no seek support via afplay).
  function vgPlayUrl(url, onProgress, onEnd, onError) {
    // Stop previous without sending /tts/stop — new /tts/play will kill old process
    if (vgAbortCtrl) { vgAbortCtrl.abort(); vgAbortCtrl = null; }
    if (vgOnStopCb)  { var prev = vgOnStopCb; vgOnStopCb = null; prev(); }
    vgIsPlaying = false;

    var relUrl = url.startsWith(BRIDGE_URL) ? url.slice(BRIDGE_URL.length) : url;
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    vgAbortCtrl  = ctrl;
    vgOnStopCb   = onEnd || null;
    vgIsPlaying  = true;

    fetch(BRIDGE_URL + '/tts/play', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ audioUrl: relUrl }),
      signal:  ctrl ? ctrl.signal : undefined,
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!vgIsPlaying) return; // already stopped by user
        vgIsPlaying  = false;
        vgAbortCtrl  = null;
        var cb = vgOnStopCb; vgOnStopCb = null;
        if (cb) cb();
      })
      .catch(function(e) {
        if (e && e.name === 'AbortError') return; // intentional stop — onEnd already called
        vgIsPlaying = false;
        vgAbortCtrl = null;
        vgOnStopCb  = null;
        console.error('[vgPlayUrl]', relUrl, e);
        if (onError) onError(e.message || String(e));
      });
  }

  // Play an absolute file path directly — no temp-dir HTTP serving needed.
  // startOffset (optional): seconds to seek to before playing (uses ffplay on bridge).
  function vgPlayPath(absPath, onProgress, onEnd, onError, startOffset) {
    if (vgAbortCtrl) { vgAbortCtrl.abort(); vgAbortCtrl = null; }
    if (vgOnStopCb)  { var prev = vgOnStopCb; vgOnStopCb = null; prev(); }
    vgIsPlaying = false;
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    vgAbortCtrl = ctrl;
    vgOnStopCb  = onEnd || null;
    vgIsPlaying = true;
    var body = { filePath: absPath };
    if (startOffset > 0) body.startOffset = startOffset;
    fetch(BRIDGE_URL + '/tts/play', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  ctrl ? ctrl.signal : undefined,
    })
      .then(function(r) { return r.json(); })
      .then(function() {
        if (!vgIsPlaying) return;
        vgIsPlaying = false; vgAbortCtrl = null;
        var cb = vgOnStopCb; vgOnStopCb = null; if (cb) cb();
      })
      .catch(function(e) {
        if (e && e.name === 'AbortError') return;
        vgIsPlaying = false; vgAbortCtrl = null; vgOnStopCb = null;
        if (onError) onError(e.message || String(e));
      });
  }


  function vgStopAll() {
    if (!vgIsPlaying && !vgAbortCtrl) return;
    if (vgAbortCtrl) { vgAbortCtrl.abort(); vgAbortCtrl = null; }
    vgIsPlaying = false;
    var cb = vgOnStopCb; vgOnStopCb = null;
    if (cb) cb();
    // Tell bridge to kill afplay
    fetch(BRIDGE_URL + '/tts/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).catch(function() {});
  }

  // ── Player factory ────────────────────────────────────────────────────────
  function createPlayer(slot) {
    var prefix = 'vgV' + (slot === 'var1' ? 'ar1' : 'ar2');
    var playBtn  = $(prefix + 'Play');
    var progWrap = $(prefix + 'ProgWrap');
    var fill     = $(prefix + 'Fill');
    var timeEl   = $(prefix + 'Time');
    var currentPath = null;
    var isPlaying   = false;
    var duration    = 0;
    var startedAt   = 0;
    var startOffset = 0;
    var ticker      = null;

    function fmt(s) {
      if (!isFinite(s) || s < 0) s = 0;
      var m = Math.floor(s / 60), sec = Math.floor(s % 60);
      return m + ':' + (sec < 10 ? '0' : '') + sec;
    }
    function updateTick() {
      var elapsed = startOffset + (Date.now() - startedAt) / 1000;
      if (duration > 0 && elapsed > duration) elapsed = duration;
      timeEl.textContent = fmt(elapsed) + ' / ' + fmt(duration);
      fill.style.width = duration > 0 ? (elapsed / duration * 100).toFixed(1) + '%' : '0%';
    }
    function stopTicker() {
      if (ticker) { clearInterval(ticker); ticker = null; }
    }
    function setPlaying(val) {
      isPlaying = val;
      playBtn.textContent = val ? '⏸' : '▶';
      if (!val) stopTicker();
    }
    function doPlay(offset) {
      offset = offset || 0;
      startOffset = offset;
      startedAt   = Date.now();
      setPlaying(true);
      ticker = setInterval(updateTick, 200);
      vgPlayPath(currentPath, null,
        function() {
          setPlaying(false);
          fill.style.width = duration > 0 ? '100%' : '0%';
          timeEl.textContent = fmt(duration) + ' / ' + fmt(duration);
        },
        function(e) { setPlaying(false); timeEl.textContent = 'error'; console.warn('[VG player ' + slot + ']', e); },
        offset
      );
    }

    playBtn.addEventListener('click', function() {
      if (!currentPath) return;
      if (isPlaying) { vgStopAll(); return; }
      doPlay(0);
    });

    if (progWrap) {
      progWrap.addEventListener('click', function(e) {
        if (!currentPath || duration <= 0) return;
        var rect = progWrap.getBoundingClientRect();
        var frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        var offset = frac * duration;
        if (isPlaying) { vgStopAll(); stopTicker(); setPlaying(false); }
        setTimeout(function() { doPlay(offset); }, 60);
      });
    }

    return {
      setSrc: function(absPath) {
        if (isPlaying) { vgStopAll(); setPlaying(false); }
        stopTicker();
        currentPath = absPath;
        duration = 0;
        fill.style.width = '0%';
        timeEl.textContent = '0:00 / ?';
        fetch(BRIDGE_URL + '/tts/duration', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioPath: absPath }),
        }).then(function(r) { return r.json(); }).then(function(d) {
          if (d.ok && d.duration > 0) {
            duration = d.duration;
            timeEl.textContent = '0:00 / ' + fmt(duration);
          }
        }).catch(function() {});
      },
    };
  }

  function setStatus(text, ok) {
    els.statusText.textContent = text;
    if (ok) els.statusDot.classList.add('is-ok');
    else    els.statusDot.classList.remove('is-ok');
  }

  // (sliders + meta are wired via hookSlider below — this just refreshes the meta line)
  function updateSettingsMeta() {
    if (!els.settingsMeta) return;
    function n(el, d) { var v = el && parseFloat(el.value); return isNaN(v) ? d : v; }
    els.settingsMeta.textContent =
      'stability ' + n(els.stability, 0.5).toFixed(2) +
      ' · similarity ' + n(els.similarity, 0.75).toFixed(2) +
      ' · style ' + n(els.style, 0).toFixed(2);
  }

  // UXP textarea .value can be null when empty — guard
  function safeLen(el) {
    if (!el) return 0;
    var v = el.value;
    if (v == null) return 0;
    return String(v).length;
  }
  function updateCharCount() {
    if (!els.charCount) return;
    var n = safeLen(els.script);
    els.charCount.textContent = n + ' / 5000';
    els.charCount.style.color = n > 5000 ? 'var(--error)' : '';
  }

  // Try to load voices from user's ElevenLabs account.
  // Falls back gracefully if key is TTS-restricted (no voices_read perm).
  // ── Helpers ──────────────────────────────────────────────────────────────
  function vgVoiceName(voiceId) {
    var v = VG_VOICES_DATA.find(function(x) { return !x.isSep && x.voice_id === voiceId; });
    if (v) return v.label.replace(/^⭐\s*/, '').split(' · ')[0];
    var opt = els.voiceSelect ? els.voiceSelect.options[els.voiceSelect.selectedIndex] : null;
    return opt ? opt.textContent.replace(/^⭐\s*/, '').split(' · ')[0] : 'Voice';
  }

  function vgSetVoice(voiceId) {
    if (els.voiceSelect) els.voiceSelect.value = voiceId;
    var v = VG_VOICES_DATA.find(function(x) { return !x.isSep && x.voice_id === voiceId; });
    var label = v ? v.label : (els.voiceSelect && els.voiceSelect.options[els.voiceSelect.selectedIndex]
      ? els.voiceSelect.options[els.voiceSelect.selectedIndex].textContent : voiceId);
    var labelEl = $('vgVoiceDropLabel');
    if (labelEl) labelEl.textContent = label.replace(/^⭐\s*/, '');
    if (els.customVoiceId) els.customVoiceId.hidden = voiceId !== '__custom__';
  }

  // ── Custom voice dropdown ────────────────────────────────────────────────
  function renderVoiceDrop() {
    var panel = $('vgVoiceDropPanel');
    if (!panel) return;
    panel.innerHTML = '';
    VG_DROP_BTNS = {};
    var currentId = els.voiceSelect ? els.voiceSelect.value : '';

    // Search row
    var searchWrap = document.createElement('div');
    searchWrap.className = 'vg-dropSearch';
    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'vg-dropSearchInput';
    searchInput.placeholder = 'Search voices…';
    searchWrap.appendChild(searchInput);
    panel.appendChild(searchWrap);

    // Scrollable list container
    var listEl = document.createElement('div');
    listEl.className = 'vg-dropList';
    panel.appendChild(listEl);

    // Pre-render all items once. Filtering only toggles display — no innerHTML
    // rebuild on each keystroke, so UXP never resets the input's focus/selection.
    var _allItems = [];
    VG_VOICES_DATA.forEach(function(v) {
      if (v.isSep) {
        var sep = document.createElement('div');
        sep.className = 'vg-dropSep';
        sep.textContent = '── Default voices ──';
        listEl.appendChild(sep);
        _allItems.push({ el: sep, isSep: true });
        return;
      }

      var item = document.createElement('div');
      item.className = 'vg-dropItem' + (v.voice_id === currentId ? ' is-selected' : '');

      var info = document.createElement('div');
      info.className = 'vg-dropItemLabel';
      info.textContent = (v.isCustom ? '⭐ ' : '') + v.label;
      item.appendChild(info);

      if (v.voice_id !== '__custom__') {
        var btn = document.createElement('button');
        btn.className = 'vg-dropItemPrev';
        btn.textContent = '▶';
        VG_DROP_BTNS[v.voice_id] = btn;
        (function(vid, b) {
          b.addEventListener('click', function(e) {
            e.stopPropagation();
            vgPreviewItem(vid, b);
          });
        })(v.voice_id, btn);
        item.appendChild(btn);
      }

      info.addEventListener('click', function() { vgDropSelect(v.voice_id, v.label); });
      listEl.appendChild(item);
      _allItems.push({ el: item, isSep: false, label: v.label });
    });

    function buildList(filter) {
      var f = (filter || '').toLowerCase().trim();
      _allItems.forEach(function(entry) {
        if (entry.isSep) { entry.el.style.display = f ? 'none' : ''; return; }
        entry.el.style.display = (!f || entry.label.toLowerCase().indexOf(f) !== -1) ? '' : 'none';
      });
    }

    // claimKeyboard is managed at the dropdown open/close level (openVoiceDrop /
    // closeVoiceDrop) to avoid repeated setKeyboardFocus(true) calls from phantom
    // focus events that UXP fires during layout — each call could trigger select-all.
    var _composing = false;
    searchInput.addEventListener('compositionstart', function() { _composing = true; });
    searchInput.addEventListener('compositionend', function() { _composing = false; buildList(searchInput.value); });
    searchInput.addEventListener('input', function() { if (!_composing) buildList(searchInput.value); });
  }

  function repositionVoiceDrop() {
    var panel = $('vgVoiceDropPanel');
    var trigger = $('vgVoiceDropTrigger');
    var container = document.getElementById('tab-voicegen');
    if (!panel || !trigger || !container) return;
    var triggerRect = trigger.getBoundingClientRect();
    var contRect    = container.getBoundingClientRect();
    panel.style.top   = (triggerRect.bottom - contRect.top)  + 'px';
    panel.style.left  = (triggerRect.left   - contRect.left) + 'px';
    panel.style.width = triggerRect.width + 'px';
  }

  function openVoiceDrop() {
    var panel = $('vgVoiceDropPanel');
    var trigger = $('vgVoiceDropTrigger');
    if (!panel || !trigger) return;
    repositionVoiceDrop();
    panel.style.maxHeight = '240px';
    panel.style.display  = 'flex';
    trigger.classList.add('is-open');
    if (!vgDropResizeHandler) {
      vgDropResizeHandler = function() { repositionVoiceDrop(); };
      window.addEventListener('resize', vgDropResizeHandler);
    }
    // Claim keyboard once here so Premiere doesn't intercept keys while dropdown
    // is open. Doing it on the input's focus event caused repeated calls during
    // UXP layout reflows (each call may trigger select-all on the input).
    window.claimKeyboard();
    var si = panel.querySelector('.vg-dropSearchInput');
    if (si) setTimeout(function() { try { si.focus(); } catch(e) {} }, 30);
  }

  function closeVoiceDrop() {
    var panel = $('vgVoiceDropPanel');
    var trigger = $('vgVoiceDropTrigger');
    if (panel) panel.style.display = 'none';
    if (trigger) trigger.classList.remove('is-open');
    if (vgDropResizeHandler) {
      window.removeEventListener('resize', vgDropResizeHandler);
      vgDropResizeHandler = null;
    }
    window.releaseKeyboard();
    if (VG_PREV_ACTIVE) { vgStopAll(); }
  }

  function vgDropSelect(voiceId, label) {
    vgSetVoice(voiceId);
    closeVoiceDrop();
    // Fire change on hidden select so existing listeners react
    var evt = document.createEvent('Event');
    evt.initEvent('change', true, true);
    if (els.voiceSelect) els.voiceSelect.dispatchEvent(evt);
  }

  // ── Per-item voice preview ───────────────────────────────────────────────
  function vgPreviewItem(voiceId, btn) {
    if (!ELEVENLABS_KEY) { setStatus('Need ElevenLabs key', false); return; }

    // Same voice playing → stop
    if (VG_PREV_ACTIVE === voiceId) {
      vgStopAll();
      return;
    }
    // Different voice was playing → reset its button
    if (VG_PREV_ACTIVE) {
      var oldBtn = VG_DROP_BTNS[VG_PREV_ACTIVE];
      if (oldBtn) { oldBtn.textContent = '▶'; oldBtn.classList.remove('is-playing'); }
      vgStopAll();
    }

    var url = VG_PREVIEW_CACHE[voiceId];
    if (url) {
      vgStartPreviewPlay(voiceId, btn, url);
      return;
    }

    btn.disabled = true;
    btn.textContent = '…';

    (async function() {
      try {
        if (VG_PREVIEW_URLS[voiceId]) {
          var pvResp = await postJsonVG('/tts/voice-preview', {
            previewUrl: VG_PREVIEW_URLS[voiceId], voiceId: voiceId,
          });
          if (!pvResp.ok) throw new Error(pvResp.error || 'preview fetch failed');
          url = BRIDGE_URL + pvResp.previewUrl;
        } else {
          var resp = await postJsonVG('/tts/generate', {
            apiKey: ELEVENLABS_KEY, voiceId: voiceId,
            modelId: 'eleven_turbo_v2_5',
            text: 'Hello, this is a voice sample.',
            variations: 1, filename: 'preview-' + voiceId,
          });
          if (!resp.ok || !resp.variations || !resp.variations[0])
            throw new Error(resp.error || 'preview failed');
          url = BRIDGE_URL + resp.variations[0].previewUrl;
        }
        VG_PREVIEW_CACHE[voiceId] = url;
        btn.disabled = false;
        vgStartPreviewPlay(voiceId, btn, url);
      } catch(e) {
        btn.disabled = false;
        btn.textContent = '▶';
        VG_PREV_ACTIVE = null;
        setStatus('Preview: ' + e.message, false);
      }
    })();
  }

  function vgStartPreviewPlay(voiceId, btn, url) {
    VG_PREV_ACTIVE = voiceId;
    btn.textContent = '⏸';
    btn.classList.add('is-playing');
    vgPlayUrl(url, null,
      function() {
        if (VG_PREV_ACTIVE === voiceId) VG_PREV_ACTIVE = null;
        btn.textContent = '▶';
        btn.classList.remove('is-playing');
      },
      function(e) {
        if (VG_PREV_ACTIVE === voiceId) VG_PREV_ACTIVE = null;
        btn.textContent = '▶';
        btn.classList.remove('is-playing');
        console.warn('[vgPreview]', e);
      }
    );
  }

  async function loadVoices() {
    if (!ELEVENLABS_KEY) {
      setStatus('Set ElevenLabs API key in Settings ⚙', false);
      els.voiceSource.textContent = 'defaults (no key)';
      return;
    }
    setStatus('Loading voices...', false);
    try {
      var resp = await postJsonVG('/tts/voices', { apiKey: ELEVENLABS_KEY });
      if (!resp.ok) throw new Error(resp.error || 'load failed');
      var userVoices = resp.voices || [];

      // Rebuild VG_VOICES_DATA: user voices first, then separator, then defaults
      var defaults = VG_VOICES_DATA.filter(function(v) { return v.isDefault; });
      VG_VOICES_DATA = [];
      // Also rebuild hidden select
      var defaultSelectHtml = els.voiceSelect ? els.voiceSelect.innerHTML : '';
      if (els.voiceSelect) els.voiceSelect.innerHTML = '';

      userVoices.forEach(function(v) {
        if (v.preview_url) VG_PREVIEW_URLS[v.voice_id] = v.preview_url;
        var parts = [v.name];
        if (v.labels && v.labels.gender) parts.push(v.labels.gender);
        if (v.labels && v.labels.accent) parts.push(v.labels.accent);
        var label = parts.join(' · ');
        VG_VOICES_DATA.push({ voice_id: v.voice_id, label: label, preview_url: v.preview_url || '', isCustom: true });
        if (els.voiceSelect) {
          var opt = document.createElement('option');
          opt.value = v.voice_id; opt.textContent = '⭐ ' + label;
          els.voiceSelect.appendChild(opt);
        }
      });

      if (userVoices.length > 0) {
        VG_VOICES_DATA.push({ isSep: true });
        if (els.voiceSelect) {
          var sepOpt = document.createElement('option');
          sepOpt.disabled = true; sepOpt.textContent = '── Default voices ──';
          els.voiceSelect.appendChild(sepOpt);
        }
      }
      defaults.forEach(function(v) { VG_VOICES_DATA.push(v); });
      if (els.voiceSelect) {
        var tmp = document.createElement('div');
        tmp.innerHTML = defaultSelectHtml;
        Array.prototype.forEach.call(tmp.children, function(c) { els.voiceSelect.appendChild(c); });
      }

      renderVoiceDrop();
      voicesLoaded = true;

      if (userVoices.length === 0) {
        setStatus('✓ Key OK (TTS only) · using default voices', true);
        els.voiceSource.textContent = 'defaults';
      } else {
        setStatus('✓ ' + userVoices.length + ' custom + 25 default voices', true);
        els.voiceSource.textContent = 'custom + defaults';
      }
    } catch(e) {
      console.warn('[VoiceGen] voices fetch failed (expected for TTS-only keys):', e.message);
      setStatus('✓ Using default voices (key TTS-restricted)', true);
      els.voiceSource.textContent = 'defaults';
      voicesLoaded = true;
    }
  }

  function postJsonVG(endpoint, body) {
    return new Promise(function(resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', BRIDGE_URL + endpoint, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = 120000;
      xhr.onload = function() {
        try {
          var data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new Error(data.error || ('HTTP ' + xhr.status)));
        } catch(e) { reject(new Error('Invalid response: ' + xhr.responseText.slice(0,200))); }
      };
      xhr.onerror = function() { reject(new Error('Bridge offline')); };
      xhr.ontimeout = function() { reject(new Error('Bridge timeout (2 min)')); };
      xhr.send(JSON.stringify(body));
    });
  }

  function safeVal(el) {
    if (!el) return '';
    var v = el.value;
    return (v == null) ? '' : String(v).trim();
  }

  function getTtsSettings() {
    return {}; // eleven_v3 ignores voice_settings — always empty
  }

  // MMDDHHmmss — 10 chars, second-level uniqueness, e.g. "0528143052"
  function genTimestamp() {
    var d = new Date();
    var p = function(n) { return ('0' + n).slice(-2); };
    return p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function safeFileStr(s) {
    return (s || '').replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  }

  async function generateMultiSpeaker(numVar, userFilename, outputFmt) {
    saveCurrentSpeakerText();
    var active = VG_SPEAKERS.filter(function(sp) {
      return (VG_SPEAKER_TEXTS[sp.id] || '').trim();
    });
    if (active.length === 0) return setStatus('All speakers have empty text', false);

    els.btnGenerate.disabled = true;
    var resultCards = [];
    var ts = genTimestamp();
    var userSuffix = safeFileStr(userFilename);
    try {
      for (var i = 0; i < active.length; i++) {
        var sp = active[i];
        var spVoice = safeFileStr(sp.voiceName.split(' ')[0]) || 'voice';
        var spName = spVoice + (userSuffix ? '_' + userSuffix : '') + '_' + ts + (active.length > 1 ? '-' + (i + 1) : '');
        els.btnGenerate.textContent = '⏳ ' + sp.voiceName + ' (' + (i + 1) + '/' + active.length + ')...';
        setStatus('Generating ' + sp.voiceName + '...', false);
        var resp = await postJsonVG('/tts/generate', {
          apiKey: ELEVENLABS_KEY,
          voiceId: sp.voiceId,
          modelId: els.modelSelect.value,
          text: VG_SPEAKER_TEXTS[sp.id],
          filename: spName,
          variations: numVar,
          outputFormat: outputFmt,
          settings: getTtsSettings(),
          languageCode: getLangCode(),
          outputDir: customOutputFolder || '',
        });
        if (!resp.ok) throw new Error(sp.voiceName + ': ' + (resp.error || 'failed'));
        resultCards.push({ speaker: sp, variations: resp.variations || [] });
      }
      renderMultiResults(resultCards);
      setStatus('✓ Generated ' + active.length + ' speakers', true);
    } catch(e) {
      setStatus('✗ ' + e.message, false);
    } finally {
      els.btnGenerate.disabled = false;
      els.btnGenerate.textContent = '⚡ GENERATE VOICE';
    }
  }

  function getLangCode() {
    var toggle = $('vgLangOverride');
    if (!toggle || !toggle.checked) return undefined;
    var sel = $('vgLangSelect');
    return (sel && sel.value) ? sel.value : undefined;
  }

  async function generate() {
    if (!ELEVENLABS_KEY) {
      setStatus('Set ElevenLabs API key in Settings first', false);
      return;
    }
    var numVar = els.twoVariations.checked ? 2 : 1;
    var outputFmt = ($('vgOutputFormat') && $('vgOutputFormat').value) || 'mp3_44100_128';

    // ── Default filename = voice name as prefix (user can override) ────────
    var userFilename = safeVal(els.filename);

    var endpoint, body, label;
    if (currentMode === 'tts') {
      saveCurrentSpeakerText();
      if (VG_SPEAKERS.length > 1) {
        // Multi-speaker: each speaker uses its own voice name as filename prefix
        return await generateMultiSpeaker(numVar, userFilename || undefined, outputFmt);
      }
      var voiceId = els.voiceSelect.value || '';
      if (voiceId === '__custom__') voiceId = safeVal(els.customVoiceId);
      if (!voiceId) return setStatus('Pick a voice', false);
      var text = safeVal(els.script);
      if (!text) return setStatus('Script is empty', false);
      // Voice name is always prefix; user's text (if any) is appended as a note;
      // timestamp suffix makes every generated file unique → no overwrite on import.
      var selOpt = els.voiceSelect.options[els.voiceSelect.selectedIndex];
      var selOptText = (selOpt && (selOpt.text || selOpt.textContent || '').trim()) || '';
      var voiceLabel = safeFileStr(selOptText.split(' ')[0]) || 'voice';
      var userSuffix = safeFileStr(userFilename);
      var customName = voiceLabel + (userSuffix ? '_' + userSuffix : '') + '_' + genTimestamp();
      endpoint = '/tts/generate';
      body = {
        apiKey: ELEVENLABS_KEY, voiceId: voiceId, modelId: els.modelSelect.value,
        text: text, filename: customName, variations: numVar,
        outputFormat: outputFmt,
        languageCode: getLangCode(),
        settings: getTtsSettings(),
        outputDir: customOutputFolder || '',
      };
      label = 'voice';
    } else if (currentMode === 'sfx') {
      var sfxText = safeVal($('vgSfxText'));
      if (!sfxText) return setStatus('Sound description is empty', false);
      var userSuffix = safeFileStr(userFilename);
      var customName = 'sfx' + (userSuffix ? '_' + userSuffix : '') + '_' + genTimestamp();
      endpoint = '/sfx/generate';
      body = {
        apiKey: ELEVENLABS_KEY, text: sfxText,
        durationSec: parseFloat($('vgSfxDuration').value),
        promptInfluence: parseFloat($('vgSfxInfluence').value),
        filename: customName, variations: numVar,
        outputFormat: ($('vgSfxOutputFormat') && $('vgSfxOutputFormat').value) || 'mp3_44100_128',
        outputDir: customOutputFolder || '',
      };
      label = 'SFX';
    } else if (currentMode === 'music') {
      var prompt = safeVal($('vgMusicPrompt'));
      if (!prompt) return setStatus('Music prompt is empty', false);
      var userSuffix = safeFileStr(userFilename);
      var customName = 'music' + (userSuffix ? '_' + userSuffix : '') + '_' + genTimestamp();
      endpoint = '/music/generate';
      body = {
        apiKey: ELEVENLABS_KEY, prompt: prompt,
        lengthSec: parseFloat($('vgMusicLength').value),
        filename: customName, variations: numVar,
        outputDir: customOutputFolder || '',
      };
      label = 'music';
    }

    els.btnGenerate.disabled = true;
    els.btnGenerate.textContent = '⏳ Generating ' + numVar + ' ' + label + '...';
    setStatus('Calling ElevenLabs...', false);

    try {
      var resp = await postJsonVG(endpoint, body);
      if (!resp.ok) throw new Error(resp.error || 'generation failed');
      lastVariations = resp.variations || [];
      renderVariations();
      els.resultSection.hidden = false;
      els.importStatus.textContent = '';
      els.importStatus.className = 'ac-manualStatus';
      setStatus('✓ Generated ' + lastVariations.length + ' ' + label + ' · click play to preview', true);
    } catch(e) {
      setStatus('✗ ' + e.message, false);
    } finally {
      els.btnGenerate.disabled = false;
      els.btnGenerate.textContent = '⚡ GENERATE VOICE';
    }
  }

  // Mode switcher
  function switchMode(mode) {
    currentMode = mode;
    document.querySelectorAll('.vg-modeBtn').forEach(function(btn) {
      btn.classList.toggle('is-active', btn.dataset.mode === mode);
    });
    document.querySelectorAll('.vg-modeContent').forEach(function(c) {
      c.hidden = c.dataset.mode !== mode;
    });
    var isCreate = (mode === 'create');
    var genBar = document.querySelector('.vg-genBar');
    var vgRight = document.querySelector('.vg-right');
    if (genBar)  genBar.style.display  = isCreate ? 'none' : '';
    if (vgRight) vgRight.style.display = isCreate ? 'none' : '';
    if (els.resultSection) els.resultSection.hidden = true;
    var labels = { tts: '⚡ GENERATE VOICE', sfx: '💥 GENERATE SFX', music: '🎵 GENERATE MUSIC' };
    els.btnGenerate.textContent = labels[mode] || labels.tts;
  }

  function renderVariations() {
    // Show single-speaker container, hide+clear multi-speaker container
    var singleVars = document.getElementById('vgSingleVars');
    var multiVars  = document.getElementById('vgMultiVars');
    if (singleVars) singleVars.style.display = '';
    if (multiVars)  { multiVars.style.display = 'none'; multiVars.innerHTML = ''; }

    var v1 = lastVariations[0];
    var v2 = lastVariations[1];
    if (v1) {
      els.var1.style.display = '';
      players.var1.setSrc(v1.audioPath);
      els.var1Size.textContent = (v1.sizeBytes / 1024).toFixed(0) + ' KB · ' + v1.filename;
    } else {
      els.var1.style.display = 'none';
    }
    if (v2) {
      els.var2.style.display = '';
      players.var2.setSrc(v2.audioPath);
      els.var2Size.textContent = (v2.sizeBytes / 1024).toFixed(0) + ' KB · ' + v2.filename;
    } else {
      els.var2.style.display = 'none';
    }
  }

  function renderMultiResults(cards) {
    if (!els.resultSection) return;
    // Use dedicated multi-speaker container — never touch vgSingleVars (preserves els.var1/var2)
    var singleVars = document.getElementById('vgSingleVars');
    var multiVars  = document.getElementById('vgMultiVars');
    if (!multiVars) return;
    if (singleVars) singleVars.style.display = 'none';
    multiVars.innerHTML = '';
    multiVars.style.display = '';
    els.resultSection.hidden = false;
    cards.forEach(function(card) {
      var header = document.createElement('div');
      header.className = 'vg-multiSpeakerHeader';
      header.textContent = card.speaker.voiceName;
      header.style.borderLeftColor = card.speaker.color;
      multiVars.appendChild(header);

      card.variations.forEach(function(v, idx) {
        var wrap = document.createElement('div');
        wrap.className = 'vg-variation';
        var sizeTxt = (v.sizeBytes / 1024).toFixed(0) + ' KB · ' + v.filename;

        var cardPath = v.audioPath;
        var cardPlaying = false;

        var playB = document.createElement('button');
        playB.className = 'vg-playBtn';
        playB.textContent = '▶';

        var progWrap = document.createElement('div');
        progWrap.className = 'vg-progressWrap';
        var fill = document.createElement('div');
        fill.className = 'vg-progressFill';
        progWrap.appendChild(fill);

        var timeEl = document.createElement('span');
        timeEl.className = 'vg-time';
        timeEl.textContent = '0:00 / ?';

        var cardDuration = 0;
        var cardStartedAt = 0;
        var cardStartOffset = 0;
        var cardTicker = null;

        function fmtTime(s) {
          if (!isFinite(s) || s < 0) s = 0;
          var m = Math.floor(s / 60), sec = Math.floor(s % 60);
          return m + ':' + (sec < 10 ? '0' : '') + sec;
        }
        function stopCardTicker() {
          if (cardTicker) { clearInterval(cardTicker); cardTicker = null; }
        }
        function updateCardTick() {
          var elapsed = cardStartOffset + (Date.now() - cardStartedAt) / 1000;
          if (cardDuration > 0 && elapsed > cardDuration) elapsed = cardDuration;
          timeEl.textContent = fmtTime(elapsed) + ' / ' + fmtTime(cardDuration);
          fill.style.width = cardDuration > 0 ? (elapsed / cardDuration * 100).toFixed(1) + '%' : '0%';
        }
        function setCardPlaying(val) {
          cardPlaying = val;
          playB.textContent = val ? '⏸' : '▶';
          if (!val) stopCardTicker();
        }
        function doCardPlay(offset) {
          offset = offset || 0;
          cardStartOffset = offset;
          cardStartedAt   = Date.now();
          setCardPlaying(true);
          cardTicker = setInterval(updateCardTick, 200);
          vgPlayPath(cardPath, null,
            function() {
              setCardPlaying(false);
              fill.style.width = cardDuration > 0 ? '100%' : '0%';
              timeEl.textContent = fmtTime(cardDuration) + ' / ' + fmtTime(cardDuration);
            },
            function(e) { setCardPlaying(false); console.warn('[VG multi player]', e); },
            offset
          );
        }
        playB.addEventListener('click', function() {
          if (cardPlaying) { vgStopAll(); return; }
          doCardPlay(0);
        });

        // Fetch duration for this card
        fetch(BRIDGE_URL + '/tts/duration', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioPath: cardPath }),
        }).then(function(r) { return r.json(); }).then(function(d) {
          if (d.ok && d.duration > 0) {
            cardDuration = d.duration;
            timeEl.textContent = '0:00 / ' + fmtTime(cardDuration);
          }
        }).catch(function() {});

        progWrap.addEventListener('click', function(e) {
          if (cardDuration <= 0) return;
          var rect = progWrap.getBoundingClientRect();
          var frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          var offset = frac * cardDuration;
          if (cardPlaying) { vgStopAll(); stopCardTicker(); setCardPlaying(false); }
          setTimeout(function() { doCardPlay(offset); }, 60);
        });

        var playerRow = document.createElement('div');
        playerRow.className = 'vg-player';
        playerRow.appendChild(playB);
        playerRow.appendChild(progWrap);
        playerRow.appendChild(timeEl);

        var sizeEl = document.createElement('div');
        sizeEl.className = 'vg-varSize';
        sizeEl.textContent = (idx === 0 ? 'Var 1: ' : 'Var 2: ') + sizeTxt;

        var importB = document.createElement('button');
        importB.className = 'ac-secondaryButton vg-actionButton';
        importB.textContent = 'Import';
        importB.addEventListener('click', function() { importVariation(v); });

        // Move to Autocut — feed this generated voice into the Autocut pipeline
        var toAutocutB = document.createElement('button');
        toAutocutB.className = 'ac-secondaryButton vg-actionButton';
        toAutocutB.textContent = '→ Autocut';
        toAutocutB.addEventListener('click', function() { moveToAutocut(v); });

        var actionsRow = document.createElement('div');
        actionsRow.className = 'vg-resultActions';
        actionsRow.appendChild(importB);
        actionsRow.appendChild(toAutocutB);

        wrap.appendChild(sizeEl);
        wrap.appendChild(playerRow);
        wrap.appendChild(actionsRow);
        multiVars.appendChild(wrap);
      });
    });

    var statusEl = document.createElement('div');
    statusEl.className = 'ac-manualStatus';
    multiVars.appendChild(statusEl);
    els.importStatus = statusEl;
  }

  async function importVariation(variation) {
    if (!variation) return;
    els.importStatus.className = 'ac-manualStatus';

    // If no output folder set yet, prompt now before proceeding
    if (!customOutputFolder) {
      els.importStatus.textContent = 'Pick an output folder first…';
      await pickOutputFolder();
      if (!customOutputFolder) {
        els.importStatus.className = 'ac-manualStatus is-err';
        els.importStatus.textContent = '✗ No output folder selected — import cancelled';
        return;
      }
    }

    var finalPath = variation.audioPath;

    // File was already saved to output folder at generation time — skip move
    var alreadyInDest = customOutputFolder && variation.audioPath &&
      variation.audioPath.startsWith(customOutputFolder);

    if (!alreadyInDest) {
      els.importStatus.textContent = 'Moving to ' + customOutputFolder + '...';
      try {
        var moveResp = await postJsonVG('/tts/move', {
          sourcePath: variation.audioPath,
          targetDir:  customOutputFolder,
        });
        if (!moveResp.ok) throw new Error(moveResp.error || 'move failed');
        finalPath = moveResp.targetPath;
      } catch(e) {
        els.importStatus.className = 'ac-manualStatus is-err';
        els.importStatus.textContent = '✗ Move failed: ' + e.message;
        return;
      }
    }

    els.importStatus.textContent = 'Importing ' + variation.filename + ' to Premiere...';
    try {
      if (!ppro || !ppro.Project) throw new Error('Premiere API unavailable');
      var project = await getActiveProject();
      if (typeof project.importFiles === 'function') {
        await project.importFiles([finalPath]);
      } else if (typeof project.importFile === 'function') {
        await project.importFile(finalPath);
      } else {
        throw new Error('No importFiles API on project');
      }
      els.importStatus.className = 'ac-manualStatus is-ok';
      els.importStatus.textContent = '✓ Saved to ' + customOutputFolder +
        ', imported "' + variation.filename + '" → see Project Panel';
    } catch(e) {
      els.importStatus.className = 'ac-manualStatus is-err';
      els.importStatus.textContent = '✗ Import: ' + e.message;
    }
  }

  async function revealVariation(variation) {
    if (!variation || !variation.audioPath) return;
    try {
      var resp = await postJsonVG('/tts/reveal', { filePath: variation.audioPath });
      if (!resp.ok) throw new Error(resp.error || 'reveal failed');
    } catch(e) {
      alert('File: ' + variation.audioPath + '\n' + e.message);
    }
  }

  async function pickOutputFolder() {
    try {
      var uxp = window.require && window.require('uxp');
      if (!uxp || !uxp.storage) {
        alert('UXP storage API not available');
        return;
      }
      var lfs = uxp.storage.localFileSystem;
      var folder = await lfs.getFolder();
      if (!folder) return; // cancelled
      customOutputFolder = folder.nativePath || folder.path || '';
      els.outputFolder.value = customOutputFolder;
      console.log('[VoiceGen] output folder picked:', customOutputFolder);
    } catch(e) {
      alert('Cannot pick folder: ' + e.message);
    }
  }

  function resetOutputFolder() {
    customOutputFolder = '';
    els.outputFolder.value = '';
  }

  // Wire events
  els.btnRefresh.addEventListener('click', loadVoices);

  // ⚙ settings toggle — show/hide the API profiles + output format panel
  var vgSettingsBtn = $('vgSettingsBtn'), vgSettingsPanel = $('vgSettingsPanel');
  if (vgSettingsBtn && vgSettingsPanel) {
    vgSettingsBtn.addEventListener('click', function() {
      vgSettingsPanel.hidden = !vgSettingsPanel.hidden;
      vgSettingsBtn.classList.toggle('is-active', !vgSettingsPanel.hidden);
    });
  }
  els.voiceSelect.addEventListener('change', function() {
    els.customVoiceId.hidden = els.voiceSelect.value !== '__custom__';
    if (!els.customVoiceId.hidden) els.customVoiceId.focus();
    // Keep active speaker's voice in sync
    saveCurrentSpeakerText();
    renderSpeakerBar();
  });
  els.btnGenerate.addEventListener('click', generate);
  if (els.btnBrowseFolder) els.btnBrowseFolder.addEventListener('click', pickOutputFolder);
  if (els.btnResetFolder) els.btnResetFolder.addEventListener('click', resetOutputFolder);

  // Variation buttons
  if (els.var1Import) els.var1Import.addEventListener('click', function() { importVariation(lastVariations[0]); });
  if (els.var2Import) els.var2Import.addEventListener('click', function() { importVariation(lastVariations[1]); });

  // Move to Autocut — save to output folder (if set) then feed to Autocut pipeline
  async function moveToAutocut(v) {
    if (!v || !v.audioPath) return;
    var finalPath = v.audioPath;

    // Save to output folder first (same flow as Import button)
    if (customOutputFolder) {
      var alreadyInDest = v.audioPath.startsWith(customOutputFolder);
      if (!alreadyInDest) {
        try {
          var moveResp = await postJsonVG('/tts/move', {
            sourcePath: v.audioPath,
            targetDir:  customOutputFolder,
          });
          if (moveResp.ok) finalPath = moveResp.targetPath;
        } catch(e) { console.warn('[VG→AC] Move failed:', e.message); }
      }
    }

    if (typeof window.AutocutPushVoice === 'function') window.AutocutPushVoice(finalPath);
  }
  var vgV1ToAC = $('vgVar1ToAutocut'), vgV2ToAC = $('vgVar2ToAutocut');
  if (vgV1ToAC) vgV1ToAC.addEventListener('click', function() { moveToAutocut(lastVariations[0]); });
  if (vgV2ToAC) vgV2ToAC.addEventListener('click', function() { moveToAutocut(lastVariations[1]); });

  if (els.script) {
    els.script.addEventListener('input', updateCharCount);
    els.script.addEventListener('input', function() { vgAutoResize(els.script); });
    // 'paste' may not fire 'input' in UXP — delay so value is updated before measuring
    els.script.addEventListener('paste', function() { setTimeout(function() { vgAutoResize(els.script); updateCharCount(); }, 0); });
  }

  // Language Override toggle
  var langToggle = $('vgLangOverride');
  if (langToggle) langToggle.addEventListener('change', function() {
    var sel = $('vgLangSelect');
    if (sel) sel.hidden = !langToggle.checked;
  });

  // Add Speaker button
  var addSpeakerBtn = $('vgAddSpeaker');
  if (addSpeakerBtn) addSpeakerBtn.addEventListener('click', addSpeaker);

  // Expose voice list so Claude chat can inject it into prompts
  window.VoiceGenGetVoices = function() {
    return VG_VOICES_DATA.slice(); // return a copy
  };

  // ── Voice Create (Clone + Design) ────────────────────────────────────────
  (function() {
    var vcType           = document.getElementById('vcType');
    var vcCloneSection   = document.getElementById('vcCloneSection');
    var vcDesignSection  = document.getElementById('vcDesignSection');
    var vcCloneName      = document.getElementById('vcCloneName');
    var vcCloneDesc      = document.getElementById('vcCloneDesc');
    var vcDenoise        = document.getElementById('vcDenoise');
    var vcCloneSubmit    = document.getElementById('vcCloneSubmit');
    var vcCloneStatus    = document.getElementById('vcCloneStatus');
    var vcFromSeqSection = document.getElementById('vcFromSequenceSection');
    var vcFromFileSection= document.getElementById('vcFromFileSection');
    var vcClipInfo       = document.getElementById('vcClipInfo');
    var vcFileInfo       = document.getElementById('vcFileInfo');
    var vcGetClip        = document.getElementById('vcGetClip');
    var vcBrowseFile     = document.getElementById('vcBrowseFile');

    var vcGender         = document.getElementById('vcGender');
    var vcAge            = document.getElementById('vcAge');
    var vcAccent         = document.getElementById('vcAccent');
    var vcAccentStrength = document.getElementById('vcAccentStrength');
    var vcAccentVal      = document.getElementById('vcAccentVal');
    var vcPreviewText    = document.getElementById('vcPreviewText');
    var vcDesignPreview  = document.getElementById('vcDesignPreview');
    var vcPreviewPlayer  = document.getElementById('vcPreviewPlayer');
    var vcPreviewPlay    = document.getElementById('vcPreviewPlay');
    var vcPreviewProgWrap= document.getElementById('vcPreviewProgWrap');
    var vcPreviewFill    = document.getElementById('vcPreviewFill');
    var vcPreviewTime    = document.getElementById('vcPreviewTime');
    var vcDesignSaveSec  = document.getElementById('vcDesignSaveSection');
    var vcDesignName     = document.getElementById('vcDesignName');
    var vcDesignDesc     = document.getElementById('vcDesignDesc');
    var vcDesignSave     = document.getElementById('vcDesignSave');
    var vcDesignStatus   = document.getElementById('vcDesignStatus');

    var vcSelectedFilePath = ''; // for clone: current audio file path
    var vcGenerationId     = ''; // for design: generationId from preview
    var vcPreviewAudioUrl  = ''; // for design preview player
    var vcPreviewIsPlaying = false;
    var vcPreviewDuration  = 0;
    var vcPreviewPosition  = 0;
    var vcPreviewTimer     = null;

    // ── Method selector toggle ──
    if (vcType) {
      vcType.addEventListener('change', function() {
        var m = vcType.value;
        if (vcCloneSection)  vcCloneSection.hidden  = (m !== 'clone');
        if (vcDesignSection) vcDesignSection.hidden = (m !== 'design');
      });
    }

    // ── Audio source radio toggle ──
    document.querySelectorAll('input[name="vcSource"]').forEach(function(radio) {
      radio.addEventListener('change', function() {
        var fromSeq = (radio.value === 'sequence' && radio.checked);
        if (vcFromSeqSection)  vcFromSeqSection.hidden  = !fromSeq;
        if (vcFromFileSection) vcFromFileSection.hidden = fromSeq;
        vcSelectedFilePath = '';
        if (vcClipInfo) vcClipInfo.textContent = 'No clip selected — select a clip in the timeline first';
        if (vcFileInfo) vcFileInfo.textContent = 'No file selected';
      });
    });

    // ── Get from Sequence ──
    // Reads all clips from audio track A1, extracts each segment via ffmpeg,
    // concatenates them into a single MP3, and sets vcSelectedFilePath to result.
    if (vcGetClip) {
      vcGetClip.addEventListener('click', async function() {
        if (vcClipInfo) vcClipInfo.textContent = 'Reading A1 clips…';
        vcGetClip.disabled = true;
        vcSelectedFilePath = '';
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

          if (vcClipInfo) vcClipInfo.textContent = 'Found ' + items.length + ' clip(s), reading paths…';

          var clipList = [];
          for (var i = 0; i < items.length; i++) {
            var ti = items[i];

            // Source in/out points (position in source media file)
            var inSec = 0, outSec = 0;
            try {
              var ip = ti.getInPoint && ti.getInPoint();
              if (ip && typeof ip.then === 'function') ip = await ip;
              if (ip) inSec = getTimeSec(ip);
            } catch(e) {}
            try {
              var op = ti.getOutPoint && ti.getOutPoint();
              if (op && typeof op.then === 'function') op = await op;
              if (op) outSec = getTimeSec(op);
            } catch(e) {}

            // Fallback when in/out unavailable: use clip duration from timeline
            // (only correct if clip's head is not trimmed, inPoint=0)
            if (!outSec || outSec <= inSec) {
              try {
                var gs = ti.getStart && ti.getStart();
                if (gs && typeof gs.then === 'function') gs = await gs;
                var ge = ti.getEnd && ti.getEnd();
                if (ge && typeof ge.then === 'function') ge = await ge;
                inSec = 0; outSec = getTimeSec(ge) - getTimeSec(gs);
              } catch(e) {}
            }

            var fp = await vcGetTrackItemFilePath(ti);
            if (!fp) throw new Error('Clip ' + (i + 1) + ': cannot get source file path — try "From File" instead');

            clipList.push({ filePath: fp, inPoint: inSec, outPoint: outSec });
          }

          if (vcClipInfo) vcClipInfo.textContent = 'Concatenating ' + clipList.length + ' clip(s) via ffmpeg…';

          var resp = await postJsonVG('/tts/concat-from-sequence', {
            clips:     clipList,
            outputDir: customOutputFolder || '',
          });
          if (!resp.ok) throw new Error(resp.error || 'Concat failed');

          vcSelectedFilePath = resp.audioPath;
          var shortName = resp.audioPath.split('/').pop();
          var nClips = clipList.length;
          if (vcClipInfo) {
            vcClipInfo.textContent = '✓ ' + shortName + ' (' + nClips + ' clip' + (nClips > 1 ? 's' : '') + ')';
            vcClipInfo.title = resp.audioPath;
          }
          console.log('[vcGetClip] concat result:', resp.audioPath);
        } catch(e) {
          vcSelectedFilePath = '';
          if (vcClipInfo) vcClipInfo.textContent = '✗ ' + e.message;
          console.error('[vcGetClip]', e);
        } finally {
          vcGetClip.disabled = false;
        }
      });
    }

    // ── Browse File ──
    if (vcBrowseFile) {
      vcBrowseFile.addEventListener('click', async function() {
        try {
          var uxp = window.require && window.require('uxp');
          if (!uxp || !uxp.storage) throw new Error('UXP storage not available');
          var file = await uxp.storage.localFileSystem.getFileForOpening({
            types: ['mp3','wav','m4a','aac','ogg','flac'],
          });
          if (!file) return; // cancelled
          var fp = file.nativePath || file.path || '';
          vcSelectedFilePath = fp;
          var shortName = fp.split('/').pop();
          if (vcFileInfo) vcFileInfo.textContent = shortName + '\n' + fp;
        } catch(e) {
          if (vcFileInfo) vcFileInfo.textContent = '✗ ' + e.message;
        }
      });
    }

    // ── Clone submit ──
    if (vcCloneSubmit) {
      vcCloneSubmit.addEventListener('click', async function() {
        var name = vcCloneName ? vcCloneName.value.trim() : '';
        if (!name)               return showVcStatus(vcCloneStatus, 'Voice name is required', false);
        if (!vcSelectedFilePath) return showVcStatus(vcCloneStatus, 'Select an audio file first', false);
        if (!ELEVENLABS_KEY)     return showVcStatus(vcCloneStatus, 'No ElevenLabs API key set', false);

        vcCloneSubmit.disabled = true;
        vcCloneSubmit.textContent = '⏳ Cloning…';
        showVcStatus(vcCloneStatus, 'Uploading audio to ElevenLabs…', null);
        try {
          var resp = await postJsonVG('/voice/clone', {
            apiKey:      ELEVENLABS_KEY,
            voiceName:   name,
            filePath:    vcSelectedFilePath,
            description: vcCloneDesc ? vcCloneDesc.value.trim() : '',
            removeNoise: vcDenoise  ? vcDenoise.checked : false,
          });
          if (!resp.ok) throw new Error(resp.error || 'clone failed');
          showVcStatus(vcCloneStatus, '✓ Voice cloned! ID: ' + resp.voice_id + '\nReloading voice list…', true);
          // Reload voice list so new voice appears in dropdown
          setTimeout(function() { loadVoices(); }, 1500);
        } catch(e) {
          showVcStatus(vcCloneStatus, '✗ ' + e.message, false);
        } finally {
          vcCloneSubmit.disabled = false;
          vcCloneSubmit.textContent = '🎙 CLONE VOICE';
        }
      });
    }

    // ── Accent strength slider ──
    if (vcAccentStrength && vcAccentVal) {
      vcAccentStrength.addEventListener('input', function() {
        vcAccentVal.textContent = Number(vcAccentStrength.value).toFixed(1);
      });
    }

    // ── Design preview ──
    if (vcDesignPreview) {
      vcDesignPreview.addEventListener('click', async function() {
        var text = vcPreviewText ? vcPreviewText.value.trim() : '';
        if (!text)           return showVcStatus(vcDesignStatus, 'Enter preview text first', false);
        if (!ELEVENLABS_KEY) return showVcStatus(vcDesignStatus, 'No ElevenLabs API key set', false);

        vcDesignPreview.disabled = true;
        vcDesignPreview.textContent = '⏳ Generating…';
        showVcStatus(vcDesignStatus, 'Generating voice preview…', null);
        if (vcPreviewPlayer) vcPreviewPlayer.hidden = true;
        if (vcDesignSaveSec) vcDesignSaveSec.hidden = true;
        vcGenerationId = '';

        try {
          var resp = await postJsonVG('/voice/design/preview', {
            apiKey:          ELEVENLABS_KEY,
            gender:          vcGender          ? vcGender.value          : 'female',
            age:             vcAge             ? vcAge.value             : 'young',
            accent:          vcAccent          ? vcAccent.value          : 'american',
            accentStrength:  vcAccentStrength  ? Number(vcAccentStrength.value) : 1.0,
            text:            text,
          });
          if (!resp.ok) throw new Error(resp.error || 'preview failed');
          vcGenerationId    = resp.generationId || '';
          vcPreviewAudioUrl = BRIDGE_URL + resp.previewUrl;
          showVcStatus(vcDesignStatus, '✓ Preview ready. Listen then save if you like it.', true);

          // Show player
          vcPreviewDuration = 0; vcPreviewPosition = 0;
          if (vcPreviewPlayer) vcPreviewPlayer.hidden = false;
          if (vcPreviewFill)   vcPreviewFill.style.width = '0%';
          if (vcPreviewTime)   vcPreviewTime.textContent = '0:00 / 0:00';
          if (vcPreviewPlay)   vcPreviewPlay.textContent = '▶';
          vcPreviewIsPlaying = false;

          // Show save section
          if (vcDesignSaveSec) vcDesignSaveSec.hidden = false;
        } catch(e) {
          showVcStatus(vcDesignStatus, '✗ ' + e.message, false);
        } finally {
          vcDesignPreview.disabled = false;
          vcDesignPreview.textContent = '▶ PREVIEW VOICE';
        }
      });
    }

    // ── Design preview player ──
    if (vcPreviewPlay) {
      vcPreviewPlay.addEventListener('click', function() {
        if (!vcPreviewAudioUrl) return;
        if (vcPreviewIsPlaying) {
          // Stop
          stopVcPreview();
        } else {
          startVcPreview();
        }
      });
    }

    function fmtTime(sec) {
      if (!isFinite(sec)) return '0:00';
      var m = Math.floor(sec / 60);
      var s = Math.floor(sec % 60);
      return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function stopVcPreview() {
      if (vcPreviewTimer) { clearInterval(vcPreviewTimer); vcPreviewTimer = null; }
      // Ask bridge to stop afplay
      postJsonVG('/tts/stop', {}).catch(function(){});
      vcPreviewIsPlaying = false;
      if (vcPreviewPlay) vcPreviewPlay.textContent = '▶';
    }

    function startVcPreview() {
      stopVcPreview();
      vcPreviewIsPlaying = true;
      if (vcPreviewPlay) vcPreviewPlay.textContent = '⏹';
      vcPreviewPosition = 0;
      var startTime = Date.now();
      // Kick off play on bridge
      postJsonVG('/tts/play', { audioUrl: vcPreviewAudioUrl.replace(BRIDGE_URL, '') })
        .then(function() {
          stopVcPreview();
        })
        .catch(function() {
          stopVcPreview();
        });
      // Tick progress
      vcPreviewTimer = setInterval(function() {
        if (!vcPreviewIsPlaying) { clearInterval(vcPreviewTimer); vcPreviewTimer = null; return; }
        vcPreviewPosition = (Date.now() - startTime) / 1000;
        if (vcPreviewDuration > 0) {
          var pct = Math.min((vcPreviewPosition / vcPreviewDuration) * 100, 100);
          if (vcPreviewFill) vcPreviewFill.style.width = pct + '%';
        }
        if (vcPreviewTime) vcPreviewTime.textContent = fmtTime(vcPreviewPosition) + ' / ' + fmtTime(vcPreviewDuration || 0);
      }, 250);
    }

    // ── Design save ──
    if (vcDesignSave) {
      vcDesignSave.addEventListener('click', async function() {
        var name = vcDesignName ? vcDesignName.value.trim() : '';
        if (!name)           return showVcStatus(vcDesignStatus, 'Enter a voice name to save', false);
        if (!vcGenerationId) return showVcStatus(vcDesignStatus, 'Generate a preview first', false);
        if (!ELEVENLABS_KEY) return showVcStatus(vcDesignStatus, 'No ElevenLabs API key set', false);

        vcDesignSave.disabled = true;
        vcDesignSave.textContent = '⏳ Saving…';
        showVcStatus(vcDesignStatus, 'Saving voice to your library…', null);
        try {
          var resp = await postJsonVG('/voice/design/save', {
            apiKey:           ELEVENLABS_KEY,
            voiceName:        name,
            description:      vcDesignDesc ? vcDesignDesc.value.trim() : '',
            generatedVoiceId: vcGenerationId,
          });
          if (!resp.ok) throw new Error(resp.error || 'save failed');
          showVcStatus(vcDesignStatus, '✓ Voice saved! Reloading voice list…', true);
          vcGenerationId = '';
          if (vcDesignSaveSec) vcDesignSaveSec.hidden = true;
          setTimeout(function() { loadVoices(); }, 1500);
        } catch(e) {
          showVcStatus(vcDesignStatus, '✗ ' + e.message, false);
        } finally {
          vcDesignSave.disabled = false;
          vcDesignSave.textContent = '✓ SAVE VOICE';
        }
      });
    }

    function showVcStatus(el, msg, isOk) {
      if (!el) return;
      el.hidden = false;
      el.className = 'vc-status' + (isOk === true ? ' is-ok' : isOk === false ? ' is-error' : '');
      el.textContent = msg;
    }
  })();

  // ── ElevenLabs API Key Profiles ──────────────────────────────────────────
  var vgProfileSelect    = $('vgProfileSelect');
  var vgProfileName      = $('vgProfileName');
  var vgElKeyInput       = $('vgElKeyInput');
  var vgElStatus         = $('vgElStatus');
  var vgSaveKeyBtn       = $('vgSaveKey');
  var vgAddProfileBtn    = $('vgAddProfile');
  var vgDeleteProfileBtn = $('vgDeleteProfile');

  function vgPersistProfiles() {
    var stored = {};
    try { stored = JSON.parse(localStorage.getItem('claude-plugin-settings') || '{}'); } catch(e) {}
    stored.elevenlabsProfiles        = EL_PROFILES;
    stored.elevenlabsActiveProfileId = EL_ACTIVE_PROFILE_ID;
    stored.elevenlabsKey             = ELEVENLABS_KEY;
    localStorage.setItem('claude-plugin-settings', JSON.stringify(stored));
    persistSettingsToFile(stored);
  }

  function updateVgElStatus() {
    if (!vgElStatus) return;
    if (ELEVENLABS_KEY && ELEVENLABS_KEY.length > 8) {
      var k = ELEVENLABS_KEY;
      vgElStatus.textContent = k.slice(0, 5) + '…' + k.slice(-4);
      vgElStatus.classList.add('is-api');
    } else {
      vgElStatus.textContent = 'not set';
      vgElStatus.classList.remove('is-api');
    }
  }

  function vgLoadProfileFields() {
    var active = EL_PROFILES.find(function(p) { return p.id === EL_ACTIVE_PROFILE_ID; });
    if (vgProfileName) vgProfileName.value = active ? active.name : '';
    if (vgElKeyInput)  vgElKeyInput.value  = active ? active.key  : '';
    updateVgElStatus();
  }

  function vgRenderProfiles() {
    if (!vgProfileSelect) return;
    vgProfileSelect.innerHTML = '';
    if (!EL_PROFILES.length) {
      var emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '— no profiles —';
      vgProfileSelect.appendChild(emptyOpt);
    } else {
      EL_PROFILES.forEach(function(p) {
        var opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name + (p.key ? '' : ' (no key)');
        if (p.id === EL_ACTIVE_PROFILE_ID) opt.selected = true;
        vgProfileSelect.appendChild(opt);
      });
    }
    vgLoadProfileFields();
  }

  // Switch active profile when dropdown changes
  if (vgProfileSelect) {
    vgProfileSelect.addEventListener('change', function() {
      var selId = vgProfileSelect.value;
      if (!selId) return;
      EL_ACTIVE_PROFILE_ID = selId;
      var p = EL_PROFILES.find(function(p) { return p.id === selId; });
      if (p) {
        ELEVENLABS_KEY = p.key;
        voicesLoaded = false;
        vgPersistProfiles();
        vgLoadProfileFields();
        if (ELEVENLABS_KEY) loadVoices();
        else setStatus('Add an API key to this profile', false);
      }
    });
  }

  // Add new blank profile
  if (vgAddProfileBtn) {
    vgAddProfileBtn.addEventListener('click', function() {
      var newId = 'p_' + Date.now();
      EL_PROFILES.push({ id: newId, name: 'New Profile', key: '' });
      EL_ACTIVE_PROFILE_ID = newId;
      vgRenderProfiles();
      if (vgProfileName) {
        try { vgProfileName.focus(); vgProfileName.select(); } catch(e) {}
      }
    });
  }

  // Save (create or update) active profile
  if (vgSaveKeyBtn) {
    vgSaveKeyBtn.addEventListener('click', function() {
      var name = (vgProfileName ? (vgProfileName.value || '') : '').trim() || 'Profile';
      var key  = (vgElKeyInput  ? (vgElKeyInput.value  || '') : '').trim();
      if (!EL_ACTIVE_PROFILE_ID || !EL_PROFILES.find(function(p) { return p.id === EL_ACTIVE_PROFILE_ID; })) {
        var newId = 'p_' + Date.now();
        EL_PROFILES.push({ id: newId, name: name, key: key });
        EL_ACTIVE_PROFILE_ID = newId;
      } else {
        var idx = EL_PROFILES.findIndex(function(p) { return p.id === EL_ACTIVE_PROFILE_ID; });
        if (idx >= 0) { EL_PROFILES[idx].name = name; EL_PROFILES[idx].key = key; }
      }
      ELEVENLABS_KEY = key;
      vgPersistProfiles();
      vgRenderProfiles();
      if (key) {
        voicesLoaded = false;
        loadVoices();
      } else {
        setStatus('ElevenLabs API key required', false);
      }
    });
  }

  // Delete active profile
  if (vgDeleteProfileBtn) {
    vgDeleteProfileBtn.addEventListener('click', function() {
      if (!EL_ACTIVE_PROFILE_ID) return;
      EL_PROFILES = EL_PROFILES.filter(function(p) { return p.id !== EL_ACTIVE_PROFILE_ID; });
      EL_ACTIVE_PROFILE_ID = EL_PROFILES.length ? EL_PROFILES[0].id : null;
      ELEVENLABS_KEY = '';
      if (EL_ACTIVE_PROFILE_ID) {
        var ap = EL_PROFILES.find(function(p) { return p.id === EL_ACTIVE_PROFILE_ID; });
        if (ap) ELEVENLABS_KEY = ap.key;
      }
      vgPersistProfiles();
      vgRenderProfiles();
      voicesLoaded = false;
      if (ELEVENLABS_KEY) loadVoices();
      else setStatus('Set ElevenLabs API key in a profile', false);
    });
  }

  vgRenderProfiles();

  // Auto-refresh when key changes (called from Settings save handler)
  window.VoiceGenOnKeyChange = function() {
    console.log('[VoiceGen] key changed, ELEVENLABS_KEY len=' + (ELEVENLABS_KEY || '').length);
    voicesLoaded = false;
    vgRenderProfiles();
    if (ELEVENLABS_KEY) loadVoices();
    else setStatus('Set ElevenLabs API key above ↑', false);
  };

  // ── Cross-tab: Claude chat can push script/SFX to Voice Gen ───────────────
  window.VoiceGenPushScript = function(text, voiceId, autoGenerate) {
    // Switch to Voice Gen tab
    var vgBtn = document.querySelector('.tab-btn[data-tab="voicegen"]');
    if (vgBtn) vgBtn.click();
    // Switch to TTS mode
    switchMode('tts');
    // Set script text
    if (els.script) {
      els.script.value = text || '';
      updateCharCount();
      vgAutoResize(els.script);
    }
    // Set voice if provided
    if (voiceId) {
      vgSetVoice(voiceId);
      // sync active speaker
      var sp = VG_SPEAKERS.find(function(s) { return s.id === VG_ACTIVE_SPEAKER; });
      if (sp) sp.voiceId = voiceId;
      renderSpeakerBar();
    }
    // Auto-generate or focus generate button
    if (autoGenerate) {
      setTimeout(function() { generate(); }, 200);
    } else {
      setTimeout(function() {
        if (els.btnGenerate) { try { els.btnGenerate.focus(); } catch(e) {} }
      }, 100);
    }
  };

  window.VoiceGenPushSFX = function(text, autoGenerate) {
    // Switch to Voice Gen tab
    var vgBtn = document.querySelector('.tab-btn[data-tab="voicegen"]');
    if (vgBtn) vgBtn.click();
    // Switch to SFX mode
    switchMode('sfx');
    // Set SFX text
    var sfxEl = $('vgSfxText');
    if (sfxEl) {
      sfxEl.value = text || '';
      var cnt = $('vgSfxCharCount');
      if (cnt) cnt.textContent = (text || '').length + ' / 500';
    }
    if (autoGenerate) {
      setTimeout(function() { generate(); }, 200);
    } else {
      setTimeout(function() {
        if (els.btnGenerate) { try { els.btnGenerate.focus(); } catch(e) {} }
      }, 100);
    }
  };

  // Wire mode buttons
  document.querySelectorAll('.vg-modeBtn').forEach(function(btn) {
    btn.addEventListener('click', function() { switchMode(btn.dataset.mode); });
  });

  // Hook a number input — set initial value, clamp to min/max, sync label,
  // and inject custom ±  buttons (UXP Chromium doesn't render native spinners).
  function hookSlider(inputId, labelId, defaultVal, formatter) {
    var s = $(inputId), v = $(labelId);
    if (!s) return;

    // Read constraints from element attributes
    var minV = (s.min !== '' && s.min != null) ? parseFloat(s.min) : -Infinity;
    var maxV = (s.max !== '' && s.max != null) ? parseFloat(s.max) : Infinity;
    var stepV = (s.step && s.step !== '' && s.step !== 'any') ? parseFloat(s.step) : 1;
    var precision = (String(stepV).split('.')[1] || '').length; // decimal places of step

    function clamp(n) {
      if (isNaN(n)) return defaultVal;
      if (minV !== -Infinity) n = Math.max(minV, n);
      if (maxV !== Infinity)  n = Math.min(maxV, n);
      return parseFloat(n.toFixed(precision));
    }

    s.value = String(defaultVal);

    function update() {
      var n = clamp(parseFloat(s.value));
      s.value = String(n);
      if (v) v.textContent = formatter(n);
    }

    s.addEventListener('input',  update);
    s.addEventListener('change', update);
    s.addEventListener('blur',   update);

    // Mouse-wheel: scroll while focused — clamp to bounds
    s.addEventListener('wheel', function(e) {
      e.preventDefault();
      var n = clamp(parseFloat(s.value) || defaultVal);
      n = clamp(e.deltaY < 0 ? n + stepV : n - stepV);
      s.value = String(n);
      if (v) v.textContent = formatter(n);
    });

    // Custom ± buttons — UXP Chromium omits native input[type=number] spinners
    var numRow = s.parentElement;
    if (numRow && numRow.classList.contains('vg-numRow')) {
      var btnMinus = document.createElement('button');
      btnMinus.type = 'button';
      btnMinus.className = 'vg-stepBtn';
      btnMinus.textContent = '−';
      btnMinus.addEventListener('click', function() {
        s.value = String(clamp((parseFloat(s.value) || defaultVal) - stepV));
        update();
      });

      var btnPlus = document.createElement('button');
      btnPlus.type = 'button';
      btnPlus.className = 'vg-stepBtn';
      btnPlus.textContent = '+';
      btnPlus.addEventListener('click', function() {
        s.value = String(clamp((parseFloat(s.value) || defaultVal) + stepV));
        update();
      });

      numRow.insertBefore(btnMinus, s);
      var nextSib = s.nextSibling; // vg-nu label or null
      if (nextSib) numRow.insertBefore(btnPlus, nextSib);
      else         numRow.appendChild(btnPlus);
    }

    update();
  }

  // SFX sliders
  hookSlider('vgSfxDuration',  'vgSfxDurationValue',  3,   function(n){ return n.toFixed(1) + 's'; });
  hookSlider('vgSfxInfluence', 'vgSfxInfluenceValue', 0.3, function(n){ return n.toFixed(2); });
  // Music slider
  hookSlider('vgMusicLength',  'vgMusicLengthValue',  10,  function(n){ return Math.round(n) + 's'; });

  // SFX char count + auto-resize
  var sfxText = $('vgSfxText');
  if (sfxText) {
    sfxText.addEventListener('input', function() {
      $('vgSfxCharCount').textContent = safeLen(sfxText) + ' / 500';
      vgAutoResize(sfxText);
    });
    sfxText.addEventListener('paste', function() { setTimeout(function() { vgAutoResize(sfxText); }, 0); });
  }

  // Music char count + auto-resize
  var musicPrompt = $('vgMusicPrompt');
  if (musicPrompt) {
    musicPrompt.addEventListener('input', function() {
      $('vgMusicCharCount').textContent = safeLen(musicPrompt) + ' / 1000';
      vgAutoResize(musicPrompt);
    });
    musicPrompt.addEventListener('paste', function() { setTimeout(function() { vgAutoResize(musicPrompt); }, 0); });
  }

  // Wire setKeyboardFocus for all VoiceGen text inputs (prevent Premiere shortcut conflicts)
  [$('vgScript'), sfxText, musicPrompt, $('vgProfileName'), $('vgElKeyInput'), $('vgCustomVoiceId'),
   $('vgFilename'), $('vgOutputFolder')].forEach(function(el) {
    if (!el) return;
    el.addEventListener('focus', window.claimKeyboard);
    el.addEventListener('blur',  window.releaseKeyboard);
  });

  // ── Voice dropdown init ──────────────────────────────────────────────────
  // Seed VG_VOICES_DATA from the static default <option> elements
  (function() {
    var opts = els.voiceSelect ? els.voiceSelect.options : [];
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      if (!o.value || o.disabled) continue;
      VG_VOICES_DATA.push({ voice_id: o.value, label: o.textContent, preview_url: '', isDefault: true });
    }
  })();

  // Portal the dropdown panel to #tab-voicegen (position:relative) so it escapes
  // .vg-right's overflow:auto without needing position:fixed (unsupported in UXP).
  // DOM order: appended last → paints on top of siblings per UXP paint rules.
  var vgDropPanel = $('vgVoiceDropPanel');
  var vgTabPanel  = document.getElementById('tab-voicegen');
  if (vgDropPanel) (vgTabPanel || document.body).appendChild(vgDropPanel);

  // Wire dropdown trigger
  var dropTrigger = $('vgVoiceDropTrigger');
  if (dropTrigger) dropTrigger.addEventListener('click', function() {
    var panel = $('vgVoiceDropPanel');
    if (panel && panel.style.display === 'flex') closeVoiceDrop(); else openVoiceDrop();
  });

  // Close on outside click — must check BOTH the trigger container AND the portaled panel
  document.addEventListener('click', function(e) {
    var drop  = $('vgVoiceDrop');
    var panel = $('vgVoiceDropPanel');
    var inDrop  = drop  && drop.contains(e.target);
    var inPanel = panel && panel.contains(e.target);
    if (!inDrop && !inPanel) closeVoiceDrop();
  });

  // Init — each step in its own try so one failure doesn't stop the rest
  console.log('[VoiceGen] init v4.1.34, ELEVENLABS_KEY present:', !!ELEVENLABS_KEY,
              '| length:', (ELEVENLABS_KEY || '').length);
  try { updateCharCount(); }        catch(e) { console.warn('[VG] updateCharCount:', e.message); }
  try { players.var1 = createPlayer('var1'); } catch(e) { console.error('[VG] createPlayer var1:', e.message); }
  try { players.var2 = createPlayer('var2'); } catch(e) { console.error('[VG] createPlayer var2:', e.message); }
  try { renderSpeakerBar(); } catch(e) { console.warn('[VG] renderSpeakerBar:', e.message); }
  try { renderVoiceDrop(); }  catch(e) { console.warn('[VG] renderVoiceDrop:', e.message); }
  if (ELEVENLABS_KEY) {
    try { loadVoices(); } catch(e) { console.warn('[VG] loadVoices:', e.message); }
  } else {
    setStatus('Set ElevenLabs API key in Settings ⚙', false);
  }

  // Poll for project change every 5 s — reset output folder when user switches projects
  // so stale folder paths from the previous project don't carry over.
  var _vgProjectId = null;
  setInterval(async function() {
    try {
      if (!ppro || !ppro.Project) return;
      var proj = await getActiveProject();
      var pid = (typeof proj.path === 'string' && proj.path) || proj.name || '';
      if (_vgProjectId !== null && pid && pid !== _vgProjectId) {
        resetOutputFolder();
        console.log('[VoiceGen] project changed → output folder reset');
      }
      if (pid) _vgProjectId = pid;
    } catch(e) {}
  }, 5000);
})();
