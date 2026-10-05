// bridge/test/cl-queue.test.js — project đã biết + hàng đợi nhiều project (tab Claude).
const test = require("node:test");
const assert = require("node:assert");
const Q = require("../../plugin/cl-queue.js");

const A = "/Drive/AeriSoft/Videos/Editing File/AeriSoft.prproj";
const S = "/Drive/SonaShape/Videos/Editing File/SonaShape.prproj";

test("seeProject: mới nhất lên đầu, bỏ trùng theo đường dẫn, bỏ đường dẫn không phải .prproj", () => {
  let l = Q.seeProject([], A, 1);
  l = Q.seeProject(l, S, 2);
  l = Q.seeProject(l, A, 3);
  assert.deepStrictEqual(l.map(p => [p.name, p.last]), [["AeriSoft", 3], ["SonaShape", 2]]);
  assert.strictEqual(Q.seeProject(l, "/x/untitled", 4).length, 2);
});

test("hàng đợi: thêm, bỏ trùng việc đang chờ, đánh dấu, dọn việc xong", () => {
  let q = Q.add([], { path: S, flowId: "raw", flowName: "RAW", set: "35" }).queue;
  assert.strictEqual(Q.add(q, { path: S, flowId: "raw", set: "35" }).added, false);
  q = Q.add(q, { path: A, flowId: "raw", set: "40", idxs: [2, 0, 2] }).queue;
  q = Q.add(q, { path: S, flowId: "gg", set: "36" }).queue;
  assert.strictEqual(q.length, 3);
  assert.deepStrictEqual(q[1].idxs, [0, 2]);
  assert.strictEqual(Q.add(q, { path: S, flowId: "raw", set: "x" }).added, false);
  const first = Q.next(q);
  q = Q.mark(q, first.id, "ok", "xong");
  assert.strictEqual(Q.next(q).set, "40");
  assert.strictEqual(Q.clearDone(q).length, 2);
  assert.strictEqual(Q.remove(q, first.id).length, 2);
});

test("plan: gom việc theo project để ít lần chuyển nhất; recover đưa việc đang chạy về chờ", () => {
  let q = [];
  for (const [p, s] of [[S, "35"], [A, "40"], [S, "36"], [A, "41"]]) q = Q.add(q, { path: p, flowId: "raw", set: s }).queue;
  assert.deepStrictEqual(Q.plan(q).map(x => x.set), ["35", "36", "40", "41"]);
  q = Q.mark(q, q[0].id, "run");
  assert.strictEqual(Q.recover(q)[0].status, "wait");
});

test("parseTargets: số bộ / vid lẻ, một bộ mỗi việc", () => {
  assert.deepStrictEqual(Q.parseTargets("35"), { set: "35", idxs: [] });
  assert.deepStrictEqual(Q.parseTargets("vid35.2, 35.0"), { set: "35", idxs: [0, 2] });
  assert.deepStrictEqual(Q.parseTargets("35x"), { set: "35", idxs: [] });
  assert.match(Q.parseTargets("35.0 36.1").error, /một bộ/);
  assert.match(Q.parseTargets("abc").error, /không phải/);
  assert.strictEqual(Q.targetText({ set: "35", idxs: [0, 2] }), "vid35.0, vid35.2");
  assert.strictEqual(Q.targetText({ set: "35", idxs: [] }), "cả bộ 35");
});
