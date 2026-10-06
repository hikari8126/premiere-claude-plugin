// bridge/test/cl-suggest.test.js — gợi ý quy trình: chuẩn hoá + xem trước, lưu theo project, áp dụng.
const test = require("node:test");
const assert = require("node:assert");
global.localStorage = { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); } };
const S = require("../../plugin/cl-suggest.js");

const seq = (path, name) => ({ path, name, isFolder: false, mediaType: "sequence" });
const items = [
  seq("Sequence / FB / 35x", "SP vid35.0 [a] [b]"), seq("Sequence / FB / 36x", "SP vid36.0 [a] [b]"),
  seq("Sequence / GG / 35x / 35.0", "35.0"), seq("Sequence / GG / 35x / 35.0", "SP GG dọc vid35.0 [a] [b]"),
  seq("Sequence / GG / 35x / 35.0", "SP GG ngang vid35.0 [a] [b]"), seq("Sequence / GG / 35x / 35.0", "SP GG vuông vid35.0 [a] [b]"),
];
const good = { name: "GG + RAW", why: "bộ nào cũng làm GG rồi xuất RAW", steps: [
  { type: "platform", p: "GG" }, { type: "bin_make" }, { type: "seq_clone", src: { k: "plat" } },
  { type: "raw_export", src: { k: "base" }, mode: "both" }] };

test("check: gợi ý tốt qua, gợi ý lỗi / trùng bị loại", () => {
  const c = S.check(items, good, []);
  assert.ok(!c.error, c.error);
  assert.strictEqual(c.set, "36");
  assert.ok(S.check(items, { name: "x", steps: [{ type: "seq_clone", src: { k: "prev", ref: { k: "match", text: "Không Có" } } }] }, []).error);
  assert.ok(S.check(items, good, [{ name: "GG", steps: c.steps }]).error);   // đã có
  assert.ok(S.check(items, { name: "x", steps: [{ type: "lạ" }] }, []).error);
});

test("lưu theo project, bỏ qua thì không hiện lại, áp dụng thêm/thay", () => {
  const c = S.check(items, good, []);
  S.add("/p", [c], "sig1");
  assert.strictEqual(S.pending("/p").length, 1);
  assert.strictEqual(S.askedSig("/p"), "sig1");
  S.drop("/p", c.hash, true);
  S.add("/p", [c]);
  assert.strictEqual(S.pending("/p").length, 0);
  const data = { buttons: [{ id: "a", name: "GG", kind: "flow", steps: [{ type: "wait" }] }] };
  const r1 = S.apply(data, Object.assign({}, c, { replaces: "GG" }), "replace");
  assert.strictEqual(r1.data.buttons[0].steps.length, 4);
  assert.deepStrictEqual(r1.undo.steps, [{ type: "wait" }]);
  const r2 = S.apply(data, Object.assign({}, c, { name: "GG" }), "new");
  assert.strictEqual(r2.added, "GG 2");
});
