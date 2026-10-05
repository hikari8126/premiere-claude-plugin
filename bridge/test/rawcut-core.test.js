// bridge/test/rawcut-core.test.js — logic thuần của tab Raw-cutter (plugin/rawcut-core.js)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const RCC = require('../../plugin/rawcut-core.js');
const { findPython } = require('../rawcut-python.js');

const T = RCC.TPS;

// 1. thời gian: ticks là chuỗi; in/out âm (chưa đặt) → null
assert.strictEqual(RCC.tickStr(304819200000), '304819200000');
assert.strictEqual(RCC.tickStr('8467200000'), '8467200000');
assert.deepStrictEqual(RCC.timeObj('254016000000'), { ticks: '254016000000', seconds: 1 });
assert.strictEqual(RCC.pointOrNull('-101606400000000000'), null);
assert.strictEqual(RCC.pointOrNull(null), null);
assert.deepStrictEqual(RCC.pointOrNull('0'), { ticks: '0', seconds: 0 });

// 2. dump đúng schema
const tb = String(T / 25);
const src = '/tmp/x/src.mp4';
const clip = (st, en, i, o, extra) => Object.assign({
  trackIndex: 1, trackType: 'video', name: 'src.mp4', startTicks: String(st * T), endTicks: String(en * T),
  inTicks: String(Math.round(i * T)), outTicks: String(Math.round(o * T)), speed: 1, reversed: 0, disabled: false,
  pi: { name: 'src.mp4', nodeId: 'n1', mediaPath: src, isSequence: false, isOffline: false, isMulticam: false },
  interp: { frameRate: 25, par: 1, fieldType: -1, alphaUsage: 0 },
  components: [{ displayName: 'Opacity', matchName: 'AE.ADBE Opacity' }],
}, extra || {});
const d = RCC.buildDump({ name: 'Test v1', id: 'seq-1', timebase: tb, width: 320, height: 180, endTicks: String(2 * T),
  inTicks: '-101606400000000000', outTicks: '-101606400000000000', premiereVersion: '25.6.5' },
  [clip(0, 1, 0.4, 1.4), clip(1, 2, 2, 3, { trackType: 'audio', reversed: 1, speed: 0 })]);
assert.strictEqual(d.generator, 'xmlcut reader');
assert.strictEqual(d.format_version, 1);
assert.strictEqual(d.sequence.fps, 25);
assert.strictEqual(d.sequence.timebase_ticks_per_frame, tb);
assert.strictEqual(d.sequence.in_point, null);
assert.strictEqual(d.clips[0].duration.ticks, String(T));
assert.strictEqual(d.clips[0].project_item.media_path, src);
assert.strictEqual(d.clips[0].interpretation.frame_rate, 25);
assert.strictEqual(d.clips[1].track_type, 'audio');
assert.strictEqual(d.clips[1].media_type, 'Audio');
assert.strictEqual(d.clips[1].reversed, true);
assert.strictEqual(d.clips[1].speed, null, 'speed 0 → null');

// 3. fingerprint: đổi gì đáng kể cũng đổi hash
const tr = () => [{ kind: 'v', index: 1, muted: false, clips: [{ start: '0', end: '10', inp: '0', out: '10', on: true, nodeId: 'a', path: '/a.mp4' }] },
  { kind: 'a', index: 1, muted: false, clips: [] }];
const fp0 = RCC.fingerprint(tr());
assert.ok(/^-?\d+\.1$/.test(fp0), fp0);
assert.strictEqual(RCC.fingerprint(tr()), fp0, 'ổn định');
let t2 = tr(); t2[0].clips[0].inp = '1'; t2[0].clips[0].out = '11';
assert.notStrictEqual(RCC.fingerprint(t2), fp0, 'slip');
t2 = tr(); t2[0].clips[0].on = false;
assert.notStrictEqual(RCC.fingerprint(t2), fp0, 'tắt clip');
t2 = tr(); t2[0].muted = true;
assert.notStrictEqual(RCC.fingerprint(t2), fp0, 'tắt mắt track');
t2 = tr(); t2[0].clips[0].path = '/b.mp4';
assert.notStrictEqual(RCC.fingerprint(t2), fp0, 'replace footage');
t2 = tr(); t2[0].clips[0].nest = '123.4';
assert.notStrictEqual(RCC.fingerprint(t2), fp0, 'sửa trong nest');

