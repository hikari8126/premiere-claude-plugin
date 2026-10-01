// bridge/test/rawcut-protocol.test.js
const assert = require('assert');
const { parseLine, createParser, parseStderr } = require('../rawcut-protocol.js');

assert.deepStrictEqual(parseLine('  >> video/1/0/25 01_(00.40-01.40)_src.mp4'), { type: 'start', key: 'video/1/0/25', file: '01_(00.40-01.40)_src.mp4' });
assert.deepStrictEqual(parseLine('  >> 01_a.mp4'), { type: 'start', key: null, file: '01_a.mp4' });
assert.deepStrictEqual(parseLine('  [1/2] OK  01_a.mp4'), { type: 'done', n: 1, total: 2, flag: 'OK', file: '01_a.mp4', ok: true });
assert.strictEqual(parseLine('  [2/2] HAVE 02_b.mp4').ok, true);
assert.strictEqual(parseLine('  [2/2] FAIL 02_b.mp4').ok, false);
assert.deepStrictEqual(parseLine('  ++ dump agrees'), { type: 'note', text: 'dump agrees' });
assert.deepStrictEqual(parseLine('  !! clip offline'), { type: 'warn', text: 'clip offline' });
assert.deepStrictEqual(parseLine('Cutting with 8 parallel job(s) ...'), { type: 'encoding' });
assert.strictEqual(parseLine('Done: 2 written, 0 failed'), null);
// dòng thụt 8 cách chỉ là lý do khi đứng ngay sau dòng [n/N]
assert.strictEqual(parseLine('        ffmpeg exited 1', null), null);
assert.deepStrictEqual(parseLine('        ffmpeg exited 1', { type: 'done' }), { type: 'reason', text: 'ffmpeg exited 1' });

// parser ghép chunk bị cắt giữa dòng, bỏ \r
const evs = [], lines = [];
const p = createParser(e => evs.push(e), l => lines.push(l));
p.feed('  [1/2] FA');
p.feed('IL 01_a.mp4\r\n        lý do 1\n');
p.feed('  [2/2] OK  02_b.mp4');
p.end();
assert.deepStrictEqual(evs.map(e => e.type), ['done', 'reason', 'done']);
assert.strictEqual(evs[0].file, '01_a.mp4');
assert.strictEqual(evs[1].text, 'lý do 1');
assert.strictEqual(lines.length, 3);

// stderr
let s = parseStderr('Traceback\nerror: another export is already writing into /x/raw (pid 12).\n');
assert.strictEqual(s.lock, 'another export is already writing into /x/raw (pid 12)');
assert.strictEqual(s.noCuts, false);
assert.strictEqual(parseStderr('error: No cuts found in "Seq".').noCuts, true);
assert.strictEqual(parseStderr('1\n2\n3\n4\n5\n6\n7\n8\n').tail, '3\n4\n5\n6\n7\n8');

console.log('✓ rawcut-protocol');
