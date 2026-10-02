// bridge/test/aep-relink.test.js — relink đường dẫn footage trong .aep (RIFX).
// Dựng .aep giả theo đúng cấu trúc đọc từ file thật (Fold → Item → Pin → Als2 → alas,
// folder AE là Item → Sfdr → Item…). AEP_SAMPLE=/đường/dẫn.aep để thử thêm file thật.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const aep = require('../aep-relink.js');

function chunk(id, data) {
  data = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const h = Buffer.alloc(8);
  h.write(id, 0, 'latin1');
  h.writeUInt32BE(data.length, 4);
  return Buffer.concat([h, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function list(form, children) { return chunk('LIST', Buffer.concat([Buffer.from(form, 'latin1')].concat(children))); }
function alas(p) {
  return chunk('alas', JSON.stringify({ ascendcount_base: 2, ascendcount_target: 4, fullpath: p, platform: 2,
    server_name: '', server_volume_name: '', target_is_folder: false }));
}
function footage(name, p) {
  return list('Item', [chunk('idta', Buffer.alloc(5, 7)), chunk('Utf8', name), list('Pin ', [chunk('sspc', 'xyz'), list('Als2', [alas(p)])])]);
}
const XMP = Buffer.from('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta/><?xpacket end="w"?>');
function aepFile(children) {
  const body = Buffer.concat([Buffer.from('Egg!', 'latin1')].concat(children));
  const h = Buffer.alloc(8); h.write('RIFX', 0, 'latin1'); h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body, XMP]);
}

const A = '/Footage/Higg/a.mov', B = '/Footage/Higg/b.mov', C = '/Footage/VO/Cảnh 1.mp3';
// LIST 'btdk' trong .aep thật chứa dữ liệu thô — đọc như chunk con là vượt biên.
const RAW_LIST = chunk('LIST', Buffer.concat([Buffer.from('btdk', 'latin1'), Buffer.from([0, 0, 0x7f, 0xff, 1, 2, 3, 4, 5, 6])]));
function sample() {
  return aepFile([
    chunk('head', 'odd'),                                // độ dài lẻ → có byte đệm
    RAW_LIST,
    list('Fold', [
      footage('a.mov', A),
      list('Item', [chunk('Utf8', 'Bin'), list('Sfdr', [
        footage('', B),
        list('Item', [chunk('Utf8', 'VO'), list('Sfdr', [footage('Custom name', C.normalize('NFD'))])]),
      ])]),
    ]),
  ]);
}

test('fullpaths lists every alas, nested folders included', () => {
  const fps = aep.fullpaths(sample()).map(p => p.normalize('NFC'));
  assert.deepStrictEqual(fps, [A, B, C]);
});

test('empty map → byte-identical output', () => {
  const buf = sample();
  const r = aep.rewriteAep(buf, new Map());
  assert.strictEqual(r.replaced, 0);
  assert.ok(r.buf.equals(buf));
});

test('rewrites nested footage, renames Utf8 only when it was the old filename, keeps trailer', () => {
  const buf = sample();
  const map = aep.buildMap([
    { oldPath: A, newPath: '/Footage/Higg/Higg_01.mov' },
    { oldPath: B, newPath: '/Footage/Higg/Higg_02.mov' },
    { oldPath: C, newPath: '/Footage/VO/VO_01.mp3' },
  ]);
  const r = aep.rewriteAep(buf, map);
  assert.strictEqual(r.replaced, 3);
  assert.strictEqual(r.renamed, 1);
  assert.deepStrictEqual(aep.fullpaths(r.buf), ['/Footage/Higg/Higg_01.mov', '/Footage/Higg/Higg_02.mov', '/Footage/VO/VO_01.mp3']);
  const names = aep.itemNames(r.buf);
  assert.deepStrictEqual(names, ['Higg_01.mov', 'Bin', '', 'VO', 'Custom name']);
  assert.ok(r.buf.slice(r.buf.length - XMP.length).equals(XMP), 'XMP trailer kept');
  assert.strictEqual(r.buf.readUInt32BE(4) + 8 + XMP.length, r.buf.length, 'RIFX size recomputed');
  // Ánh xạ ngược đưa về đúng từng byte (trừ NFD → NFC của C, nên so qua fullpaths).
  const back = aep.rewriteAep(r.buf, aep.buildMap([
    { oldPath: '/Footage/Higg/Higg_01.mov', newPath: A },
    { oldPath: '/Footage/Higg/Higg_02.mov', newPath: B },
  ]));
  assert.strictEqual(back.replaced, 2);
  assert.deepStrictEqual(aep.itemNames(back.buf).slice(0, 2), ['a.mov', 'Bin']);
});

test('path match ignores case and Unicode normalisation', () => {
  const r = aep.rewriteAep(sample(), aep.buildMap([{ oldPath: '/footage/vo/cảnh 1.mp3', newPath: '/Footage/VO/x.mp3' }]));
  assert.strictEqual(r.replaced, 1);
});

test('matches AE paths with a /Volumes/<disk> prefix or another account\'s Drive mount, keeps their prefix', () => {
  const PRE = '/Users/me/Library/CloudStorage/GoogleDrive-me@x.com/Shared drives/Team 04/SP/Raw';
  const buf = aepFile([list('Fold', [
    footage('45.MOV', '/Volumes/Macintosh HD' + PRE + '/45.MOV'),
    footage('', '/Users/quan/Library/CloudStorage/GoogleDrive-quan@x.com/Shared drives/Team 04/SP/Raw/3.mov'),
    footage('x.MOV', '/Volumes/Macintosh HD' + PRE + '/other.MOV'),
  ])]);
  const map = aep.buildMap([
    { oldPath: PRE + '/45.MOV', newPath: PRE + '/Senyue_45.MOV' },
    { oldPath: PRE + '/3.MOV', newPath: PRE + '/Senyue_03.mov' },
  ]);
  assert.strictEqual(aep.countAepMatches(buf, map), 2);
  const r = aep.rewriteAep(buf, map);
  assert.strictEqual(r.replaced, 2);
  assert.deepStrictEqual(aep.fullpaths(r.buf), [
    '/Volumes/Macintosh HD' + PRE + '/Senyue_45.MOV',
    '/Users/quan/Library/CloudStorage/GoogleDrive-quan@x.com/Shared drives/Team 04/SP/Raw/Senyue_03.mov',
    '/Volumes/Macintosh HD' + PRE + '/other.MOV',
  ]);
  assert.deepStrictEqual(aep.itemNames(r.buf), ['Senyue_45.MOV', '', 'x.MOV']);
});

test('countAepMatches counts footage pointing at the given paths', () => {
  assert.strictEqual(aep.countAepMatches(sample(), aep.buildMap([{ oldPath: A, newPath: '/z' }, { oldPath: C, newPath: '/y' }])), 2);
  assert.strictEqual(aep.countAepMatches(Buffer.from('not an aep'), aep.buildMap([{ oldPath: A, newPath: '/z' }])), 0);
});

test('rewriteAep refuses a file that is not RIFX', () => {
  assert.throws(() => aep.rewriteAep(Buffer.from('RIFF....'), new Map([['x', 'y']])));
});

test('relinkAepFile backs up and replaces atomically', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-'));
  const f = path.join(d, 'Proj.aep');
  fs.writeFileSync(f, sample());
  const bk = path.join(d, 'backup');
  const r = aep.relinkAepFile(f, aep.buildMap([{ oldPath: A, newPath: '/Footage/Higg/N.mov' }]), bk);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.replaced, 1);
  assert.ok(fs.readFileSync(path.join(bk, 'Proj.aep')).equals(sample()));
  assert.strictEqual(aep.fullpaths(fs.readFileSync(f))[0], '/Footage/Higg/N.mov');
  assert.deepStrictEqual(fs.readdirSync(d).sort(), ['Proj.aep', 'backup']);
  const none = aep.relinkAepFile(f, aep.buildMap([{ oldPath: '/nope', newPath: '/x' }]), bk);
  assert.strictEqual(none.ok, true);
  assert.strictEqual(none.replaced, 0);
});

