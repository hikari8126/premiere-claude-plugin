// bridge/test/rawcut-args.test.js
const assert = require('assert');
const { buildArgs } = require('../rawcut-args.js');

// 1. scan có XML: thứ tự cờ đầu đúng như panel CEP (argsFor, M628)
let a = buildArgs({ script: '/e/xmlcut.py', xml: '/r/a.xml', sequenceName: 'Seq v1', dump: '/r/a.json', out: '/tmp/scan', manifestOnly: true, transitions: 'split' });
assert.deepStrictEqual(a, ['/e/xmlcut.py', '/r/a.xml', '--sequence', 'name:Seq v1', '--panel', '/r/a.json', '-o', '/tmp/scan', '--transitions', 'split', '--manifest-only']);

// 2. không có XML → dump là input chính
assert.deepStrictEqual(buildArgs({ script: 's', dump: 'd.json', out: 'o' }), ['s', 'd.json', '-o', 'o']);

// 3. giá trị mặc định của engine không gửi
assert.deepStrictEqual(buildArgs({ script: 's', dump: 'd', out: 'o', crf: 1, scale: 100, vcodec: 'libx264' }), ['s', 'd', '-o', 'o']);

// 4. đủ cờ, remap dài trước
a = buildArgs({
  script: 's', dump: 'd', out: 'o', ext: ['.MP4', 'mov'], videoTrack: 2, crf: 4.5, fps: 25, scale: 50,
  vcodec: 'libx265', audioPerTrack: true, audio: true, audioTracks: [1, 3], renderAudio: true,
  transitions: 'split', remap: [['/a', '/x'], ['/a/b', '/y']], renderDir: '/c', resume: true, pick: '/p.txt',
});
assert.deepStrictEqual(a, ['s', 'd', '-o', 'o', '--ext', 'mp4,mov', '--video-track', '2', '--crf', '4.5',
  '--fps', '25', '--scale', '50', '--vcodec', 'libx265', '--audio-per-track', '--audio', '--audio-tracks', '1,3',
  '--render-audio', '--transitions', 'split', '--remap', '/a/b=/y', '--remap', '/a=/x', '--render-dir', '/c',
  '--resume', '--pick', '/p.txt']);

assert.deepStrictEqual(buildArgs({ script: 's', dump: 'd', out: 'o', manifestOnly: true, noProbe: true }), ['s', 'd', '-o', 'o', '--no-probe', '--manifest-only']);

// 5. ràng buộc
assert.throws(() => buildArgs({ script: 's', dump: 'd', out: 'o', renderPlanned: true }), /manifest-only/);
assert.throws(() => buildArgs({ script: 's', dump: 'd', out: 'o', manifestOnly: true, renderPlanned: true, renderDir: '/c' }), /render-dir/);
assert.throws(() => buildArgs({ script: 's', out: 'o' }), /dump/);
assert.throws(() => buildArgs({ script: 's', dump: 'd' }), /thư mục ra/);

console.log('✓ rawcut-args');
