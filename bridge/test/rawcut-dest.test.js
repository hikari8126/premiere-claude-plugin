// bridge/test/rawcut-dest.test.js — version từ tên sequence + thư mục xuất (SAMX / khớp / chọn / tự do)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../rawcut-dest.js');
const { seqVersion, sameVersion, nextSaid, resolveDest, findSamx, samxProducts, folderTaken, chosenFolder } = D;

// ── seqVersion: các ví dụ trong comment của bản gốc ──
const V = (n) => seqVersion(n).version;
assert.strictEqual(V('Brand v3.2 [a.b][c.d]'), 'v3.2');
assert.strictEqual(V('Brand v3.0 a.b][c.d]'), 'v3.0');          // handle mất "[" vẫn là handle
assert.strictEqual(V('Brand V1.2 [C.a.b][c.d]'), 'v1.2');       // v luôn viết thường
assert.strictEqual(V('Brand vid 13.0 [a.b][c.d] v3'), 'v13.0'); // vid thắng v
assert.strictEqual(V('Brand vid35.1 [a.b] [c.d]'), 'v35.1');
assert.strictEqual(V('Brand v2.1.1'), 'v2.1.1');
assert.strictEqual(V('Brand_v7 x'), 'v7');
assert.strictEqual(V('Brand [ed.v2] v1.3'), 'v1.3');            // v trong ngoặc không đọc
assert.strictEqual(V('Brand v1.2, final'), 'v1.2');             // phẩy + chữ không phải thập phân
assert.strictEqual(V('Brand v1.2,final'), 'v1.2');
assert.strictEqual(V('Brand v1 v1.0'), 'v1');                   // cùng một version
assert.strictEqual(V('Brand 1.1'), 'v1.1');                     // số trần có chấm — cách cuối
assert.strictEqual(V('Brand 1.1 [a.b][c.d] Copy 01'), 'v1.1');
assert.strictEqual(seqVersion('Brand vid 13.0 x').said, 'vid 13.0');
assert.strictEqual(seqVersion('Brand V1.2').said, 'V1.2');
assert.strictEqual(seqVersion('Brand 1.1').said, '1.1');
assert.strictEqual(seqVersion('Brand v1.2').why, '');

// từ chối
function refused(n, re) {
  const r = seqVersion(n);
  assert.strictEqual(r.version, '', n);
  assert.ok(r.why && r.why.indexOf(n) >= 0, n + ' → câu từ chối phải nêu tên');
  if (re) assert.ok(re.test(r.why), n + ': ' + r.why);
  return r;
}
const NONE = /không có version —/, LOOK = /không có version đọc được/;
refused('S17', NONE);
refused('Brand V 1.2', LOOK);
refused('Brand v.1.2', LOOK);
refused('Brand v1,2', LOOK);                                    // phẩy thập phân không đọc
refused('Brand v3.2a', LOOK);                                   // không lùi về v3
refused('Brand [v1.2]', LOOK);                                  // v trong ngoặc
refused('Brand 1.1 [v1.2]', LOOK);                              // v-lookalike chặn cả số trần
refused('GV 2', NONE);                                          // số trần không chấm
refused('VAP 4', NONE);
refused('FB9.16(O) Brand', NONE);                               // dính chữ: nhãn tỉ lệ
refused('Brand 9x16', NONE);
refused('Rev3', NONE);
refused('2v3', NONE);
refused('Phởv1', NONE);                                         // chữ Việt trước v
refused('Phởv1', NONE);                             // dạng tách NFD
refused('Việtv1.2', NONE);
assert.ok(refused('Brand v1.2 v1.3').two);
assert.ok(/hai version khác nhau, v1.2 và v1.3/.test(seqVersion('Brand v1.2 v1.3').why));
assert.ok(refused('Brand vid 9.0 vid 9.1').two);
assert.ok(/hai số vid/.test(seqVersion('Brand vid 9.0 vid 9.1').why));
assert.ok(refused('Brand 1.1 1.2').two);
refused('');

