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
