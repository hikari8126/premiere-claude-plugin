// bridge/test/render-block.test.js — khối Render: học thư mục giao từ bộ trước + quy định PIN.
const test = require("node:test");
const assert = require("node:assert");
const F = require("../../plugin/flow-engine.js");
const T = "[a] [b]";
const files = [
  { dir: "Facebook/35x", name: "SP vid35.0 " + T }, { dir: "Facebook/35x", name: "SP vid35.1 " + T },
  { dir: "Google/35x/35.0", name: "SP GG Dọc vid35.0 " + T },            // NFD như Google Drive
  { dir: "Pinterest/Order Sep 29 26", name: "SP vid35.0 " + T + " 2x3 PIN" },
  { dir: "Facebook/5x/draft", name: "5.0" },
];
const seq = (path, name) => ({ path, name, isFolder: false, mediaType: "sequence" });

test("renderDest học theo bộ trước, NFC, PIN theo bin hiện tại, bỏ bộ quá xa", () => {
  assert.strictEqual(F.renderDest(files, "SP vid36.1 " + T, 36, 1).dir, "Facebook/36x");
  assert.strictEqual(F.renderDest(files, "SP GG Dọc vid36.2 " + T, 36, 2).dir, "Google/36x/36.2");
  assert.strictEqual(F.renderDest(files, "SP vid36.0 " + T + " 2x3 PIN", 36, 0, "Sequence / PIN / 36x").dir, "Pinterest/36x");
  assert.strictEqual(F.renderDest(files, "SP vid36.0 " + T + " 2x3 PIN", 36, 0, "Sequence / PIN / Order Oct 05 26").dir, "Pinterest/Order Oct 05 26");
  assert.strictEqual(F.renderDest(files, "36.0", 36, 0), null);
});

test("PIN: bộ trước ở bin bộ → một bộ vào {bộ}x, lẫn bộ → Order <ngày>", () => {
  const items = [seq("Sequence / PIN / Order Sep 29 26", "SP vid34.0 " + T + " 2x3 PIN"), seq("Sequence / PIN / 35x", "SP vid35.0 " + T + " 2x3 PIN")];
  const d = new Date(2026, 9, 5);
  assert.strictEqual(F.platBin(items, "PIN", "36", 0, d, [{ set: "36", idx: 0 }, { set: "36", idx: 1 }]), "Sequence / PIN / 36x");
  assert.strictEqual(F.platBin(items, "PIN", "36", 0, d, [{ set: "36", idx: 0 }, { set: "37", idx: 1 }]), "Sequence / PIN / Order Oct 05 26");
});

test("khối Render trong quy trình GG chỉ render bản GG đã từng render", () => {
  const items = [seq("Sequence / FB / 36x", "SP vid36.0 " + T), seq("Sequence / GG / 36x / 36.0", "36.0"),
                 seq("Sequence / GG / 36x / 36.0", "SP GG Dọc vid36.0 " + T)];
  const ctx = { items, targets: [{ set: "36", idx: 0 }], results: [], platform: "GG", renderFiles: files };
  const rows = F.planStep(F.normStep({ type: "render" }), 1, ctx);
  const by = {}; rows.forEach(r => { by[r.name] = r.dest || r.skip; });
  assert.strictEqual(by["SP GG Dọc vid36.0 " + T], "Google/36x/36.0");
  assert.match(by["SP vid36.0 " + T], /chỉ render GG/);
  assert.match(by["36.0"], /chưa render/);
});

test("tag người làm khác giữa hai bộ vẫn khớp; file bộ này đã có thì bỏ qua", () => {
  const f2 = [{ dir: "Applovin/39x", name: "AeriSoft Applovin vid39.1 [c.trang.vhnguyen] [hoang]" },
              { dir: "Applovin/40x", name: "AeriSoft Applovin vid40.0 [c.uyen.thupham] [hoang]" }];
  assert.strictEqual(F.renderDest(f2, "AeriSoft Applovin vid40.2 [c.uyen.thupham] [hoang]", 40, 2).dir, "Applovin/40x");
  const seq = (path, name) => ({ path, name, isFolder: false, mediaType: "sequence" });
  const items = [0, 1].map(i => seq("Sequence / APP / 40x", "AeriSoft Applovin vid40." + i + " [c.uyen.thupham] [hoang]"));
  const rows = F.planStep(F.normStep({ type: "render" }), 1, { items, targets: [0, 1].map(n => ({ set: "40", idx: n })), results: [], platform: "APP", renderFiles: f2 });
  assert.deepStrictEqual(rows.map(r => [r.dest, !!r.exists]), [["Applovin/40x", true], ["Applovin/40x", false]]);
});

test("chưa có bộ nào đã render (SAMX mới): bản giao vào thư mục nền tảng đang có, bản khác bỏ qua", () => {
  const seq = (path, name) => ({ path, name, isFolder: false, mediaType: "sequence" });
  const items = [seq("Sequence / FB / 40x", "SP vid40.0 [a] [b]"), seq("Sequence / GG / 40x / 40.0", "40.0"),
                 seq("Sequence / GG / 40x / 40.0", "SP GG dọc vid40.0 [a] [b]"), seq("Sequence / PIN / Order Oct 05 26", "SP vid40.0 [a] [b] 2x3 PIN")];
  const dirs = ["ACT", "Applovin", "FB", "GG", "PIN"];
  const run = P => F.planStep(F.normStep({ type: "render" }), 1, { items, targets: [{ set: "40", idx: 0 }], results: [], platform: P, renderFiles: [], renderDirs: dirs })
    .map(r => [r.name, r.dest || r.skip]);
  const gg = Object.fromEntries(run("GG"));
  assert.strictEqual(gg["SP GG dọc vid40.0 [a] [b]"], "GG/40x/40.0");
  assert.match(gg["40.0"], /chưa render/);
  assert.strictEqual(Object.fromEntries(run("FB"))["SP vid40.0 [a] [b]"], "FB/40x");
  assert.strictEqual(Object.fromEntries(run("PIN"))["SP vid40.0 [a] [b] 2x3 PIN"], "PIN/Order Oct 05 26");
  // ổ team đặt tên đầy đủ, chưa có thư mục → Facebook/Google/Pinterest/Applovin
  const r2 = F.planStep(F.normStep({ type: "render" }), 1, { items, targets: [{ set: "40", idx: 0 }], results: [], platform: "GG", renderFiles: [], renderDirs: [] });
  assert.strictEqual(r2.find(r => /GG dọc/.test(r.name)).dest, "Google/40x/40.0");
});