// 4. manifest → rows, chip loại file, lọc
const man = { clips: [
  { cut_id: 'aaa', track_type: 'video', track_index: 1, timeline_in_frames: 0, timeline_out_frames: 25, source_path: '/s/A.MP4', cuttable: true, status: 'pending', speed_percent: 200 },
  { cut_id: 'bbb', track_type: 'video', track_index: 1, timeline_in_frames: 25, timeline_out_frames: 50, source_path: '/s/B.mov', cuttable: true, status: 'pending' },
  { cut_id: 'ccc', track_type: 'video', track_index: 2, timeline_in_frames: 0, timeline_out_frames: 10, source_path: '/s/fx.aep', cuttable: false, status: 'unsupported', display_kind: 'bad' },
  { cut_id: '', track_type: 'video', track_index: 2, timeline_in_frames: 10, timeline_out_frames: 20, source_path: '', cuttable: true, status: 'pending' },
] };
const rows = RCC.rowsFromManifest(man, 'source');
assert.strictEqual(rows.length, 4);
assert.strictEqual(rows[0].ext, 'mp4');
assert.strictEqual(rows[0].speed, '200%');
assert.strictEqual(rows[1].speed, '');
assert.strictEqual(rows[3].key, 'video 2 10 20', 'không có cut_id → khoá theo vị trí');
assert.strictEqual(rows[3].ext, '(none)');
const types = RCC.typeList(rows, {});
const byExt = {}; types.forEach(t => { byExt[t.ext] = t; });
assert.strictEqual(byExt.aep.on, false, 'aep mặc định tắt');
assert.strictEqual(byExt.png.n, 0, 'png luôn hiện');
assert.strictEqual(byExt.mp4.on, true);
assert.strictEqual(RCC.typeList(rows, { mp4: false }).find(t => t.ext === 'mp4').on, false, 'nhớ lựa chọn');
const allOff = RCC.typesWithFallback(RCC.typeList(rows, { mp4: false, mov: false, aep: false }));
assert.strictEqual(allOff.reset, true);
assert.ok(allOff.list.filter(t => t.n > 0).every(t => t.on));

let picked = RCC.pickRows(rows, { half: 'source', typesOn: { mp4: false, mov: true } });
assert.deepStrictEqual(picked.map(r => r.key), ['bbb', 'video 2 10 20']);
picked = RCC.pickRows(rows, { half: 'source', typesOn: {}, unpicked: { bbb: true } });
assert.deepStrictEqual(picked.map(r => r.key), ['aaa', 'video 2 10 20']);
picked = RCC.pickRows(rows, { half: 'render', typesOn: { mp4: false }, master: 1 });
assert.deepStrictEqual(picked.map(r => r.key), ['aaa', 'bbb'], 'render: bỏ qua chip loại file, chỉ master track');
assert.deepStrictEqual(RCC.videoTracksPresent(rows), [{ index: 1, items: 2 }, { index: 2, items: 1 }]);

// pick keys: chọn hết → null; chọn bớt → kèm dòng không cắt được
assert.strictEqual(RCC.pickKeys(rows, RCC.pickRows(rows, { half: 'source' })), null);
assert.deepStrictEqual(RCC.pickKeys(rows, [rows[0]]), ['aaa', 'ccc']);

// 5. render ranges + retry
const rr = RCC.renderRanges(RCC.pickRows(rows, { half: 'render', master: 1 }), 1);
assert.deepStrictEqual(rr.ranges, [{ label: 'video-1-0-25', inF: 0, outF: 25, key: 'aaa' }, { label: 'video-1-25-50', inF: 25, outF: 50, key: 'bbb' }]);
const retry = RCC.renderRanges(rows.slice(0, 2), 1, { aaa: 'failed', bbb: 'no_render' }, { 'video-1-0-25': true, 'video-1-25-50': true });
assert.deepStrictEqual(retry.ranges.map(r => r.label), ['video-1-25-50'], 'render lỗi phải render lại; clip lỗi encode dùng lại render');
assert.strictEqual(retry.reused, 1);

