// bridge/test/binset-core.test.js — khối "Dựng bin GG / PIN": lập kế hoạch bin + sequence theo mẫu.
const test = require("node:test");
const assert = require("node:assert");
const BSC = require("../../plugin/binset-core.js");

const S = (name, path) => ({ name, path, isFolder: false, mediaType: "sequence" });
const items = [
  S("AeriSoft vid40.0 [c.uyen] [hoang]", "Sequence / FB / 40x"),
  S("AeriSoft vid40.1 [c.uyen] [hoang]", "Sequence / FB / 40x"),
  S("AeriSoft vid40.1 [c.uyen] [hoang] 4x5 FB", "Sequence / FB / 40x"),
  S("AeriSoft vid400.1", "x"),
  // bộ 39 đã dựng đúng chuẩn (ảnh của user)
  S("39.1", "Sequence / GG / 39x / 39.1"),
  S("39.1 4x5 FB", "Sequence / GG / 39x / 39.1"),
  S("AeriSoft GG dọc vid39.1 [c.uyen] [hoang]", "Sequence / GG / 39x / 39.1"),
  S("AeriSoft GG ngang vid39.1 [c.uyen] [hoang]", "Sequence / GG / 39x / 39.1"),
  // bộ 38 có "vuông", 39 không → vuông lấy bộ gần nhất có nó
  S("AeriSoft GG vuông vid38.1 [c.uyen] [hoang]", "Sequence / GG / 38x / 38.1"),
  S("AeriSoft GG dọc vid38.1 [c.uyen] [hoang]", "Sequence / GG / 38x / 38.1"),
  // đã có sẵn cho 40.0
  S("40.0", "Sequence / GG / 40x / 40.0"),
];

test("tên bản đích: chèn nền tảng + loại trước vid", () => {
  assert.strictEqual(BSC.targetName("AeriSoft vid40.1 [a] [b]", "GG", "dọc"), "AeriSoft GG dọc vid40.1 [a] [b]");
  assert.strictEqual(BSC.targetName("Sequence 01", "GG", "dọc"), "");
  assert.strictEqual(BSC.binPath("GG", "40", 1), "Sequence / GG / 40x / 40.1");
});

test("nguồn FB gốc: bỏ bản resize, bản GG/PIN, bộ khác", () => {
  const src = BSC.fbSources(items, "40");
  assert.deepStrictEqual(Object.keys(src), ["0", "1"]);
  assert.strictEqual(src[1].name, "AeriSoft vid40.1 [c.uyen] [hoang]");
});

test("kế hoạch: bản đích lấy từ bộ gần nhất có loại đó", () => {
  const p = BSC.plan(items, { platform: "GG", set: "40", idxs: [1] });
  assert.ok(p.ok);
  const r = p.rows[0];
  assert.strictEqual(r.bin, "Sequence / GG / 40x / 40.1");
  assert.deepStrictEqual(r.res1, { name: "40.1", exists: false });
  assert.strictEqual(r.res2.exists, false);
  const by = Object.fromEntries(r.targets.map(t => [t.label, t]));
  assert.strictEqual(by["dọc"].from.set, 39);
  assert.strictEqual(by["ngang"].from.set, 39);
  assert.strictEqual(by["vuông"].from.set, 38);
  assert.strictEqual(by["dọc"].name, "AeriSoft GG dọc vid40.1 [c.uyen] [hoang]");
});

test("chưa có bản cũ / template → from null; template ưu tiên", () => {
  const few = items.filter(i => !/vuông/.test(i.name));
  const p = BSC.plan(few, { platform: "GG", set: "40", idxs: [1] });
  assert.strictEqual(p.rows[0].targets.find(t => t.label === "vuông").from, null);
  const t = BSC.plan(few, { platform: "GG", set: "40", idxs: [1], templates: { "vuông": "Template ▸ Khung vuông" } });
  assert.deepStrictEqual(t.rows[0].targets.find(t => t.label === "vuông").from, { kind: "template", ref: "Template ▸ Khung vuông" });
});

test("đã có thì đánh dấu exists; cả bộ = mọi video FB gốc; tóm tắt", () => {
  const p = BSC.plan(items, { platform: "GG", set: "40" });
  assert.deepStrictEqual(p.rows.map(r => r.idx), [0, 1]);
  assert.strictEqual(p.rows[0].res1.exists, true);
  const sm = BSC.summary(p);
  assert.strictEqual(sm.have, 1);
  assert.strictEqual(sm.bad, 0);
});

test("lỗi: thiếu bộ, nền tảng sai, video không có nguồn", () => {
  assert.match(BSC.plan(items, { platform: "GG", set: "" }).error, /chưa biết bộ/);
  assert.match(BSC.plan(items, { platform: "FB", set: "40" }).error, /GG hoặc PIN/);
  assert.match(BSC.plan(items, { platform: "GG", set: "40", idxs: [5] }).rows[0].error, /không thấy/);
});

