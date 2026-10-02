// bridge/test/rawcut-reads.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeName, readFolderFor, saveRead, pruneReads } = require('../rawcut-reads.js');

assert.strictEqual(safeName('A/B:C\\D'), 'A-B-C-D');
assert.strictEqual(safeName('  ..x.. '), 'x');
assert.strictEqual(safeName(''), 'Untitled Sequence');
assert.strictEqual(safeName('a'.repeat(100)).length, 80);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-reads-'));
const proj = path.join(tmp, 'P', 'Edit.prproj');
assert.deepStrictEqual(readFolderFor(proj, 'Seq v1'), { dir: path.join(tmp, 'P', 'xmlcut', 'Seq v1'), besideProject: true });
assert.deepStrictEqual(readFolderFor('', 'S', tmp), { dir: path.join(tmp, 'Desktop', 'xmlcut-dumps', 'S'), besideProject: false });

// ghi dump + copy XML
const xmlSrc = path.join(tmp, 'in.xml');
fs.writeFileSync(xmlSrc, '<xmeml/>');
const r = saveRead({ projectPath: proj, sequenceName: 'Seq v1', dump: { a: 'Việt' }, xmlPath: xmlSrc, now: new Date(2026, 9, 1, 9, 5, 7) });
assert.strictEqual(path.basename(r.json), '2026-10-01_090507.json');
assert.deepStrictEqual(JSON.parse(fs.readFileSync(r.json, 'utf8')), { a: 'Việt' });
assert.strictEqual(path.basename(r.xml), '2026-10-01_090507.xml');
assert.strictEqual(fs.readFileSync(r.xml, 'utf8'), '<xmeml/>');
assert.strictEqual(saveRead({ projectPath: proj, sequenceName: 'Seq v1', dump: {}, now: new Date(2026, 9, 1, 9, 5, 8) }).xml, null);

// giữ 10 lần mới nhất, không đụng file lạ
for (let i = 10; i < 22; i++) fs.writeFileSync(path.join(r.dir, '2026-09-01_0000' + i + '.json'), '{}');
fs.writeFileSync(path.join(r.dir, 'ghi-chu.txt'), 'x');
pruneReads(r.dir, 10);
const left = fs.readdirSync(r.dir).filter(n => /\.json$/.test(n));
assert.strictEqual(left.length, 10);
assert.ok(left.includes('2026-10-01_090507.json') && left.includes('2026-10-01_090508.json'));
assert.ok(fs.existsSync(path.join(r.dir, 'ghi-chu.txt')));

console.log('✓ rawcut-reads');
