// bridge/test/act-log.test.js — nhật ký việc làm + chuỗi việc lặp theo bộ.
const test = require("node:test");
const assert = require("node:assert");
const A = require("../../plugin/act-log.js");

const ev = (set, act, p, t) => A.entry("x", act, "SP vid" + set + ".0 [a]", p || {}, "/p.prproj", t);

test("entry đọc bộ/video, bỏ đường dẫn", () => {
  const e = A.entry("resize", "resize", "SP vid36.1 [a]", { platform: "GG", dir: "/Users/x" }, "/p");
  assert.strictEqual(e.set, "36"); assert.strictEqual(e.idx, 1);
  assert.deepStrictEqual(e.p, { platform: "GG" });
});

test("patterns tìm chuỗi lặp ở ≥3 bộ", () => {
  let t = 1;
  const list = [];
  ["33", "34", "35"].forEach(s => {
    list.push(ev(s, "voice_import", {}, t++), ev(s, "autocut", {}, t++), ev(s, "subtext", {}, t++),
              ev(s, "resize", { platform: "GG" }, t++), ev(s, "rawcut", { mode: "both" }, t++));
  });
  list.push(ev("36", "resize", { platform: "PIN" }, t++));
  const p = A.patterns(list, "/p.prproj");
  assert.strictEqual(p.length, 1);
  assert.deepStrictEqual(p[0].steps, ["voice_import", "autocut", "subtext", "resize GG", "rawcut both"]);
  assert.strictEqual(p[0].support, 3);
  const d = A.digest(list, "/p.prproj");
  assert.strictEqual(d.sets.length, 4);
  assert.ok(d.patterns[0].indexOf("3 bộ") > 0);
});

test("ít hơn 3 bộ thì chưa có mẫu", () => {
  assert.deepStrictEqual(A.patterns([ev("1", "a", {}, 1), ev("1", "b", {}, 2), ev("2", "a", {}, 3), ev("2", "b", {}, 4)], "/p.prproj"), []);
});