test("PIN: không có loại mặc định, lấy theo bộ trước", () => {
  const p = BSC.plan(items.concat([S("AeriSoft PIN dọc vid39.1 [x]", "Sequence / PIN / 39x / 39.1")]), { platform: "PIN", set: "40", idxs: [1] });
  assert.deepStrictEqual(p.rows[0].targets.map(t => t.label), ["dọc"]);
  assert.strictEqual(p.rows[0].bin, "Sequence / PIN / 40x / 40.1");
});

test("dữ liệu thật SonaShape: bản resize đuôi GG, nhãn viết hoa giữ nguyên", () => {
  const its = [
    S("SonaShape vid36.0 [a] [b]", "Sequence / FB / 36x"),
    S("35.0", "Sequence / GG / 35x / 35.0"),
    S("35.0 4x5 GG", "Sequence / GG / 35x / 35.0"),
    S("35.0 1x1 GG", "Sequence / GG / 35x / 35.0"),
    S("SonaShape GG Dọc vid35.0 [a] [b]", "Sequence / GG / 35x / 35.0"),
    S("36.0", "Sequence / GG / 36x / 36.0"),
    S("36.0 4x5 GG", "Sequence / GG / 36x / 36.0"),
  ];
  const r = BSC.plan(its, { platform: "GG", set: "36" }).rows[0];
  assert.strictEqual(r.res2.exists, true);
  const doc = r.targets.find(t => t.label === "dọc");
  assert.strictEqual(doc.name, "SonaShape GG Dọc vid36.0 [a] [b]");
  assert.strictEqual(doc.from.set, 35);
  assert.strictEqual(r.targets.find(t => t.label === "ngang").from, null);
  const r37 = BSC.plan(its.concat([S("SonaShape vid37.0 [a]", "Sequence / FB / 37x")]), { platform: "GG", set: "37" }).rows[0];
  assert.deepStrictEqual(r37.res2.spec, { platform: "GG", ratios: ["4-5"], from: 36 });   // bộ gần nhất là 36
  assert.deepStrictEqual(BSC.res2Spec([], "GG", "40", 1), { platform: "FB", ratios: [] });
});

test("APP: nhân bản bản AppLovin (template) của bộ gần nhất, đổi tên theo FB gốc", () => {
  const its = [
    S("SonaShape vid36.0 [a] [b]", "Sequence / FB / 36x"),
    S("SonaShape vid36.1 [a] [b]", "Sequence / FB / 36x"),
    S("SonaShape vid36.2 [a] [b]", "Sequence / FB / 36x"),
    S("SonaShape AppLovin vid34.2 [a] [b]", "Sequence / APP / 34x"),
    S("SonaShape AppLovin vid35.0 [a] [b]", "Sequence / APP / 35x"),
    S("SonaShape AppLovin vid35.1 [a] [b]", "Sequence / APP / 35x"),
    S("SonaShape AppLovin vid36.1 [a] [b]", "Sequence / APP / 36x"),
  ];
  const p = BSC.planApp(its, { set: "36" });
  const r = p.rows;
  assert.strictEqual(r[0].bin, "Sequence / APP / 36x");
  assert.strictEqual(r[0].name, "SonaShape AppLovin vid36.0 [a] [b]");
  assert.deepStrictEqual([r[0].from.set, r[0].from.name], [35, "SonaShape AppLovin vid35.0 [a] [b]"]);
  assert.strictEqual(r[1].exists, true);
  assert.strictEqual(r[2].from.name, "SonaShape AppLovin vid35.0 [a] [b]");   // bộ 35 không có .2 → video khác của bộ gần nhất
  assert.strictEqual(BSC.planApp(its, { set: "36", template: "T ▸ Khung APP" }).rows[0].from.kind, "template");
  assert.strictEqual(BSC.planApp([S("X vid1.0 [a]", "Sequence / FB / 1x")], { set: "1" }).rows[0].from, null);
  assert.match(BSC.planApp(its, { set: "" }).error, /chưa biết bộ/);
});

test("PIN theo đơn: tên '… 2x3 PIN', bin Order <ngày>, đã có ở đơn cũ thì báo", () => {
  assert.strictEqual(BSC.orderName(new Date(2026, 9, 5)), "Order Oct 05 26");
  assert.strictEqual(BSC.pinName("SonaShape vid35.0 [a] [b]"), "SonaShape vid35.0 [a] [b] 2x3 PIN");
  const its = [
    S("SonaShape vid35.0 [a]", "Sequence / FB / 35x"),
    S("SonaShape vid35.1 [a]", "Sequence / FB / 35x"),
    S("SonaShape vid35.0 [a] 2x3 PIN", "Sequence / PIN / Order Sep 29 26"),
  ];
  const p = BSC.planPin(its, { set: "35", date: new Date(2026, 9, 5) });
  assert.strictEqual(p.bin, "Sequence / PIN / Order Oct 05 26");
  assert.deepStrictEqual(p.rows.map(r => [r.idx, r.exists]), [[0, true], [1, false]]);
  assert.strictEqual(p.rows[0].where, "Sequence / PIN / Order Sep 29 26");
  assert.strictEqual(BSC.planPin(its, { set: "35", order: "Order 1" }).bin, "Sequence / PIN / Order 1");
});
