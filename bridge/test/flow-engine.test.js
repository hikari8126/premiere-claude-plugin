// bridge/test/flow-engine.test.js — khối đơn cho quy trình: lập kế hoạch từng bước, nối chuỗi.
const test = require("node:test");
const assert = require("node:assert");
const F = require("../../plugin/flow-engine.js");

const S = (name, path) => ({ name, path, isFolder: false, mediaType: "sequence" });
const D = (name, path) => ({ name, path, isFolder: true, mediaType: "folder" });
const items = [
  S("AeriSoft vid39.0 [c.uyen] [hoang]", "Sequence / FB / 39x"),
  S("AeriSoft vid39.1 [c.uyen] [hoang]", "Sequence / FB / 39x"),
  S("AeriSoft vid40.0 [c.trang] [hoang]", "Sequence / FB / 40x"),
  S("AeriSoft vid40.1 [c.trang] [hoang]", "Sequence / FB / 40x"),
  D("39.1", "Sequence / GG / 39x"),
  S("39.1", "Sequence / GG / 39x / 39.1"),
  S("39.1 4x5 GG", "Sequence / GG / 39x / 39.1"),
  S("AeriSoft GG Dọc vid39.1 [c.uyen] [hoang]", "Sequence / GG / 39x / 39.1"),
  S("AeriSoft AppLovin vid39.0 [c.uyen] [hoang]", "Sequence / APP / 39x"),
];
const run = (steps, targets) => F.planFlow(items, steps.map(F.normStep), targets, new Date(2026, 9, 5));

test("NAV bộ mới 41: tạo bin như bộ trước + sequence tên học theo FB bộ trước (tag bộ trước)", () => {
  const p = run([
    { type: "bin_make", bin: { k: "prev", ref: { k: "base" } } },
    { type: "seq_make", name: { k: "learn", ref: { k: "base" } }, frame: "prev", bin: { k: "step", n: 1 } },
  ], [{ set: "41", idx: 0 }, { set: "41", idx: 1 }]);
  assert.deepStrictEqual(p[0].rows.map(r => r.bin), ["Sequence / FB / 41x", "Sequence / FB / 41x"]);
  assert.deepStrictEqual(p[1].rows.map(r => r.name), ["AeriSoft vid41.0 [c.trang] [hoang]", "AeriSoft vid41.1 [c.trang] [hoang]"]);
  assert.strictEqual(p[1].rows[0].bin, "Sequence / FB / 41x");
  assert.strictEqual(p[1].rows[0].like.name, "AeriSoft vid40.0 [c.trang] [hoang]");
  assert.strictEqual(p[1].rows[0].exists, false);
});

test("GG bộ 40: bin {bộ}.{số}, nhân bản FB gốc tên {bộ}.{số}, resize kết quả bước 2, khung Dọc từ bộ trước", () => {
  const p = run([
    { type: "bin_make", bin: { k: "tpl", text: "Sequence / GG / {bộ}x / {bộ}.{số}" } },
    { type: "seq_clone", src: { k: "base" }, name: { k: "tpl", text: "{bộ}.{số}" }, bin: { k: "step", n: 1 } },
    { type: "seq_resize", src: { k: "step", n: 2 }, ratio: "prev", platform: "prev", bin: { k: "src" } },
    { type: "seq_clone", src: { k: "prev", ref: { k: "match", text: "GG Dọc" } }, name: { k: "learn", ref: { k: "match", text: "GG Dọc" } }, bin: { k: "step", n: 1 } },
  ], [{ set: "40", idx: 1 }]);
  assert.strictEqual(p[0].rows[0].bin, "Sequence / GG / 40x / 40.1");
  assert.deepStrictEqual([p[1].rows[0].name, p[1].rows[0].bin, p[1].rows[0].src.name], ["40.1", "Sequence / GG / 40x / 40.1", "AeriSoft vid40.1 [c.trang] [hoang]"]);
  assert.strictEqual(p[2].rows[0].src.step, 2);
  assert.strictEqual(p[2].rows[0].bin, "Sequence / GG / 40x / 40.1");
  assert.deepStrictEqual([p[2].rows[0].ratios, p[2].rows[0].platform], [["4-5"], "GG"]);   // học từ "39.1 4x5 GG"
  assert.strictEqual(p[3].rows[0].name, "AeriSoft GG Dọc vid40.1 [c.uyen] [hoang]");          // tên học bộ trước giữ tag bộ trước
  assert.strictEqual(p[3].rows[0].src.name, "AeriSoft GG Dọc vid39.1 [c.uyen] [hoang]");
});