test('findAepFiles skips Auto-Save, hidden folders and deep folders', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-find-'));
  const mk = (rel) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); };
  mk('Project/A.aep');
  mk('Project/b.AEP');
  mk('Project/Adobe After Effects Auto-Save/A auto-save 1.aep');
  mk('.hidden/C.aep');
  mk('Project/._A.aep');
  mk('1/2/3/4/5/6/7/deep.aep');
  mk('Project/note.txt');
  const r = await aep.findAepFiles(root, { maxDepth: 6, timeoutMs: 5000 });
  assert.deepStrictEqual(r.files.map(f => path.relative(root, f)).sort(), ['Project/A.aep', 'Project/b.AEP']);
  assert.strictEqual(r.timedOut, false);
});

test('scanAep returns only files that reference the paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-scan-'));
  fs.mkdirSync(path.join(root, 'Project'));
  fs.writeFileSync(path.join(root, 'Project', 'Hit.aep'), sample());
  fs.writeFileSync(path.join(root, 'Project', 'Miss.aep'), aepFile([list('Fold', [footage('z.mov', '/other/z.mov')])]));
  const r = await aep.scanAep(root, [A, B], { timeoutMs: 5000 });
  assert.deepStrictEqual(r.files.map(f => [path.basename(f.path), f.count]), [['Hit.aep', 2]]);
});