// ── sameVersion / nextSaid ──
assert.ok(sameVersion('v1', 'v1.0'));
assert.ok(sameVersion('V1.0.0', 'v1'));
assert.ok(!sameVersion('v1.2', 'v1.20'));
assert.ok(!sameVersion('Brand', 'Brand'));
assert.strictEqual(nextSaid('v1.2'), 'v1.3');
assert.strictEqual(nextSaid('vid 9.0'), 'vid 9.1');
assert.strictEqual(nextSaid('vid 9'), 'vid 9.1');               // bước nhỏ, không phải vid 10
assert.strictEqual(nextSaid('V1.2', ['v1.0', 'V1.3', 'v1.4.0']), 'V1.5'); // bỏ qua version đã có
assert.strictEqual(nextSaid('1.1', ['v1.2']), '1.3');
assert.strictEqual(nextSaid(''), '');

// ── cây giả ──
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-dest-')));
const mk = (...p) => { const d = path.join(T, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const touch = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s || ''); return p; };
const NO_CLOUD = { cloudStorage: path.join(T, 'no-cloud') };
const rd = (o) => resolveDest(o, NO_CLOUD);

const SAMX = mk('ws', 'SAMX_WORKSPACE');
mk('ws', 'SAMX_WORKSPACE', 'Brand A', 'Output', 'ACT', 'v1.0');
const projA = touch(path.join(SAMX, 'Brand A', 'Asset', 'project', 'x.prproj'));
mk('ws', 'SAMX_WORKSPACE', 'Brand B', 'output', 'act');          // chính tả khác trên đĩa
const projB = touch(path.join(SAMX, 'Brand B', 'Asset', 'project', 'b.prproj'));
mk('ws', 'SAMX_WORKSPACE', 'Brand C', 'Asset');                 // không có Output/
const projC = touch(path.join(SAMX, 'Brand C', 'Asset', 'c.prproj'));
mk('ws', 'SAMX_WORKSPACE', 'Brand D', 'Output');                // Output/ có, chưa có ACT/
const projD = touch(path.join(SAMX, 'Brand D', 'd.prproj'));
mk('ws', 'SAMX_WORKSPACE', '.hidden');
touch(path.join(SAMX, 'loose.txt'));

assert.deepStrictEqual(samxProducts(SAMX), ['Brand A', 'Brand B', 'Brand C', 'Brand D']);
assert.strictEqual(findSamx(projA, NO_CLOUD), SAMX);
assert.strictEqual(findSamx(path.join(SAMX, 'loose.prproj'), NO_CLOUD), '');  // nằm thẳng trong SAMX

// project trong sản phẩm SAMX → Output/ACT/v1.2/raw|edited
let r = rd({ projectPath: projA, sequenceName: 'Brand A v1.2 [a.b][c.d]', sequenceId: 's1', mode: 'both' });
assert.strictEqual(r.ok, true, r.why);
assert.strictEqual(r.route, 'samx');
assert.strictEqual(r.version, 'v1.2');
assert.deepStrictEqual(r.product, { name: 'Brand A', path: path.join(SAMX, 'Brand A') });
assert.strictEqual(r.act, path.join(SAMX, 'Brand A', 'Output', 'ACT'));
assert.strictEqual(r.versionDir, path.join(r.act, 'v1.2'));
assert.deepStrictEqual(r.dirs, { raw: path.join(r.act, 'v1.2', 'raw'), edited: path.join(r.act, 'v1.2', 'edited') });
assert.strictEqual(r.samx, SAMX);
assert.deepStrictEqual(r.products, ['Brand A', 'Brand B', 'Brand C', 'Brand D']);
assert.ok(r.notes.some(n => /chưa có/.test(n)));
assert.ok(!fs.existsSync(r.versionDir), 'resolveDest không được tạo thư mục');

// v1 dùng lại thư mục v1.0 Tech đã tạo
r = rd({ projectPath: projA, sequenceName: 'Brand A v1', mode: 'source' });
assert.strictEqual(r.ok, true, r.why);
assert.strictEqual(r.versionDir, path.join(SAMX, 'Brand A', 'Output', 'ACT', 'v1.0'));
assert.strictEqual(r.dirs.raw, path.join(r.versionDir, 'raw'));