test("PIN: bin Order {ngày}, resize 2:3 FB gốc vào bin bước 1; APP: nhân bản AppLovin bộ trước", () => {
  const pin = run([
    { type: "bin_make", bin: { k: "tpl", text: "Sequence / PIN / Order {ngày}" } },
    { type: "seq_resize", src: { k: "base" }, ratio: "2-3", platform: "PIN", bin: { k: "step", n: 1 } },
  ], [{ set: "40", idx: 0 }]);
  assert.strictEqual(pin[0].rows[0].bin, "Sequence / PIN / Order Oct 05 26");
  assert.strictEqual(pin[1].rows[0].bin, "Sequence / PIN / Order Oct 05 26");
  assert.strictEqual(pin[1].rows[0].name, "AeriSoft vid40.0 [c.trang] [hoang] 2x3 PIN");
  assert.strictEqual(pin[1].rows[0].exists, false);
  const pinOld = F.planFlow(items.concat([S("AeriSoft vid40.0 [c.trang] [hoang] 2x3 PIN", "Sequence / PIN / Order Sep 29 26")]),
    [{ type: "bin_make", bin: { k: "tpl", text: "Sequence / PIN / Order {ngày}" } }, { type: "seq_resize", src: { k: "base" }, ratio: "2-3", platform: "PIN", bin: { k: "step", n: 1 } }].map(F.normStep),
    [{ set: "40", idx: 0 }], new Date(2026, 9, 5));
  assert.deepStrictEqual([pinOld[1].rows[0].exists, pinOld[1].rows[0].where], [true, "Sequence / PIN / Order Sep 29 26"]);   // đã có ở đơn cũ
  const app = run([
    { type: "bin_make", bin: { k: "prev", ref: { k: "match", text: "AppLovin" } } },
    { type: "seq_clone", src: { k: "prev", ref: { k: "match", text: "AppLovin" } }, name: { k: "learn", ref: { k: "match", text: "AppLovin" } }, bin: { k: "step", n: 1 } },
  ], [{ set: "40", idx: 0 }]);
  assert.strictEqual(app[0].rows[0].bin, "Sequence / APP / 40x");
  assert.strictEqual(app[1].rows[0].name, "AeriSoft AppLovin vid40.0 [c.uyen] [hoang]");
});

test("lỗi rõ ràng: thiếu nguồn, thiếu biến, chưa có bộ trước; đã có → exists", () => {
  const p = run([{ type: "seq_clone", src: { k: "base" }, name: { k: "tpl", text: "{bộ}.{số}" }, bin: { k: "tpl", text: "X" } }], [{ set: "77", idx: 0 }]);
  assert.match(p[0].rows[0].error, /không thấy FB gốc/);
  const q = run([{ type: "seq_clone", src: { k: "prev", ref: { k: "match", text: "GG Vuông" } }, name: { k: "tpl", text: "a" }, bin: { k: "src" } }], [{ set: "40", idx: 0 }]);
  assert.match(q[0].rows[0].error, /chưa có "GG Vuông" ở bộ trước/);
  const ex = run([{ type: "seq_clone", src: { k: "base" }, name: { k: "tpl", text: "39.1" }, bin: { k: "src" } }], [{ set: "40", idx: 0 }]);
  assert.strictEqual(ex[0].rows[0].exists, true);
  assert.deepStrictEqual(F.problems(F.normStep({ type: "bin_make" })), ["đường dẫn bin"]);
});

test("subst + chips", () => {
  assert.strictEqual(F.subst("Sequence / GG / 39x / 39.1", { set: 39, idx: 1 }, { set: 40, idx: 2 }), "Sequence / GG / 40x / 40.2");
  assert.strictEqual(F.subst("X vid39.1 [a]", { set: 39, idx: 1 }, { set: 40, idx: 0 }), "X vid40.0 [a]");
  const c = F.chips(F.normStep({ type: "seq_resize", src: { k: "step", n: 2 }, ratio: "other", platform: "GG" }));
  assert.deepStrictEqual(c.map(x => x.text), ["Resize", "kết quả bước 2", "ratio còn lại", "GG", "cùng bin nguồn"]);
});
