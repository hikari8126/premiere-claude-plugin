// bridge/test/rawcut-endpoints.test.js — scan → export raw/ → scan render → export edited/ → pick → dọn cache
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.PORT = '3032';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ep-'));
process.env.RAWCUT_CACHE = path.join(TMP, 'cache');

const { findPython } = require('../rawcut-python.js');
const ENV = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' };
if (!findPython().ok || spawnSync('ffmpeg', ['-version'], { env: ENV }).status !== 0) {
  console.log('⏭  bỏ qua rawcut-endpoints (thiếu python3 hoặc ffmpeg)');
  process.exit(0);
}
const { app } = require('../server.js');

const T = 254016000000;
const tt = s => ({ ticks: String(Math.round(s * T)), seconds: s });
function ffmpeg(args) { const r = spawnSync('ffmpeg', ['-v', 'error', '-y'].concat(args), { env: ENV }); assert.strictEqual(r.status, 0, String(r.stderr)); }
function dumpFor(src) {
  const clip = (st, en, i, o) => ({
    track_index: 1, track_type: 'video', name: 'src.mp4', media_type: 'Video',
    start: tt(st), end: tt(en), duration: tt(en - st), in_point: tt(i), out_point: tt(o),
    speed: 1, reversed: false, disabled: false, selected: false, is_adjustment_layer: false,
    project_item: { name: 'src.mp4', node_id: '1', type: 1, media_path: src, is_sequence: false, is_offline: false, is_multicam: false },
    interpretation: { frame_rate: 25 }, components: [], has_keyframed_remap: false,
  });
  return {
    generator: 'xmlcut reader', format_version: 1, premiere_version: '26.3', project_name: 'T', project_path: '',
    sequence: { name: 'Test v1', id: 'seq-1', timebase_ticks_per_frame: String(T / 25), fps: 25, frame_width: 320, frame_height: 180, end: tt(2), in_point: null, out_point: null },
    ticks_per_second: T, clips: [clip(0, 1, 0.4, 1.4), clip(1, 2, 2, 3)],
  };
}

const server = app.listen(3032, async () => {
  const base = 'http://127.0.0.1:3032';
  const opts = b => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
  const post = (u, b) => fetch(base + u, opts(b)).then(r => r.json());
  const sse = async (u, b) => {
    const t = await (await fetch(base + u, opts(b))).text();
    return t.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => JSON.parse(l.slice(6)));
  };
  const doneEvs = list => list.filter(x => x.type === 'event' && x.ev.type === 'done');
  try {
    const st = await fetch(base + '/rawcut/status').then(r => r.json());
    assert.strictEqual(st.ok, true, JSON.stringify(st));
    assert.strictEqual(st.engine.version, '3.93');

    const src = path.join(TMP, 'src.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-t', '4', '-pix_fmt', 'yuv420p', src]);
    const proj = path.join(TMP, 'proj', 'Edit.prproj');
    fs.mkdirSync(path.dirname(proj));

    // 1. scan nửa source
    const s1 = await post('/rawcut/scan', { projectPath: proj, sequenceName: 'Test v1', dump: dumpFor(src), half: 'source', options: { transitions: 'split' } });
    assert.strictEqual(s1.ok, true, s1.error);
    assert.strictEqual(s1.manifest.clips.length, 2);
    assert.ok(s1.manifest.clips.every(c => c.cuttable));
    assert.ok(s1.read.json.startsWith(path.join(TMP, 'proj', 'xmlcut', 'Test v1')), s1.read.json);

    // 2. export raw/
    const raw = path.join(TMP, 'out', 'v1', 'raw');
    const e1 = await sse('/rawcut/export', { read: s1.read, sequenceName: 'Test v1', out: raw, options: { transitions: 'split' } });
    assert.strictEqual(doneEvs(e1).length, 2);
    assert.ok(doneEvs(e1).every(x => x.ev.ok));
    const end1 = e1[e1.length - 1];
    assert.strictEqual(end1.type, 'end');
    assert.strictEqual(end1.code, 0, end1.tail);
    assert.strictEqual(end1.built, true);
    assert.strictEqual(end1.manifest.counts.ok, 2);
    assert.ok(fs.existsSync(path.join(raw, 'report', path.basename(s1.read.json))));
    assert.ok(fs.existsSync(path.join(raw, 'report', 'bridge-log.txt')));

    // 3. scan nửa render trên cùng lần đọc → nhãn render
    const s2 = await post('/rawcut/scan', { read: s1.read, sequenceName: 'Test v1', half: 'render', options: { videoTrack: 1, transitions: 'split' } });
    assert.strictEqual(s2.ok, true, s2.error);
    const labels = s2.manifest.clips.map(c => c.track_type + '-' + c.track_index + '-' + c.timeline_in_frames + '-' + c.timeline_out_frames);
    assert.deepStrictEqual(labels, ['video-1-0-25', 'video-1-25-50']);

    // 4. cache + render giả (thay Premiere) → export edited/
    const edited = path.join(TMP, 'out', 'v1', 'edited');
    const rc = await post('/rawcut/render-cache', { out: edited });
    assert.strictEqual(rc.ok, true, rc.error);
    assert.ok(rc.dir.startsWith(process.env.RAWCUT_CACHE));
    for (const l of labels) ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '1', '-pix_fmt', 'yuv420p', path.join(rc.dir, l + '.mp4')]);
    const e2 = await sse('/rawcut/export', { read: s1.read, sequenceName: 'Test v1', out: edited, renderDir: rc.dir, options: { videoTrack: 1, transitions: 'split' } });
    const end2 = e2[e2.length - 1];
    assert.strictEqual(end2.code, 0, end2.tail);
    assert.strictEqual(end2.manifest.counts.ok, 2);

    // 5. pick: chỉ 1 clip
    const e3 = await sse('/rawcut/export', { read: s1.read, sequenceName: 'Test v1', out: path.join(TMP, 'out', 'pick'), pick: [end1.manifest.clips[0].cut_id] });
    assert.strictEqual(doneEvs(e3).length, 1);

    // 6. preset: mbps 0 → preset gốc (nếu máy có Premiere)
    const pr = await post('/rawcut/render-preset', { dir: rc.dir, mbps: 0 });
    if (pr.ok) assert.strictEqual(pr.stock, true);

    // 7. dọn cache — chỉ trong cache
    assert.strictEqual((await post('/rawcut/render-cache/clean', { dir: rc.dir })).ok, true);
    assert.ok(!fs.existsSync(rc.dir));
    assert.strictEqual((await post('/rawcut/render-cache/clean', { dir: TMP })).ok, false);

    // 8. input sai
    assert.strictEqual((await post('/rawcut/scan', { sequenceName: 'x' })).ok, false);
    assert.strictEqual((await fetch(base + '/rawcut/export', opts({ read: { json: '/khong/co.json' }, out: raw }))).status, 400);

    console.log('✓ rawcut-endpoints');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.close();
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  }
});
