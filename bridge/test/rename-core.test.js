// bridge/test/rename-core.test.js — logic thuần của "Đổi tên source hàng loạt" (tab Watch).
const test = require("node:test");
const assert = require("node:assert");
const RNC = require("../../plugin/rename-core.js");

test("splitExt keeps the extension's case and handles odd names", () => {
  assert.deepStrictEqual(RNC.splitExt("IMG_4821.MOV"), { base: "IMG_4821", ext: ".MOV" });
  assert.deepStrictEqual(RNC.splitExt("a.b.mp4"), { base: "a.b", ext: ".mp4" });
  assert.deepStrictEqual(RNC.splitExt("README"), { base: "README", ext: "" });
  assert.deepStrictEqual(RNC.splitExt(".hidden"), { base: ".hidden", ext: "" });
});

test("natCmp sorts numbers naturally, case-insensitive", () => {
  var a = ["IMG_10.mov", "img_2.mov", "IMG_1.mov"];
  a.sort(RNC.natCmp);
  assert.deepStrictEqual(a, ["IMG_1.mov", "img_2.mov", "IMG_10.mov"]);
});

test("padWidth is at least 2 and grows with the largest number", () => {
  assert.strictEqual(RNC.padWidth(1, 5), 2);
  assert.strictEqual(RNC.padWidth(1, 120), 3);
  assert.strictEqual(RNC.padWidth(95, 10), 3);   // 95..104
  assert.strictEqual(RNC.padWidth(1, 0), 2);
});

test("renderName fills tokens, pads n, trims, leaves unknown tokens", () => {
  assert.strictEqual(RNC.renderName("{bin}_{n}", { bin: "Higg", n: 1, name: "IMG" }, 2), "Higg_01");
  assert.strictEqual(RNC.renderName("{name} v2", { bin: "", n: 3, name: "clip a" }, 2), "clip a v2");
  assert.strictEqual(RNC.renderName("  {n} {x} ", { bin: "", n: 7, name: "" }, 3), "007 {x}");
  assert.strictEqual(RNC.renderName("{bin}{bin}", { bin: "A", n: 1, name: "" }, 2), "AA");
});

test("nameError rejects what macOS / Premiere cannot take", () => {
  assert.strictEqual(RNC.nameError("Higg_01.mov"), "");
  assert.strictEqual(RNC.nameError("Cảnh mở đầu 01.mov"), "");
  assert.ok(RNC.nameError(""));
  assert.ok(RNC.nameError(".mov"));
  assert.ok(RNC.nameError("a/b.mov"));
  assert.ok(RNC.nameError("a:b.mov"));
  assert.ok(RNC.nameError("a\u0007b.mov"));
  assert.ok(RNC.nameError(".hidden.mov"));
  assert.ok(RNC.nameError("ệ".repeat(90) + ".mov"));   // 270 byte UTF-8
});

test("groupByPath merges project items pointing at one file, first-seen order", () => {
  var rows = RNC.groupByPath([
    { path: "/x/b.mov", bin: "B", item: 1, name: "b.mov" },
    { path: "/x/a.mov", bin: "A", item: 2, name: "a.mov" },
    { path: "/x/b.mov", bin: "C", item: 3, name: "b copy" },
  ]);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].path, "/x/b.mov");
  assert.strictEqual(rows[0].oldName, "b.mov");
  assert.strictEqual(rows[0].bin, "B");
  assert.deepStrictEqual(rows[0].items, [1, 3]);
  assert.deepStrictEqual(rows[1].items, [2]);
});

test("sortRows / moveRow return new arrays", () => {
  var rows = [{ oldName: "IMG_10.mov" }, { oldName: "IMG_2.mov" }];
  var s = RNC.sortRows(rows);
  assert.strictEqual(s[0].oldName, "IMG_2.mov");
  assert.strictEqual(rows[0].oldName, "IMG_10.mov");
  var m = RNC.moveRow(s, 1, -1);
  assert.strictEqual(m[0].oldName, "IMG_10.mov");
  assert.strictEqual(RNC.moveRow(s, 0, -1)[0].oldName, "IMG_2.mov");   // out of range: unchanged
});

test("buildPreview numbers rows in order and keeps extensions", () => {
  var rows = [
    { path: "/f/IMG_1.MOV", oldName: "IMG_1.MOV", bin: "Higg" },
    { path: "/f/IMG_2.mp4", oldName: "IMG_2.mp4", bin: "Higg" },
  ];
  var p = RNC.buildPreview(rows, "{bin}_{n}", 1);
  assert.deepStrictEqual(p.map(function (r) { return r.newName; }), ["Higg_01.MOV", "Higg_02.mp4"]);
  assert.ok(p.every(function (r) { return !r.error && !r.same; }));
  var p5 = RNC.buildPreview(rows, "{bin}_{n}", 9);
  assert.deepStrictEqual(p5.map(function (r) { return r.newName; }), ["Higg_09.MOV", "Higg_10.mp4"]);
});

test("buildPreview flags case-insensitive duplicates within the batch on every row", () => {
  var rows = [
    { path: "/f/a.mov", oldName: "a.mov", bin: "X" },
    { path: "/f/b.MOV", oldName: "b.MOV", bin: "x" },
  ];
  var p = RNC.buildPreview(rows, "{bin}", 1);
  assert.ok(p[0].error && p[1].error, "both rows flagged");
});

test("buildPreview: same folder only collides; different folders may share a name", () => {
  var rows = [
    { path: "/f1/a.mov", oldName: "a.mov", bin: "X" },
    { path: "/f2/b.mov", oldName: "b.mov", bin: "X" },
  ];
  var p = RNC.buildPreview(rows, "{bin}", 1);
  assert.ok(!p[0].error && !p[1].error);
});

test("buildPreview marks unchanged names as same and invalid ones as error", () => {
  var rows = [
    { path: "/f/Higg_01.mov", oldName: "Higg_01.mov", bin: "Higg" },
    { path: "/f/q.mov", oldName: "q.mov", bin: "" },
  ];
  var p = RNC.buildPreview(rows, "{bin}_{n}", 1);
  assert.strictEqual(p[0].same, true);
  var p2 = RNC.buildPreview([rows[1]], "{bin}", 1);
  assert.ok(p2[0].error, "empty name is an error");
});