// 6. bitrate render
assert.strictEqual(RCC.renderMbps(1, 0, 0, 0), 0);
assert.strictEqual(RCC.renderMbps(1, 1080, 1920, 30), 41.7, 'crf 1 kẹp trần 41.7');
const m28 = RCC.renderMbps(28, 1080, 1920, 30);
assert.ok(m28 >= 4 && m28 < 10, String(m28));
assert.strictEqual(RCC.lerp([[0, 0], [10, 10]], 5), 5);

// 7. kết quả
const done = { counts: { ok: 3, failed: 1, no_render: 1 }, clips: [
  { cut_id: 'aaa', status: 'ok', track_type: 'video', track_index: 1 },
  { cut_id: 'bbb', status: 'failed', track_type: 'video', track_index: 1 },
  { cut_id: 'ddd', status: 'no_render', track_type: 'video', track_index: 1 }] };
assert.deepStrictEqual(RCC.summarize(done), { ok: 3, failed: 1, skipped: 0, missing: 0, unsupported: 0, noRender: 1, mismatch: 0, missingPicked: 0 });
assert.deepStrictEqual(RCC.failedKeys(done), { bbb: 'failed', ddd: 'no_render' });
// mất nguồn = lỗi (Retry được); render ngắn → render_short để Retry render lại
const done2 = { counts: {}, clips: [
  { cut_id: 'm1', status: 'missing_source', track_type: 'video', track_index: 1 },
  { cut_id: 'r1', status: 'failed', error: 'the RENDER came up short — ffmpeg read 20 frame(s)', track_type: 'video', track_index: 1 }] };
assert.strictEqual(RCC.summarize(done2).missingPicked, 1);
assert.deepStrictEqual(RCC.failedKeys(done2), { m1: 'missing_source', r1: 'render_short' });
const again = RCC.renderRanges([{ key: 'r1', trackType: 'video', trackIndex: 1, tlIn: 0, tlOut: 25 }], 1, { r1: 'render_short' }, { 'video-1-0-25': true });
assert.strictEqual(again.ranges.length, 1, 'render ngắn không được dùng lại bản cũ');
assert.strictEqual(RCC.failedKeys({ clips: [{ cut_id: 'x', status: 'ok' }] }), null);

// 8. dump dựng ra chạy được qua engine thật
const py = findPython();
const ff = spawnSync('ffmpeg', ['-version'], { env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' } });
if (py.ok && ff.status === 0) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-core-'));
  const media = path.join(tmp, 'src.mp4');
  const r1 = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-t', '4', '-pix_fmt', 'yuv420p', media], { env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' } });
  assert.strictEqual(r1.status, 0);
  const dump = RCC.buildDump({ name: 'Test v1', id: 'seq-1', timebase: tb, width: 320, height: 180, endTicks: String(2 * T) },
    [clip(0, 1, 0.4, 1.4, { pi: { name: 'src.mp4', nodeId: 'n1', mediaPath: media } }), clip(1, 2, 2, 3, { pi: { name: 'src.mp4', nodeId: 'n1', mediaPath: media } })]);
  const dj = path.join(tmp, 'dump.json');
  fs.writeFileSync(dj, JSON.stringify(dump));
  const out = path.join(tmp, 'scan');
  const r2 = spawnSync(py.bin, [path.join(__dirname, '..', 'rawcut-engine', 'xmlcut.py'), dj, '-o', out, '--manifest-only'], { encoding: 'utf8', env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: os.homedir() } });
  assert.strictEqual(r2.status, 0, r2.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  const rws = RCC.rowsFromManifest(m, 'source');
  assert.strictEqual(rws.length, 2);
  assert.ok(rws.every(r => r.cuttable), JSON.stringify(rws));
  assert.deepStrictEqual(rws.map(r => [r.tlIn, r.tlOut]), [[0, 25], [25, 50]]);
}

// cleanChosen: bỏ cờ `true` lưu nhầm (lỗi ≤5.15.0), giữ đường dẫn tuyệt đối
assert.deepStrictEqual(RCC.cleanChosen({ '/a.prproj': true, '/b.prproj': 'true', '/c.prproj': '/Volumes/X/Out', '/d.prproj': '' }),
  { '/c.prproj': '/Volumes/X/Out' });
assert.deepStrictEqual(RCC.cleanChosen(null), {});

console.log('✓ rawcut-core');
