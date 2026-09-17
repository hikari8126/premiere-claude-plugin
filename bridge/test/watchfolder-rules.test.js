// bridge/test/watchfolder-rules.test.js
const assert = require('assert');
const { validateWatch, matchFile, binPathFor, PRESETS } = require('../watchfolder-rules.js');

const base = {
  id: 'w_1', enabled: true, label: 'T', folder: '/x', binPath: 'Footage/Drone',
  recursive: true, maxDepth: 3, mirrorSubfolders: true,
  include: ['video'], includeRegex: '', excludeRegex: '',
  intervalMs: 3000, stableChecks: 2,
};

// ── validateWatch ─────────────────────────────────────────────────────────
assert.strictEqual(validateWatch(base).ok, true, 'watch hợp lệ');
assert.strictEqual(validateWatch({ ...base, folder: '' }).ok, false, 'thiếu folder → lỗi');
assert.strictEqual(validateWatch({ ...base, binPath: '' }).ok, false, 'thiếu binPath → lỗi');
assert.strictEqual(validateWatch({ ...base, include: [] }).ok, false, 'không chọn loại file → lỗi');
const badRe = validateWatch({ ...base, excludeRegex: '[' });
assert.strictEqual(badRe.ok, false, 'regex sai cú pháp → lỗi');
assert.ok(/excludeRegex/.test(badRe.error), 'lỗi nêu đúng tên trường: ' + badRe.error);
assert.strictEqual(validateWatch({ ...base, intervalMs: 100 }).ok, false, 'interval < 1000ms → lỗi');

// ── matchFile: bỏ qua cứng ────────────────────────────────────────────────
assert.strictEqual(matchFile(base, '.DS_Store'), false, 'bỏ .DS_Store');
assert.strictEqual(matchFile(base, '._a.mp4'), false, 'bỏ file resource fork macOS');
assert.strictEqual(matchFile(base, '.hidden/a.mp4'), false, 'bỏ file trong thư mục ẩn');
assert.strictEqual(matchFile(base, 'a.mp4.tmp'), false, 'bỏ .tmp');
assert.strictEqual(matchFile(base, 'a.mp4.part'), false, 'bỏ .part');
assert.strictEqual(matchFile(base, 'a.mp4.crdownload'), false, 'bỏ .crdownload');
assert.strictEqual(
  matchFile(base, 'Adobe Premiere Pro Auto-Save/a.mp4'), false, 'bỏ thư mục Auto-Save');
assert.strictEqual(
  matchFile(base, 'Adobe Premiere Pro Preview Files/a.mp4'), false, 'bỏ Preview Files');

// ── matchFile: preset đuôi file ───────────────────────────────────────────
assert.strictEqual(matchFile(base, 'a.mp4'), true, 'video preset nhận mp4');
assert.strictEqual(matchFile(base, 'a.MOV'), true, 'đuôi file không phân biệt hoa thường');
assert.strictEqual(matchFile(base, 'a.wav'), false, 'video preset loại wav');
assert.strictEqual(matchFile({ ...base, include: ['video', 'audio'] }, 'a.wav'), true,
  'chọn nhiều preset');
assert.strictEqual(matchFile({ ...base, include: ['all'] }, 'a.xyz'), true, 'preset all nhận hết');
assert.strictEqual(matchFile({ ...base, include: ['all'] }, 'a.tmp'), false,
  'preset all vẫn không phá luật bỏ qua cứng');
assert.ok(PRESETS.video.includes('.braw') && PRESETS.image.includes('.dng'), 'preset đủ đuôi');

// ── matchFile: regex khớp trên TÊN FILE, không phải full path ─────────────
assert.strictEqual(matchFile({ ...base, excludeRegex: '_proxy$' }, 'a_proxy.mp4'), false,
  'excludeRegex khớp phần tên trước đuôi');
assert.strictEqual(matchFile({ ...base, excludeRegex: '_proxy$' }, 'a.mp4'), true);
assert.strictEqual(matchFile({ ...base, includeRegex: '^DJI_' }, 'DJI_0041.mp4'), true);
assert.strictEqual(matchFile({ ...base, includeRegex: '^DJI_' }, 'GOPRO.mp4'), false);
assert.strictEqual(matchFile({ ...base, includeRegex: '^DJI_' }, 'DJI_x/GOPRO.mp4'), false,
  'regex KHÔNG khớp vào tên thư mục cha');

// ── binPathFor ────────────────────────────────────────────────────────────
assert.strictEqual(binPathFor(base, 'a.mp4'), 'Footage/Drone', 'file gốc → bin gốc');
assert.strictEqual(binPathFor(base, 'B-roll/b.mp4'), 'Footage/Drone/B-roll');
assert.strictEqual(binPathFor(base, 'B-roll/sunset/c.mp4'), 'Footage/Drone/B-roll/sunset');
assert.strictEqual(binPathFor({ ...base, mirrorSubfolders: false }, 'B-roll/sunset/c.mp4'),
  'Footage/Drone', 'tắt mirror → đổ phẳng');

console.log('watchfolder-rules: OK');