// "act" / "output" viết thường trên đĩa được dùng đúng chính tả
r = rd({ projectPath: projB, sequenceName: 'B v2.0', mode: 'render' });
assert.strictEqual(r.ok, true, r.why);
assert.strictEqual(r.act, path.join(SAMX, 'Brand B', 'output', 'act'));
assert.strictEqual(r.dirs.edited, path.join(SAMX, 'Brand B', 'output', 'act', 'v2.0', 'edited'));

// raw/ viết hoa có sẵn trong version
mk('ws', 'SAMX_WORKSPACE', 'Brand B', 'output', 'act', 'V2', 'RAW');
r = rd({ projectPath: projB, sequenceName: 'B v2.0', mode: 'both' });
assert.strictEqual(r.dirs.raw, path.join(SAMX, 'Brand B', 'output', 'act', 'V2', 'RAW'));
assert.strictEqual(r.dirs.edited, path.join(SAMX, 'Brand B', 'output', 'act', 'V2', 'edited'));

// sản phẩm không có Output/ → từ chối, không tạo
r = rd({ projectPath: projC, sequenceName: 'C v1.0', mode: 'both' });
assert.strictEqual(r.ok, false);
assert.ok(/không có Output\//.test(r.why) && /Tech/.test(r.why), r.why);
assert.ok(!fs.existsSync(path.join(SAMX, 'Brand C', 'Output')));

// Output/ có, ACT/ chưa → "ACT", có ghi chú sẽ tạo
r = rd({ projectPath: projD, sequenceName: 'D v1.0', mode: 'source' });
assert.strictEqual(r.ok, true, r.why);
assert.strictEqual(r.act, path.join(SAMX, 'Brand D', 'Output', 'ACT'));
assert.ok(r.notes.some(n => /Output\/ACT chưa có/.test(n)));

// version lỗi + sản phẩm lỗi → gộp cả hai câu
r = rd({ projectPath: projC, sequenceName: 'S17', mode: 'both' });
assert.strictEqual(r.ok, false);
assert.ok(/Output\//.test(r.why) && /S17/.test(r.why));
r = rd({ projectPath: projA, sequenceName: 'Brand A v1,2', mode: 'both' });
assert.strictEqual(r.ok, false);
assert.strictEqual(r.version, '');
assert.ok(/v1,2/.test(r.why));

// FILE đúng chỗ ACT/ phải nằm → từ chối, nêu tên file
mk('ws', 'SAMX_WORKSPACE', 'Brand E', 'Output');
touch(path.join(SAMX, 'Brand E', 'Output', 'act'), 'x');
r = rd({ projectPath: touch(path.join(SAMX, 'Brand E', 'e.prproj')), sequenceName: 'E v1.0' });
assert.strictEqual(r.ok, false);
assert.ok(/FILE tên “act”/.test(r.why), r.why);
// FILE đúng chỗ raw/: chỉ chặn Source (và Both), Timeline vẫn được
mk('ws', 'SAMX_WORKSPACE', 'Brand A', 'Output', 'ACT', 'v4.0');
touch(path.join(SAMX, 'Brand A', 'Output', 'ACT', 'v4.0', 'raw'), 'x');
assert.strictEqual(rd({ projectPath: projA, sequenceName: 'A v4', mode: 'render' }).ok, true);
r = rd({ projectPath: projA, sequenceName: 'A v4', mode: 'source' });
assert.ok(!r.ok && /FILE tên “raw”/.test(r.why));
r = rd({ projectPath: projA, sequenceName: 'A v4', mode: 'both' });
assert.ok(!r.ok && /Nửa Source Render của Both/.test(r.why) && /edited\//.test(r.why), r.why);

// ── version đã thuộc sequence khác ──
const v12 = mk('ws', 'SAMX_WORKSPACE', 'Brand A', 'Output', 'ACT', 'v1.2', 'raw');
touch(path.join(v12, '01_(00.00-01.00)_src.mp4'));
fs.writeFileSync(path.join(v12, 'manifest.json'), JSON.stringify({
  sequence: { id: 'seq-A', name: 'Brand A v1.2 9x16' }, settings: { cut_from: 'source' }, clips: [{ status: 'ok' }],
}));
const VD12 = path.dirname(v12);
assert.strictEqual(folderTaken(VD12, 'seq-B'), 'Brand A v1.2 9x16');
assert.strictEqual(folderTaken(VD12, 'seq-A'), '');
assert.strictEqual(folderTaken(VD12, 'seq-B', { mode: 'render' }), 'Brand A v1.2 9x16'); // mode kia cũng tính
r = rd({ projectPath: projA, sequenceName: 'Brand A v1.2 4x5', sequenceId: 'seq-B', mode: 'source' });
assert.strictEqual(r.ok, false);
assert.ok(r.taken);
assert.strictEqual(r.takenDir, v12);
assert.ok(/ACT\/v1.2\/raw\/ đã chứa bản xuất của “Brand A v1.2 9x16”/.test(r.why), r.why);
assert.ok(/vd “v1.3”/.test(r.why), r.why);
assert.ok(r.dirs && r.dirs.raw === v12);
// Timeline Render của sequence khác cũng bị chặn (một version = một bản giao)
r = rd({ projectPath: projA, sequenceName: 'Brand A v1.2 4x5', sequenceId: 'seq-B', mode: 'render' });
assert.ok(!r.ok && /không xuất vào ACT\/v1.2\/ được/.test(r.why), r.why);
r = rd({ projectPath: projA, sequenceName: 'Brand A v1.2 4x5', sequenceId: 'seq-B', mode: 'both' });
assert.ok(!r.ok && r.taken && /vd “v1.3”/.test(r.why), r.why);
// gợi ý bỏ qua version đã có trong ACT/
mk('ws', 'SAMX_WORKSPACE', 'Brand A', 'Output', 'ACT', 'v1.3');
r = rd({ projectPath: projA, sequenceName: 'Brand A v1.2 4x5', sequenceId: 'seq-B', mode: 'source' });
assert.ok(/vd “v1.4”/.test(r.why), r.why);
// cùng sequence id (dù đã đổi tên) → được, có ghi chú clip của chính nó
r = rd({ projectPath: projA, sequenceName: 'Brand A V1.2 [x]', sequenceId: 'seq-A', mode: 'both' });
assert.strictEqual(r.ok, true, r.why);
assert.ok(r.notes.some(n => /của chính sequence này/.test(n)));
// thiếu id → so tên đã chuẩn hoá
assert.strictEqual(rd({ projectPath: projA, sequenceName: 'brand a  v1.2 [h.i] 9X16', mode: 'source' }).ok, true);
r = rd({ projectPath: projA, sequenceName: 'Brand A v1.2 1x1', mode: 'source' });
assert.ok(!r.ok && r.taken);
// trùng tên nhưng khác id → câu "trùng tên"
r = rd({ projectPath: projA, sequenceName: 'Brand A v1.2 9x16', sequenceId: 'seq-Z', mode: 'source' });
assert.ok(!r.ok && /trùng tên/.test(r.why), r.why);

// manifest chỉ có dòng pending, không ledger → không ai sở hữu (có ghi chú clip không rõ chủ)
const v5 = mk('ws', 'SAMX_WORKSPACE', 'Brand A', 'Output', 'ACT', 'v5.0', 'raw');
touch(path.join(v5, '01_a.mp4'));
fs.writeFileSync(path.join(v5, 'manifest.json'), JSON.stringify({ sequence: { id: 'other' }, clips: [{ status: 'pending' }] }));
r = rd({ projectPath: projA, sequenceName: 'A v5', sequenceId: 'me', mode: 'source' });
assert.strictEqual(r.ok, true, r.why);
assert.ok(r.notes.some(n => /không bản ghi nào/.test(n)));
// thư mục chỉ có file không phải clip → không ai sở hữu
const v6 = mk('ws', 'SAMX_WORKSPACE', 'Brand A', 'Output', 'ACT', 'v6.0', 'raw');
touch(path.join(v6, 'notes.txt'));
fs.writeFileSync(path.join(v6, 'manifest.json'), JSON.stringify({ sequence: { id: 'other' }, clips: [{ status: 'ok' }] }));
assert.strictEqual(rd({ projectPath: projA, sequenceName: 'A v6', sequenceId: 'me', mode: 'source' }).ok, true);

// ledger trong edited/ (manifest đã mất) → vẫn của sequence khác
const v7 = mk('ws', 'SAMX_WORKSPACE', 'Brand A', 'Output', 'ACT', 'v7.0', 'edited');
touch(path.join(v7, '01_x.mp4'));
fs.writeFileSync(path.join(v7, '.xmlcut-ledger.json'), JSON.stringify({ files: {
  '01_x.mp4': { sequence: { id: 'seq-C', name: 'C seq v7' }, settings: { cut_from: 'render' } },
  '02_gone.mp4': { sequence: { id: 'seq-D' } } } }));
assert.strictEqual(folderTaken(path.dirname(v7), 'me'), 'C seq v7');
r = rd({ projectPath: projA, sequenceName: 'A v7', sequenceId: 'me', mode: 'source' });
assert.ok(!r.ok && /ACT\/v7.0\/edited\//.test(r.why), r.why);
assert.strictEqual(rd({ projectPath: projA, sequenceName: 'A v7', sequenceId: 'seq-C', mode: 'both' }).ok, true);

// bố cục phẳng 3.90 (clip + manifest thẳng trong version/)
const v8 = mk('ws', 'SAMX_WORKSPACE', 'Brand A', 'Output', 'ACT', 'v8.0');
touch(path.join(v8, '01_x.mp4'));
fs.writeFileSync(path.join(v8, 'manifest.json'), JSON.stringify({ sequence: { id: 'old', name: 'Old v8' }, clips: [{ status: 'ok' }] }));
r = rd({ projectPath: projA, sequenceName: 'A v8', sequenceId: 'me', mode: 'render' });
assert.ok(!r.ok && /ACT\/v8.0\/ đã chứa bản xuất của “Old v8”/.test(r.why), r.why);
r = rd({ projectPath: projA, sequenceName: 'A v8', sequenceId: 'old', mode: 'both' });
assert.strictEqual(r.ok, true, r.why);
assert.ok(r.notes.some(n => /lần xuất cũ/.test(n)));

// ── project trên ổ chung khác, SAMX_WORKSPACE cạnh đó ──
const SD = mk('gd', 'Shared drives');
const SAMX2 = mk('gd', 'Shared drives', 'SAMX_WORKSPACE');
for (const p of ['Brand', 'Brand Two', 'Glow Serum', 'Kettle', 'Nopout']) mk('gd', 'Shared drives', 'SAMX_WORKSPACE', p);
mk('gd', 'Shared drives', 'SAMX_WORKSPACE', 'Glow Serum', 'Output', 'ACT');
mk('gd', 'Shared drives', 'SAMX_WORKSPACE', 'Kettle', 'Output');
mk('gd', 'Shared drives', 'SAMX_WORKSPACE', 'Brand Two', 'Output');
const proj = (...p) => touch(path.join(SD, 'Team X', ...p));

// khớp đúng tên (không phân biệt hoa thường, khoảng trắng thừa)
const pG = proj('glow  SERUM', 'Video', 'Editing file', 'g.prproj');
assert.strictEqual(findSamx(pG, NO_CLOUD), SAMX2);
r = rd({ projectPath: pG, sequenceName: 'Glow v2.0', mode: 'both' });
assert.strictEqual(r.ok, true, r.why);
assert.strictEqual(r.route, 'matched');
assert.strictEqual(r.product.name, 'Glow Serum');
assert.strictEqual(r.dirs.raw, path.join(SAMX2, 'Glow Serum', 'Output', 'ACT', 'v2.0', 'raw'));
assert.deepStrictEqual(r.products, ['Brand', 'Brand Two', 'Glow Serum', 'Kettle', 'Nopout']);
// khớp phần đầu: "<Product> (…) - …"
r = rd({ projectPath: proj('Kettle (Acme old) - steel', 'Video', 'k.prproj'), sequenceName: 'K v1.0', mode: 'source' });
assert.strictEqual(r.ok, true, r.why);
assert.strictEqual(r.route, 'matched');
assert.strictEqual(r.act, path.join(SAMX2, 'Kettle', 'Output', 'ACT'));
// theo sau là version → không khớp, phải chọn
r = rd({ projectPath: proj('Kettle 2 - big', 'k.prproj'), sequenceName: 'K v1.0' });
assert.ok(!r.ok && r.needPick, r.why);
assert.ok(/Kettle 2 - big/.test(r.why), r.why);
// hai sản phẩm cùng mở đầu → nêu cả hai, khớp dài hơn trước
r = rd({ projectPath: proj('Brand Two - X', 'b.prproj'), sequenceName: 'B v1.0' });
assert.ok(!r.ok && r.needPick);
assert.ok(/2 sản phẩm.*“Brand Two” và “Brand”/.test(r.why), r.why);
assert.strictEqual(r.candidates[0], 'Brand Two');
// chọn từ menu → picked; chọn đè lên cả sản phẩm khớp
r = rd({ projectPath: proj('Brand Two - X', 'b.prproj'), sequenceName: 'B v1.0', productPick: 'Brand Two', mode: 'render' });
assert.strictEqual(r.ok, true, r.why);
assert.strictEqual(r.route, 'picked');
assert.strictEqual(r.dirs.edited, path.join(SAMX2, 'Brand Two', 'Output', 'ACT', 'v1.0', 'edited'));
r = rd({ projectPath: pG, sequenceName: 'Glow v2.0', productPick: 'Kettle' });
assert.strictEqual(r.route, 'picked');
assert.strictEqual(r.product.name, 'Kettle');
// sản phẩm chọn mà không có Output/ → từ chối
r = rd({ projectPath: pG, sequenceName: 'Glow v2.0', productPick: 'Nopout' });
assert.ok(!r.ok && /không có Output\//.test(r.why) && /chọn sản phẩm khác/.test(r.why), r.why);
// sản phẩm đã chọn không còn trong SAMX → từ chối, không lặng lẽ quay về sản phẩm khớp
r = rd({ projectPath: pG, sequenceName: 'Glow v2.0', productPick: 'Renamed Brand' });
assert.ok(!r.ok && r.needPick && /“Renamed Brand”/.test(r.why) && /“Glow Serum”/.test(r.why), r.why);
// thư mục chung chung → không nêu tên
r = rd({ projectPath: proj('Video', 'Projects 2026', 'x.prproj'), sequenceName: 'X v1.0' });
assert.ok(!r.ok && r.needPick && /Không có gì trong đường dẫn/.test(r.why), r.why);
// thư mục lạ → "nhờ Tech tạo"
r = rd({ projectPath: proj('Zebra Cream', 'Video', 'x.prproj'), sequenceName: 'X v1.0' });
assert.ok(!r.ok && /chưa có thư mục cho “Zebra Cream”/.test(r.why), r.why);

// tên khác nhau giữa SAMX và ổ team: "CurvyFlex 2.0" vs "CurvyFlex (BEVA ZoeyFlex v.A) - …"
for (const p of ['CurvyFlex 2.0', 'CurvyLace', 'Cadie 2.0', 'Cadie 3.0']) mk('gd', 'Shared drives', 'SAMX_WORKSPACE', p, 'Output');
const pCurvy = proj('CurvyFlex (BEVA ZoeyFlex v.A) - Side Smoothing Plus Support Bra', 'Videos', 'Editing', 'c.prproj');
// (a) theo tên sequence
r = rd({ projectPath: pCurvy, sequenceName: 'CurvyFlex2.0 vid14.1 [c.ha.ttdo] [hoang]', mode: 'both' });
assert.strictEqual(r.ok, true, r.why);
assert.strictEqual(r.product.name, 'CurvyFlex 2.0');
assert.strictEqual(r.matchedBy, 'sequence');
assert.strictEqual(r.dirs.raw, path.join(SAMX2, 'CurvyFlex 2.0', 'Output', 'ACT', 'v14.1', 'raw'));
// (b) sequence không mang tên sản phẩm → tên gốc bỏ version khớp đầu thư mục project
r = rd({ projectPath: pCurvy, sequenceName: '17.1', mode: 'source' });
assert.strictEqual(r.ok, true, r.why);
assert.strictEqual(r.product.name, 'CurvyFlex 2.0');
assert.strictEqual(r.matchedBy, 'base');
// (c) hai version cùng tên gốc → không đoán, menu đưa cả hai lên đầu
const pCadie = proj('Cadie (old brand) - shapewear', 'v.prproj');
r = rd({ projectPath: pCadie, sequenceName: 'X v1.0' });
assert.ok(!r.ok && r.needPick, r.why);
assert.ok(/2 sản phẩm.*“Cadie 2.0” và “Cadie 3.0”/.test(r.why), r.why);
assert.deepStrictEqual(r.candidates.slice(0, 2), ['Cadie 2.0', 'Cadie 3.0']);
// (d) …nhưng tên sequence chỉ rõ version thì chọn được
r = rd({ projectPath: pCadie, sequenceName: 'Cadie3.0 vid2.0' });
assert.strictEqual(r.ok, true, r.why);
assert.strictEqual(r.product.name, 'Cadie 3.0');

// SAMX_WORKSPACE trong CloudStorage (Drive for desktop) khi không có cạnh ổ chung
const CS = mk('cs');
mk('cs', 'GoogleDrive-someone@example.com', 'Shared drives', 'SAMX_WORKSPACE', 'Glow Serum', 'Output');
const pFar = touch(path.join(T, 'far', 'Shared drives', 'Team Y', 'Glow Serum', 'f.prproj'));
assert.strictEqual(findSamx(pFar, { cloudStorage: CS }), path.join(CS, 'GoogleDrive-someone@example.com', 'Shared drives', 'SAMX_WORKSPACE'));
assert.strictEqual(findSamx(pFar, NO_CLOUD), '');
r = resolveDest({ projectPath: pFar, sequenceName: 'G v3', mode: 'source' }, { cloudStorage: CS });
assert.strictEqual(r.ok, true, r.why);
assert.strictEqual(r.route, 'matched');
// project ngoài mọi ổ chung, không chọn thư mục → needPick
r = rd({ projectPath: touch(path.join(T, 'Desktop', 'p.prproj')), sequenceName: 'X v1.0' });
assert.ok(!r.ok && r.needPick && /chọn thư mục xuất/.test(r.why), r.why);
assert.strictEqual(findSamx(path.join(T, 'Desktop', 'p.prproj'), { cloudStorage: CS }), '');  // không ổ chung → không tìm CloudStorage

// ── thư mục chọn tay ──
const FREE = mk('free');
const pDesk = path.join(T, 'Desktop', 'p.prproj');
r = rd({ projectPath: pDesk, sequenceName: 'X v1.2', chosen: FREE, mode: 'both' });
assert.strictEqual(r.ok, true, r.why);
assert.strictEqual(r.route, 'free');
assert.strictEqual(r.product, null);
assert.strictEqual(r.act, null);
assert.deepStrictEqual(r.dirs, { raw: path.join(FREE, 'v1.2', 'raw'), edited: path.join(FREE, 'v1.2', 'edited') });
// thư mục chọn THẮNG cả sản phẩm của project trong SAMX
r = rd({ projectPath: projA, sequenceName: 'Brand A v1.2', chosen: FREE + '/', mode: 'source' });
assert.strictEqual(r.route, 'free');
assert.strictEqual(r.dirs.raw, path.join(FREE, 'v1.2', 'raw'));
// sequence khác đã ở trong version của thư mục tự do → từ chối như sản phẩm
const fv = mk('free', 'v1.2', 'raw');
touch(path.join(fv, '01_a.mp4'));
fs.writeFileSync(path.join(fv, 'manifest.json'), JSON.stringify({ sequence: { id: 'other', name: 'Other v1.2' }, clips: [{ status: 'ok' }] }));
r = rd({ projectPath: pDesk, sequenceName: 'X v1.2', sequenceId: 'me', chosen: FREE });
assert.ok(!r.ok && /free\/v1.2\/raw\/ đã chứa/.test(r.why) && /“v1.3”/.test(r.why), r.why);
// chọn chính <free>/v1.2/raw → lúc chọn đi lên thành <free>; resolve không tự đi lên
assert.strictEqual(chosenFolder(fv), FREE);
assert.strictEqual(chosenFolder(mk('free', 'v1.2')), FREE);
assert.strictEqual(chosenFolder(mk('free', 'v9')), path.join(FREE, 'v9'));   // v9 rỗng: giữ nguyên
r = rd({ projectPath: pDesk, sequenceName: 'X v2.0', chosen: fv, walk: true });
assert.strictEqual(r.dirs.raw, path.join(FREE, 'v2.0', 'raw'));
r = rd({ projectPath: pDesk, sequenceName: 'X v2.0', chosen: fv });
assert.strictEqual(r.dirs.raw, path.join(fv, 'v2.0', 'raw'));
// thư mục chọn không còn → từ chối, không tạo
r = rd({ projectPath: pDesk, sequenceName: 'X v1.0', chosen: path.join(T, 'gone') });
assert.ok(!r.ok && /không có ở đó/.test(r.why));
assert.ok(!fs.existsSync(path.join(T, 'gone')));
// chọn Output/ACT của một sản phẩm ngoài SAMX → sản phẩm đó
const PRODX = mk('elsewhere', 'Prod X', 'Output', 'ACT');
r = rd({ projectPath: pDesk, sequenceName: 'X v1.0', chosen: PRODX, mode: 'render' });
assert.strictEqual(r.ok, true, r.why);
assert.strictEqual(r.route, 'chosen-product');
assert.strictEqual(r.product.path, path.join(T, 'elsewhere', 'Prod X'));
assert.strictEqual(r.dirs.edited, path.join(PRODX, 'v1.0', 'edited'));
// thư mục có Output/ → sản phẩm
r = rd({ projectPath: pDesk, sequenceName: 'X v1.0', chosen: path.join(T, 'elsewhere', 'Prod X') });
assert.strictEqual(r.route, 'chosen-product');
// chọn một thư mục trong sản phẩm SAMX → sản phẩm đó (không bao giờ là thư mục tự do)
r = rd({ projectPath: pDesk, sequenceName: 'X v1.0', chosen: path.join(SAMX2, 'Kettle', 'Output') });
assert.strictEqual(r.ok, true, r.why);
assert.strictEqual(r.route, 'samx');
assert.strictEqual(r.act, path.join(SAMX2, 'Kettle', 'Output', 'ACT'));
assert.strictEqual(r.samx, SAMX2);
r = rd({ projectPath: pDesk, sequenceName: 'X v1.0', chosen: path.join(SAMX2, 'Nopout') });
assert.ok(!r.ok && /SAMX_WORKSPACE nhưng không có Output\//.test(r.why), r.why);
// chính SAMX_WORKSPACE, hoặc "/" → từ chối
r = rd({ projectPath: pDesk, sequenceName: 'X v1.0', chosen: SAMX2 });
assert.ok(!r.ok && /chính SAMX_WORKSPACE/.test(r.why));
r = rd({ projectPath: pDesk, sequenceName: 'X v1.0', chosen: '/' });
assert.ok(!r.ok && /gốc ổ đĩa/.test(r.why));
// version lỗi với thư mục tự do vẫn bị từ chối
r = rd({ projectPath: pDesk, sequenceName: 'S17', chosen: FREE });
assert.ok(!r.ok && /S17/.test(r.why));

fs.rmSync(T, { recursive: true, force: true });
console.log('✓ rawcut-dest');
