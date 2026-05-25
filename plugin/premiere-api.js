// UNUSED — this file uses ES module `export` and is NOT loaded by index.html.
// All active Premiere API code lives inline in main.js (non-module script).
// Kept for reference only.

const ppro = (() => {
  try { return require('premierepro'); } catch { return null; }
})();

// ── Helpers ────────────────────────────────────────────────────────────────

function ticksToSeconds(ticks) {
  // Premiere stores time as ticks; 1 second = 254016000000 ticks
  return ticks / 254016000000;
}

function secondsToTicks(seconds) {
  return Math.round(seconds * 254016000000);
}

function getApp() {
  if (!ppro) throw new Error('premierepro module not available');
  return ppro.app;
}

function getSequence() {
  const app = getApp();
  const seq = app.project?.activeSequence;
  if (!seq) throw new Error('No active sequence');
  return seq;
}

// ── Read ───────────────────────────────────────────────────────────────────

export async function getTimelineInfo() {
  try {
    const seq = getSequence();
    const clips = [];

    const videoTracks = seq.videoTracks ?? [];
    for (let ti = 0; ti < videoTracks.length; ti++) {
      const track = videoTracks[ti];
      const trackClips = track.clips ?? [];
      for (let ci = 0; ci < trackClips.length; ci++) {
        const clip = trackClips[ci];
        clips.push({
          trackIndex: ti,
          trackType: 'video',
          clipIndex: ci,
          name: clip.name ?? `Clip ${ci}`,
          startSec: ticksToSeconds(clip.start?.ticks ?? 0),
          endSec: ticksToSeconds(clip.end?.ticks ?? 0),
        });
      }
    }

    const audioTracks = seq.audioTracks ?? [];
    for (let ti = 0; ti < audioTracks.length; ti++) {
      const track = audioTracks[ti];
      const trackClips = track.clips ?? [];
      for (let ci = 0; ci < trackClips.length; ci++) {
        const clip = trackClips[ci];
        clips.push({
          trackIndex: ti,
          trackType: 'audio',
          clipIndex: ci,
          name: clip.name ?? `Clip ${ci}`,
          startSec: ticksToSeconds(clip.start?.ticks ?? 0),
          endSec: ticksToSeconds(clip.end?.ticks ?? 0),
        });
      }
    }

    return {
      ok: true,
      data: {
        sequenceName: seq.name,
        durationSec: ticksToSeconds(seq.end?.ticks ?? 0),
        videoTrackCount: videoTracks.length,
        audioTrackCount: audioTracks.length,
        clips,
      },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Edit actions ───────────────────────────────────────────────────────────

export async function cutClip({ trackIndex, clipIndex, time }) {
  try {
    const seq = getSequence();
    const track = seq.videoTracks[trackIndex];
    if (!track) throw new Error(`Video track ${trackIndex} not found`);
    const clip = track.clips[clipIndex];
    if (!clip) throw new Error(`Clip ${clipIndex} not found on track ${trackIndex}`);

    const cutTime = seq.getPlayerPosition();  // fallback
    const ticks = secondsToTicks(time);
    await seq.razor([{ clip, position: { ticks } }]);

    return { ok: true, data: { message: `Cut clip at ${time}s` } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function moveClip({ trackIndex, clipIndex, newStart }) {
  try {
    const seq = getSequence();
    const track = seq.videoTracks[trackIndex];
    if (!track) throw new Error(`Video track ${trackIndex} not found`);
    const clip = track.clips[clipIndex];
    if (!clip) throw new Error(`Clip ${clipIndex} not found`);

    const newStartTicks = secondsToTicks(newStart);
    clip.start = { ticks: newStartTicks };

    return { ok: true, data: { message: `Moved clip to ${newStart}s` } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function trimClip({ trackIndex, clipIndex, newIn, newOut }) {
  try {
    const seq = getSequence();
    const track = seq.videoTracks[trackIndex];
    const clip = track?.clips[clipIndex];
    if (!clip) throw new Error(`Clip ${clipIndex} on track ${trackIndex} not found`);

    if (newIn != null) clip.inPoint = { ticks: secondsToTicks(newIn) };
    if (newOut != null) clip.outPoint = { ticks: secondsToTicks(newOut) };

    return { ok: true, data: { message: `Trimmed clip (in=${newIn}s, out=${newOut}s)` } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function addMarker({ time, name, color }) {
  try {
    const seq = getSequence();
    const markers = seq.markers;
    const marker = markers.createMarker(secondsToTicks(time));
    if (name) marker.name = name;
    if (color) marker.colorIndex = colorNameToIndex(color);

    return { ok: true, data: { message: `Marker "${name}" added at ${time}s` } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function addSubtitle({ text, startTime, endTime, captionTrackIndex = 0 }) {
  try {
    const seq = getSequence();
    // UXP caption API is limited; use ExtendScript bridge if needed
    const captionTracks = seq.captionTracks ?? [];
    let track = captionTracks[captionTrackIndex];
    if (!track) {
      track = await seq.createCaptionTrack?.();
      if (!track) throw new Error('Cannot create caption track in this Premiere version');
    }
    const clip = await track.createCaption?.(
      { ticks: secondsToTicks(startTime) },
      { ticks: secondsToTicks(endTime) }
    );
    if (clip) clip.text = text;

    return { ok: true, data: { message: `Subtitle added: "${text}"` } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function applyEffect({ trackIndex, clipIndex, effectName }) {
  try {
    const seq = getSequence();
    const track = seq.videoTracks[trackIndex];
    const clip = track?.clips[clipIndex];
    if (!clip) throw new Error(`Clip not found`);

    // Get the effect from the effects manager
    const qe = ppro.app.getQEDOM?.();
    if (!qe) throw new Error('QEDOM not available; use newer Premiere version');
    const effect = qe.getVideoEffectByName(effectName);
    if (!effect) throw new Error(`Effect "${effectName}" not found`);
    clip.videoComponents.addComponent(effect);

    return { ok: true, data: { message: `Applied "${effectName}"` } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function setVolume({ trackIndex, clipIndex, volumeDb }) {
  try {
    const seq = getSequence();
    const track = seq.audioTracks[trackIndex];
    const clip = track?.clips[clipIndex];
    if (!clip) throw new Error(`Audio clip not found`);

    const components = clip.audioComponents;
    for (let i = 0; i < components.length; i++) {
      const comp = components[i];
      if (comp.displayName === 'Volume') {
        comp.properties.getPropertyByDisplayName('Level').setValue(volumeDb, true);
        break;
      }
    }

    return { ok: true, data: { message: `Volume set to ${volumeDb}dB` } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Dispatcher ─────────────────────────────────────────────────────────────

const ACTION_MAP = {
  get_timeline_info: getTimelineInfo,
  cut_clip: cutClip,
  move_clip: moveClip,
  trim_clip: trimClip,
  add_marker: addMarker,
  add_subtitle: addSubtitle,
  apply_effect: applyEffect,
  set_volume: setVolume,
};

export async function executeAction(actionObj) {
  const { action, ...params } = actionObj;
  const fn = ACTION_MAP[action];
  if (!fn) return { ok: false, error: `Unknown action: ${action}` };
  return fn(params);
}

// ── Utilities ──────────────────────────────────────────────────────────────

function colorNameToIndex(name) {
  const map = { violet: 0, iris: 1, caribbean: 2, lavender: 3, cerulean: 4,
                forest: 5, rose: 6, mango: 7, red: 6, green: 5, blue: 4 };
  return map[name?.toLowerCase()] ?? 0;
}
