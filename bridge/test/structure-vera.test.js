// bridge/test/structure-vera.test.js — quy trình chạy trên cấu trúc bin KHÁC chuẩn (VeraComfort 2026-10-06):
// Timeline / Facebook / v3 / {bộ}x · Timeline / Google / {bộ}x (resize "… 9x16 GG") · Timeline / Pinterest / {bộ}x
// · Timeline / Applovin / {bộ}x ("… vid 19.0 [..] Applovin" — chữ loại đứng CUỐI tên).
const test = require("node:test");
const assert = require("node:assert");
const PPF = require("../../plugin/proj-profile.js");
const F = require("../../plugin/flow-engine.js");
const B = require("../../plugin/binset-core.js");
const T = "[c.phuong][tung]";
const seq = (path, name) => ({ path, name, isFolder: false, mediaType: "sequence" });
const items = [];
for (const s of [21, 22]) {
  for (const i of [0, 1, 2]) {
    items.push(seq(`Timeline / Facebook / v3 / ${s}x`, `Veracomfort vid ${s}.${i} ${T}`));
    items.push(seq(`Timeline / Applovin / ${s}x`, `Veracomfort vid ${s}.${i} ${T} Applovin`));
    for (const r of ["9x16", "16x9", "1x1"]) items.push(seq(`Timeline / Google / ${s}x`, `Veracomfort vid ${s}.${i} ${T} ${r} GG`));
  }
  items.push(seq(`Timeline / Pinterest / ${s}x`, `Veracomfort vid ${s}.0 ${T} 2x3 PIN`));
}
for (const i of [0, 1, 2]) items.push(seq("Timeline / Facebook / v3 / 23x", `Veracomfort vid 23.${i} ${T}`));
const plan = (steps, tg) => F.planFlow(items, steps.map(F.normStep), tg, new Date(2026, 9, 6));

test("hồ sơ + PIN/APP/GG theo cấu trúc project, không ghi cứng 'Sequence / …'", () => {
  PPF.use(PPF.scan(items));
  try {
    const pin = plan([{ type: "platform", p: "PIN" }, { type: "bin_make" }], [{ set: "23", idx: 0 }, { set: "23", idx: 1 }]);
    assert.strictEqual(pin[1].rows[0].bin, "Timeline / Pinterest / 23x");
    const mixed = plan([{ type: "platform", p: "PIN" }, { type: "bin_make" }], [{ set: "22", idx: 0 }, { set: "23", idx: 1 }]);
    assert.strictEqual(mixed[1].rows[0].bin, "Timeline / Pinterest / Order Oct 06 26");
    const app = plan([{ type: "platform", p: "APP" }, { type: "bin_make" }, { type: "seq_clone", src: { k: "plat" } }], [{ set: "23", idx: 1 }]);
    assert.strictEqual(app[1].rows[0].bin, "Timeline / Applovin / 23x");
    assert.strictEqual(app[2].rows[0].name, `Veracomfort vid 23.1 ${T} Applovin`);
    // FB gốc không lẫn bản Applovin / GG đuôi
    assert.deepStrictEqual(Object.keys(B.fbSources(items, "22")).sort(), ["0", "1", "2"]);
    assert.ok(Object.values(B.fbSources(items, "22")).every(x => !/Applovin|GG/.test(x.name)));
    // GG kiểu resize: ratio học từ tên đuôi "… 9x16 GG" trong bin Google
    const sp = B.res2Spec(items, "GG", "23", 0);
    assert.deepStrictEqual([sp.from, sp.ratios.sort()], [22, ["1-1", "16-9", "9-16"]]);
  } finally { PPF.use(null); }
});

test("GG khung cứng trên cấu trúc VeraComfort: material vào Draft, 3 đích 9x16/16x9/1x1 GG vào bin bộ", () => {
  const it2 = items.concat([{ name: "Draft", path: "Timeline / Google / 22x", isFolder: true, mediaType: "" }]);
  PPF.use(PPF.scan(it2));
  try {
    const p = F.planFlow(it2, [{ type: "platform", p: "GG" }, { type: "bin_make" }, { type: "seq_clone", src: { k: "base" } },
      { type: "seq_resize", src: { k: "step", n: 3 } }, { type: "seq_clone", src: { k: "plat" } }].map(F.normStep), [{ set: "23", idx: 0 }], new Date(2026, 9, 6));
    assert.strictEqual(p[1].rows[0].bin, "Timeline / Google / 23x");
    assert.deepStrictEqual([p[2].rows[0].name, p[2].rows[0].bin, !!p[2].rows[0].exists], [`Veracomfort vid 23.0 ${T}`, "Timeline / Google / 23x / Draft", false]);
    assert.deepStrictEqual([p[3].rows[0].ratio, p[3].rows[0].bin], ["other", "Timeline / Google / 23x / Draft"]);
    assert.deepStrictEqual(p[4].rows.map(r => r.name), ["9x16", "16x9", "1x1"].map(r => `Veracomfort vid 23.0 ${T} ${r} GG`));
    assert.ok(p[4].rows.every(r => r.bin === "Timeline / Google / 23x"));
  } finally { PPF.use(null); }
});

test("APP bộ trước nằm bin không số bộ → theo mẫu {bộ}x của hồ sơ", () => {
  const its = [seq("Sequence / FB / 15x", "LC vid15.0 [a]"), seq("Sequence / Applovin", "LC Applovin vid14.0 [a]"),
               seq("Sequence / Applovin / 13x", "LC Applovin vid13.0 [a]"), seq("Sequence / Applovin / 12x", "LC Applovin vid12.0 [a]")];
  PPF.use(PPF.scan(its));
  try { assert.strictEqual(F.platBin(its, "APP", "15", 0), "Sequence / Applovin / 15x"); } finally { PPF.use(null); }
});

test("PIN nương theo bộ PIN gần nhất: bin đơn → đơn hôm nay, bin bộ → bộ mới, tên học theo bộ trước", () => {
  const d = new Date(2026, 9, 6);
  const order = [seq("Sequence / FB / 35x", "SP vid35.0 [a]"), seq("Sequence / PIN / Order Sep 29 26", "SP vid34.0 [a] 2x3 PIN")];
  assert.strictEqual(F.platBin(order, "PIN", "35", 0, d, [{ set: "35", idx: 0 }]), "Sequence / PIN / Order Oct 06 26");
  const bySet = [seq("Sequence / FB / 8x", "LC vid8.0 [a]"), seq("Sequence / PIN / 7.x", "LC PIN vid7.0 [a]")];
  assert.strictEqual(F.platBin(bySet, "PIN", "8", 0, d, [{ set: "8", idx: 0 }]), "Sequence / PIN / 8.x");
  const p = F.planFlow(bySet, [{ type: "platform", p: "PIN" }, { type: "seq_resize", src: { k: "base" }, bin: { k: "plat" } }].map(F.normStep), [{ set: "8", idx: 0 }], d);
  assert.deepStrictEqual([p[1].rows[0].name, p[1].rows[0].bin, p[1].rows[0].ratio], ["LC PIN vid8.0 [a]", "Sequence / PIN / 8.x", "2-3"]);
});