test('isAeRunning matches the AE app, not the Dynamic Link renderer Premiere starts', () => {
  const saved = process.env.RENAME_FAKE_AE; delete process.env.RENAME_FAKE_AE;
  const DL = '/Applications/Adobe After Effects 2025/Adobe After Effects 2025.app/Contents/aerendercore.app/Contents/MacOS/aerendercore -m -livelink';
  const AE = '/Applications/Adobe After Effects 2025/Adobe After Effects 2025.app/Contents/MacOS/After Effects';
  assert.strictEqual(aep.isAeRunning(DL + '\n/usr/bin/login'), false);
  assert.strictEqual(aep.isAeRunning(DL + '\n' + AE), true);
  assert.strictEqual(aep.isAeRunning(AE + ' -psn_0_123'), true);
  if (saved != null) process.env.RENAME_FAKE_AE = saved;
});

if (process.env.AEP_SAMPLE) {
  test('real sample: round-trip with no changes is byte-identical; full relink + back restores paths', () => {
    const buf = fs.readFileSync(process.env.AEP_SAMPLE);
    assert.ok(aep.rewriteAep(buf, new Map()).buf.equals(buf));
    // Gộp theo hoa/thường + NFC như module (file thật có 'LR 22.MOV' lẫn 'LR 22.mov').
    const fold = p => p.normalize('NFC').toLowerCase();
    const uniq = new Map();
    aep.fullpaths(buf).forEach(p => { if (!uniq.has(fold(p))) uniq.set(fold(p), p); });
    const pairs = Array.from(uniq.values()).map((p, i) => ({ oldPath: p, newPath: path.dirname(p) + '/renamed_' + i + path.extname(p) }));
    const r = aep.rewriteAep(buf, aep.buildMap(pairs));
    assert.strictEqual(r.replaced, aep.fullpaths(buf).length);
    const back = aep.rewriteAep(r.buf, aep.buildMap(pairs.map(p => ({ oldPath: p.newPath, newPath: p.oldPath }))));
    assert.deepStrictEqual(aep.fullpaths(back.buf).map(fold), aep.fullpaths(buf).map(fold));
  });
}
