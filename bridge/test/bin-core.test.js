// bridge/test/bin-core.test.js — đọc / sắp bin cho tab Claude.
const test = require("node:test");
const assert = require("node:assert");
const B = require("../../plugin/bin-core.js");

const F = (path, name) => ({ path, name, isFolder: true, mediaType: "folder" });
const A = (path, name) => ({ path, name, isFolder: false, mediaType: "audio" });
const V = (path, name) => ({ path, name, isFolder: false, mediaType: "video" });
const project = [
  F("", "Voice Over"), F("Voice Over", "39x"), F("Voice Over", "40x"), F("", "Footage"), F("", "Sequence"),
  A("Voice Over / 39x", "39.0 - Audrey.mp3"),
  A("Voice Over / 39x", "40.1 - AeriSoft.mp3"),        // sai bộ
  A("Voice Over", "40.0 - Audrey.mp3"),                // nằm ngoài bin con
  A("", "38.2 - Bustella.mp3"),                        // ở gốc
  A("Footage", "41.0 - Evelyn.wav"),                   // bin khác
  A("Voice Over / 40x", "40.2 - Audrey.mp3"),          // đúng
  A("Voice Over / 40x", "BGM chill.mp3"),              // không có số phiên bản
  V("Footage", "40.0 - b-roll.mov"),                   // video → bỏ qua
];

test("samePath: không phân biệt hoa thường/khoảng trắng; VO ≡ Voice Over ở cấp đầu", () => {
  assert.ok(B.samePath("voice over / 40X", "Voice Over / 40x"));
  assert.ok(B.samePath("VO / 40x", "Voice Over / 40x"));
  assert.ok(!B.samePath("Footage / VO", "Footage / Voice Over"), "chỉ cấp đầu mới coi là bí danh");
  assert.ok(!B.samePath("Voice Over", "Voice Over / 40x"));
  assert.ok(B.under("Voice Over / 40x / old", "Voice Over"));
});

test("refOf / parseRef đi một vòng, kể cả item ở gốc", () => {
  const r = B.refOf(project[6]);
  assert.strictEqual(r, "Voice Over / 39x ▸ 40.1 - AeriSoft.mp3");
  assert.deepStrictEqual(B.parseRef(r), { path: "Voice Over / 39x", name: "40.1 - AeriSoft.mp3" });
  assert.deepStrictEqual(B.parseRef(B.refOf(project[8])), { path: "", name: "38.2 - Bustella.mp3" });
});

test("binTree: mỗi bin một dòng kèm số item trực tiếp", () => {
  const t = B.binTree(project);
  assert.match(t, /^\(gốc project\) — 1 item/);
  assert.match(t, /Voice Over \/ 40x — 2 item/);
  assert.match(t, /Footage — 2 item/);
});

test("listBin: trực tiếp / đệ quy; findItems theo tên", () => {
  assert.strictEqual(B.listBin(project, "voice over / 39X").split("\n").length, 2);
  assert.strictEqual(B.listBin(project, "Voice Over", true).split("\n").length, 5);
  assert.match(B.listBin(project, "Sequence"), /không có item/);
  assert.match(B.findItems(project, "audrey"), /Voice Over \/ 39x ▸ 39\.0 - Audrey\.mp3  \(audio\)/);
  assert.match(B.findItems(project, "xyz"), /Không có/);
});

test("planVoiceMoves: voice có số phiên bản sai bin / ngoài bin chuẩn → bin Voice Over / Nx", () => {
  const p = B.planVoiceMoves(project);
  assert.deepStrictEqual(p.map(m => [m.name, m.from, m.to]), [
    ["40.1 - AeriSoft.mp3", "Voice Over / 39x", "Voice Over / 40x"],
    ["40.0 - Audrey.mp3", "Voice Over", "Voice Over / 40x"],
    ["38.2 - Bustella.mp3", "(gốc)", "Voice Over / 38x"],
    ["41.0 - Evelyn.wav", "Footage", "Voice Over / 41x"],
  ]);
  assert.deepStrictEqual(B.voiceTarget(A("x", "040.3 -  Ann.mp3")), { set: "40", idx: "3", bin: "Voice Over / 40x" });
  assert.strictEqual(B.voiceTarget(A("x", "40.3.mp3")), null, "thiếu ' - <tên voice>'");
});

test("resolveMoves: khớp item theo bin + tên; báo lỗi rõ khi không có / trùng / đã đúng bin", () => {
  const dup = project.concat([A("Voice Over", "40.0 - Audrey.mp3")]);
  const r = B.resolveMoves(dup, [
    { item: "Voice Over / 39x ▸ 40.1 - AeriSoft.mp3", to: "Voice Over / 40x" },
    { item: "Voice Over ▸ 40.0 - Audrey.mp3", to: "Voice Over / 40x" },
    { item: "Footage ▸ không có.mp3", to: "Voice Over / 40x" },
    { item: "Voice Over / 40x ▸ 40.2 - Audrey.mp3", to: "voice over / 40X" },
    { item: "▸ 38.2 - Bustella.mp3", to: "" },
  ]);
  assert.strictEqual(r[0].index, 6);
  assert.strictEqual(r[0].error, "");
  assert.match(r[1].error, /trùng tên/);
  assert.match(r[2].error, /không tìm thấy/);
  assert.match(r[3].error, /đúng bin/);
  assert.match(r[4].error, /bin đích/);
});
