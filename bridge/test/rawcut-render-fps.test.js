// Real engine + ffmpeg: a timeline range can arrive at a different native render rate.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const RCC = require('../../plugin/rawcut-core.js');
const { findPython } = require('../rawcut-python.js');

const py = findPython();
const env = { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' };
if (!py.ok || spawnSync('ffmpeg', ['-version'], { env }).status !== 0) {
  console.log('⏭ rawcut-render-fps needs python3 and ffmpeg');
  process.exit(0);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-render-fps-'));
const engine = path.join(__dirname, '..', 'rawcut-engine', 'xmlcut.py');
function run(bin, args) {
  const r = spawnSync(bin, args, { env, encoding: 'utf8', timeout: 30000 });
  assert.ifError(r.error);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  return r;
}
function media(file, rate, frames, audio = false, audioDuration = 3) {
  if (file.endsWith('.mkv') && audio) {
    const video = file + '.video.mp4';
    media(video, rate, frames);
    run('ffmpeg', ['-v', 'error', '-y', '-i', video, '-f', 'lavfi', '-i',
      'sine=frequency=440:sample_rate=48000:duration=' + audioDuration,
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', file]);
    const data = probe(file);
    assert.ok(!data.streams.find(s => s.codec_type === 'video').nb_frames);
    assert.ok(Math.round(Number(data.format.duration) * 24) > frames, 'audio tail must inflate the estimated frame count');
    return;
  }
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=' + rate];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=' + audioDuration);
  args.push('-frames:v', String(frames), '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac');
  args.push(file);
  run('ffmpeg', args);
}
function probe(file) {
  return JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).stdout);
}
function exportRange(name, { seqFps = 30, tlFrames = 60, renderFps = 24, renderFrames = 48, fps, audio = false,
  renderContainer = 'mp4', audioDuration = 3 }) {
  const root = path.join(tmp, name), cache = path.join(root, 'renders'), out = path.join(root, 'out');
  fs.mkdirSync(cache, { recursive: true });
  const source = path.join(root, 'source.mp4');
  media(source, 30, 120);
  const ticks = String(Math.round(tlFrames / seqFps * RCC.TPS));
  const dump = RCC.buildDump({ name: 'Test v1', id: 'seq-1', timebase: String(Math.round(RCC.TPS / seqFps)),
    width: 160, height: 90, endTicks: ticks }, [{
    trackType: 'video', trackIndex: 1, name: 'source.mp4', startTicks: '0', endTicks: ticks,
    inTicks: '0', outTicks: ticks, speed: 1,
    pi: { name: 'source.mp4', nodeId: 'src', mediaPath: source }, interp: { frameRate: 30 }
  }]);
  const dj = path.join(root, 'dump.json');
  fs.writeFileSync(dj, JSON.stringify(dump));
  if (renderFrames !== null) media(path.join(cache, 'video-1-0-' + tlFrames + '.' + renderContainer), renderFps, renderFrames, audio, audioDuration);
  const args = [engine, dj, '-o', out, '--render-dir', cache, '--video-track', '1', '--crf', '23'];
  if (fps) args.push('--fps', String(fps));
  if (audio) args.push('--render-audio');
  const r = spawnSync(py.bin, args, { env, encoding: 'utf8', timeout: 30000 });
  assert.ifError(r.error);
  assert.ok(fs.existsSync(path.join(out, 'manifest.json')), r.stderr || r.stdout);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  return { manifest, clip: manifest.clips[0], out, log: r.stdout + r.stderr };
}
function delivered(result, frames, fps, seconds) {
  assert.strictEqual(result.clip.status, 'ok', result.clip.error || result.log);
  const data = probe(path.join(result.out, result.clip.output_file));
  const video = data.streams.find(s => s.codec_type === 'video');
  assert.strictEqual(Number(video.nb_frames), frames);
  const [n, d] = video.r_frame_rate.split('/').map(Number);
  assert.ok(Math.abs(n / d - fps) < 0.001, video.r_frame_rate);
  assert.ok(Math.abs(Number(video.duration) - seconds) < 0.002, video.duration);
  assert.ok(!result.manifest.warnings.some(w => /nowhere near|are SHORTER/.test(w)), result.manifest.warnings.join('\n'));
  return data;
}
try {
  const native = exportRange('native-24', {});
  delivered(native, 48, 24, 2);
  assert.strictEqual(native.clip.duration_frames, 60, 'timeline metadata must stay in timeline frames');
  assert.strictEqual(native.clip.frame_exact, false, 'different native rate cannot claim timeline frame exactness');
  assert.ok(!/render -12 frame/.test(native.clip.display_notes), native.clip.display_notes);

  delivered(exportRange('screenshot-45', { tlFrames: 57, renderFrames: 45 }), 45, 24, 45 / 24);
  delivered(exportRange('rounded-47', { tlFrames: 57, renderFrames: 47 }), 47, 24, 47 / 24);
  delivered(exportRange('force-30', { tlFrames: 57, renderFrames: 45, fps: 30 }), 57, 30, 1.9);
  const matched = exportRange('force-24', { fps: 24 });
  delivered(matched, 48, 24, 2);
  assert.ok(!/OUTPUT RESAMPLED/.test(matched.log), matched.log);
  delivered(exportRange('native-23976', { renderFps: '24000/1001' }), 48, 24000 / 1001, 2.002);
  delivered(exportRange('higher-native', { seqFps: 24, tlFrames: 48, renderFps: 30, renderFrames: 60 }), 60, 30, 2);

  const same = exportRange('same-rate', { renderFps: 30, renderFrames: 60 });
  delivered(same, 60, 30, 2);
  assert.strictEqual(same.clip.frame_exact, true);
  delivered(exportRange('fractional-force', { seqFps: 30000 / 1001, renderFps: '30000/1001', renderFrames: 60, fps: 30 }), 60, 30, 2);

  const mixed = delivered(exportRange('audio-force', { fps: 30, audio: true }), 60, 30, 2);
  const sound = mixed.streams.find(s => s.codec_type === 'audio');
  assert.ok(sound, 'render mix must survive');
  assert.ok(Math.abs(Number(sound.duration) - 2) < 0.05, sound.duration);
  const roundedSound = delivered(exportRange('rounded-audio', { tlFrames: 57, renderFrames: 47, audio: true }), 47, 24, 47 / 24);
  assert.ok(Math.abs(Number(roundedSound.streams.find(s => s.codec_type === 'audio').duration) - 47 / 24) < 0.05);
  delivered(exportRange('mkv-audio-tail', { renderContainer: 'mkv', audio: true, audioDuration: 2.04 }), 48, 24, 2);

  for (const [name, frames] of [['genuinely-short', 30], ['genuinely-long', 72]]) {
    const result = exportRange(name, { renderFrames: frames });
    assert.strictEqual(result.clip.status, 'render_mismatch', result.log);
    assert.ok(!fs.existsSync(path.join(result.out, result.clip.output_file)), 'invalid range must not ship');
  }
  assert.strictEqual(exportRange('same-rate-short', { renderFps: 30, renderFrames: 59 }).clip.status, 'failed');
  assert.strictEqual(exportRange('same-rate-overshoot', { renderFps: 30, renderFrames: 61 }).clip.status, 'render_mismatch');
  assert.strictEqual(exportRange('missing-render', { renderFrames: null }).clip.status, 'no_render');
  console.log('✓ rawcut-render-fps (17 real export cases)');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
