// bridge/test/cl-fix.test.js — Claude sửa khối quy trình theo project (kiểm bản sửa bằng xem trước).
const test = require("node:test");
const assert = require("node:assert");
global.localStorage = { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); } };
const CLFIX = require("../../plugin/cl-fix.js");

const seq = (path, name) => ({ path, name, isFolder: false, mediaType: "sequence" });
const items = [
  seq("Facebook / 35x", "SP vid35.0 [a] [b]"), seq("Facebook / 36x", "SP vid36.0 [a] [b]"),
  seq("Google / 35x", "35.0"), seq("Google / 35x", "SP Google Vertical vid35.0 [a] [b]"),
];
const flow = { id: "f1", name: "GG cũ", steps: [
  { type: "bin_make", bin: { k: "tpl", text: "Sequence / GG / {bộ}x" } },
  { type: "seq_clone", src: { k: "prev", ref: { k: "match", text: "GG Dọc" } }, name: { k: "learn", ref: { k: "match", text: "GG Dọc" } }, bin: { k: "step", n: 1 } },
] };
const targets = [{ set: "36", idx: 0 }];

test("bản gốc lỗi, bản Claude sửa hết lỗi thì được dùng + lưu theo project", () => {
  const pv = CLFIX.plan(items, flow.steps, targets);
  assert.ok(CLFIX.errorCount(pv) > 0);
  const req = CLFIX.request(items, flow, pv);
  assert.ok(req.errors.length && req.bins.length && req.seqs.length);
  const ai = [
    { type: "bin_make", bin: { k: "tpl", text: "Google / {bộ}x" } },
    { type: "seq_clone", src: { k: "prev", ref: { k: "match", text: "Google Vertical" } }, name: { k: "learn", ref: { k: "match", text: "Google Vertical" } }, bin: { k: "step", n: 1 } },
  ];
  const acc = CLFIX.accept(items, flow, ai, targets);
  assert.ok(acc, "phải nhận bản sửa");
  assert.strictEqual(acc.errors, 0);
  CLFIX.remember("/p/a.prproj", flow, { steps: acc.steps, note: "đổi GG → Google" });
  const f = CLFIX.applied("/p/a.prproj", flow);
  assert.strictEqual(f.steps[0].bin.text, "Google / {bộ}x");
  assert.strictEqual(f.fixedNote, "đổi GG → Google");
  assert.strictEqual(CLFIX.applied("/p/khac.prproj", flow), flow);   // project khác không dùng
});

test("bản Claude sửa không tốt hơn thì bỏ", () => {
  assert.strictEqual(CLFIX.accept(items, flow, flow.steps, targets), null);
  assert.strictEqual(CLFIX.accept(items, flow, [], targets), null);
  assert.strictEqual(CLFIX.accept(items, flow, "rác", targets), null);
});
