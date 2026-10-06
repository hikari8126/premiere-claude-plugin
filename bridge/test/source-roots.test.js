// bridge/test/source-roots.test.js
// Autocut tìm source: project trong SAMX_WORKSPACE → quét cả <SP> (Sources trước,
// bỏ Output), không chỉ <SP>/Asset như bản cũ. Khớp "Senyue 33" qua thư mục tổ
// tiên (cha trực tiếp là "approve"), reject không tick sẵn, trùng tên chỉ chọn 1.
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { searchRoots } = require('../source-roots.js');
const { findSources } = require('../watchfolder-find.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'src-roots-'));
const SP = path.join(tmp, 'SAMX_WORKSPACE', 'AeriSoft');
const mk = (rel, body) => {
  const abs = path.join(SP, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body || 'x');
};
mk('Asset/project/AeriSoft.prproj');
mk('Asset/Clips/AI Gen 3.mp4');
mk('Sources/legacy/_untyped/approve/AI Gen 3.mp4');
mk('Sources/legacy/studio/Senyue/approve/AeriSoft_Senyue_20250806/AeriSoft_Senyue_Outcome_20250806/33.mp4');
mk('Sources/legacy/model/Amie Cleland/approve/4.mp4');
mk('Sources/legacy/model/Amie Cleland/reject/5.mp4');
mk('Asset/Clips/DISQUALIFIED VIDEO SOURCE/Higg9_1-2s.mp4');
mk('Output/FB/Clip Out 1.mp4');                // bản render — không phải source
const PROJ = path.join(SP, 'Asset', 'project', 'AeriSoft.prproj');

(async () => {
  // 1. Gốc quét: Sources trước, Asset sau, KHÔNG có Output; hiển thị tính từ <SP>.
  const sr = await searchRoots(PROJ, {});
  assert.strictEqual(sr.product, SP);
  assert.strictEqual(sr.productName, 'AeriSoft');
  assert.strictEqual(sr.by, 'inside');
  assert.deepStrictEqual(sr.roots.map(r => r.label), ['Sources', 'Asset']);

  // 2. Không thuộc SAMX → như cũ: cấp cha của thư mục .prproj.
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'src-plain-'));
  fs.mkdirSync(path.join(plain, 'Project'));
  const sr2 = await searchRoots(path.join(plain, 'Project', 'x.prproj'), { cloudStorage: path.join(plain, 'none') });
  assert.strictEqual(sr2.product, '');
  assert.deepStrictEqual(sr2.roots.map(r => r.path), [plain]);

  const run = names => findSources(sr.display, names, { roots: sr.roots.map(r => r.path) });

  // 3. Footage ở Sources sâu 7 cấp vẫn tìm được; "Senyue 33" khớp qua thư mục tổ
  //    tiên, bin con mang tên thư mục GẦN NHẤT chứa "senyue" — không phải "approve".
  let r = await run(['Senyue 33']);
  assert.deepStrictEqual(r.unmatched, [], JSON.stringify(r));
  let m = r.folders[0].matches[0];
  assert.strictEqual(m.fileName, '33.mp4');
  assert.strictEqual(m.pass, 3);
  assert.strictEqual(m.hintDir, 'AeriSoft_Senyue_Outcome_20250806');
  assert.strictEqual(r.folders[0].binDirName, 'AeriSoft_Senyue_Outcome_20250806');
  assert.ok(r.folders[0].rel.indexOf(path.join('Sources', 'legacy', 'studio')) === 0, r.folders[0].rel);

  // 4. "Amie 4" → approve/4.mp4; "Amie 5" chỉ có ở reject → vẫn trả, đánh dấu rejected.
  r = await run(['Amie 4', 'Amie 5']);
  assert.deepStrictEqual(r.unmatched, []);
  const all = [].concat(...r.folders.map(f => f.matches));
  assert.strictEqual(all.find(x => x.name === 'Amie 4').rejected, false);
  assert.strictEqual(all.find(x => x.name === 'Amie 4').hintDir, 'Amie Cleland');
  assert.strictEqual(all.find(x => x.name === 'Amie 5').rejected, true);
  assert.strictEqual(r.folders[r.folders.length - 1].rejected, true, 'thư mục reject xếp cuối');

  // 5. DISQUALIFIED cũng là reject.
  r = await run(['Higg9']);
  assert.strictEqual(r.folders[0].matches[0].rejected, true);

  // 6. Cùng file ở Sources lẫn Asset/Clips → chỉ một bản là chính (Sources), bản kia alt.
  r = await run(['AI Gen 3']);
  const hits = [].concat(...r.folders.map(f => f.matches));
  assert.strictEqual(hits.length, 2);
  const main = hits.filter(x => !x.alt);
  assert.strictEqual(main.length, 1);
  assert.ok(main[0].filePath.indexOf(path.join(SP, 'Sources')) === 0, main[0].filePath);

  // 7. Output không bị quét.
  r = await run(['Clip Out 1']);
  assert.deepStrictEqual(r.unmatched, ['Clip Out 1'], 'Output là bản render, không tìm ở đó');

  // 8. Một gốc hỏng không chặn lượt tìm; tất cả hỏng mới báo lỗi.
  r = await findSources(sr.display, ['Amie 4'], { roots: [path.join(SP, 'Không có'), path.join(SP, 'Sources')] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.skippedRoots.length, 1);
  r = await findSources(sr.display, ['Amie 4'], { roots: [path.join(SP, 'Không có')] });
  assert.strictEqual(r.ok, false);

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(plain, { recursive: true, force: true });
  console.log('source-roots: OK');
})().catch(e => { console.error(e); process.exit(1); });
