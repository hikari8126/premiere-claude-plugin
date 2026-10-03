// bridge/test/cl-custom.test.js — tuỳ biến tab Claude: nút/quy trình, biến, xuất nhập, tự học.
const test = require("node:test");
const assert = require("node:assert");
const CLC = require("../../plugin/cl-custom.js");

const SEQ = "AeriSoft vid40.0 [c.uyen] [hoang]";

test("vars + fill: lấy bộ / sản phẩm từ tên sequence, báo biến thiếu", () => {
  const v = CLC.vars(SEQ);
  assert.strictEqual(v["bộ"], "40");
  assert.strictEqual(v["sản phẩm"], "AeriSoft");
  assert.deepStrictEqual(CLC.fill("resize bộ {bộ} của {sản phẩm}", v), { text: "resize bộ 40 của AeriSoft", missing: [] });
  assert.deepStrictEqual(CLC.fill("bộ {bộ}", CLC.vars("Sequence 01")).missing, ["bộ"]);
});

test("normalize bỏ mục hỏng, chuẩn hoá bước quy trình", () => {
  const d = CLC.normalize({ buttons: [
    { name: "A", prompt: "x" },
    { name: "", prompt: "x" },
    { name: "B", kind: "flow", steps: [{ type: "resize", platform: "FB", ratios: ["4-5", "7-7"] }, { type: "rm -rf" }] },
    { name: "C", kind: "flow", steps: [{ type: "bogus" }] },
  ], notes: "n" });
  assert.deepStrictEqual(d.buttons.map(b => b.name), ["A", "B"]);
  assert.deepStrictEqual(d.buttons[1].steps, [{ type: "resize", platform: "FB", ratios: ["4-5"], scope: "current" }]);
  assert.strictEqual(CLC.fromLegacy([{ name: "Cũ", prompt: "mở RAW" }]).buttons[0].prompt, "mở RAW");
});

test("stepAction: scope bộ → ref các sequence gốc của bộ (bỏ bản đã resize)", () => {
  const items = [
    { name: "AeriSoft vid40.0 [a]", path: "Sequence / FB / 40x", isFolder: false, mediaType: "sequence" },
    { name: "AeriSoft vid40.1 [a]", path: "Sequence / FB / 40x", isFolder: false, mediaType: "sequence" },
    { name: "AeriSoft vid40.1 [a] 4x5 FB", path: "Sequence / FB / 40x", isFolder: false, mediaType: "sequence" },
    { name: "AeriSoft vid400.1", path: "x", isFolder: false, mediaType: "sequence" },
    { name: "vid40.0.mp4", path: "x", isFolder: false, mediaType: "video" },
  ];
  const r = CLC.stepAction({ type: "rawcut", mode: "both", scope: "set" }, { vars: CLC.vars(SEQ), items });
  assert.deepStrictEqual(r.action.items, ["Sequence / FB / 40x ▸ AeriSoft vid40.0 [a]", "Sequence / FB / 40x ▸ AeriSoft vid40.1 [a]"]);
  const rz = CLC.stepAction({ type: "resize", platform: "FB", ratios: ["4-5"], scope: "current" }, { vars: CLC.vars(SEQ), items });
  assert.deepStrictEqual(rz.action, { action: "resize", platform: "FB", ratios: ["4:5"], items: [] });
  assert.match(CLC.stepAction({ type: "rawcut", mode: "both", scope: "set" }, { vars: CLC.vars("x"), items }).error, /không biết bộ/);
  assert.deepStrictEqual(CLC.stepAction({ type: "prompt", text: "soát bộ {bộ}" }, { vars: CLC.vars(SEQ) }), { prompt: "soát bộ 40" });
});

test("xuất / nhập: gộp bỏ trùng, thay thế, file lạ báo lỗi", () => {
  const cur = { buttons: [{ id: "1", name: "A", prompt: "x" }], notes: "dòng 1" };
  const file = CLC.exportData({ buttons: [{ id: "1", name: "A", prompt: "x" }, { id: "2", name: "B", prompt: "y" }], notes: "dòng 1\ndòng 2" });
  const m = CLC.importData(cur, file, "merge");
  assert.strictEqual(m.added, 1);
  assert.deepStrictEqual(m.data.buttons.map(b => b.name), ["A", "B"]);
  assert.strictEqual(m.data.notes, "dòng 1\ndòng 2");
  const r = CLC.importData(cur, CLC.exportData({ buttons: [{ name: "Z", prompt: "z" }] }, { buttons: true }), "replace");
  assert.deepStrictEqual(r.data.buttons.map(b => b.name), ["Z"]);
  assert.strictEqual(r.data.notes, "dòng 1");                    // file không có ghi chú → giữ
  assert.match(CLC.importData(cur, "{}", "merge").error, /không phải bộ tuỳ biến/);
  assert.match(CLC.importData(cur, "abc", "merge").error, /JSON/);
});

test("ghi chú: thêm dòng, bỏ trùng, giới hạn; parse khối remember", () => {
  assert.deepStrictEqual(CLC.addNote("", "Voice nằm trong VO"), { notes: "Voice nằm trong VO", ok: true });
  assert.strictEqual(CLC.addNote("Voice nằm trong VO", "voice nằm trong vo").ok, false);
  assert.strictEqual(CLC.addNote("x".repeat(1499), "dài").ok, false);
  assert.deepStrictEqual(CLC.parseRemember("Ok.\n```remember\n- Bin voice tên VO\n```"), ["Bin voice tên VO"]);
});

test("tự học: lệnh gõ lặp 3 lần (khác số bộ) → gợi ý nút có {bộ}", () => {
  let h = CLC.habitsEmpty();
  h = CLC.recordCmd(h, "resize bộ 39 sang 4x5", CLC.vars("X vid39.0"), 1);
  h = CLC.recordCmd(h, "resize bộ 40 sang 4x5", CLC.vars("X vid40.0"), 2);
  assert.strictEqual(CLC.suggest(h, CLC.empty()), null);
  h = CLC.recordCmd(h, "resize bộ 41 sang 4x5", CLC.vars("X vid41.2"), 3);
  const s = CLC.suggest(h, CLC.empty());
  assert.strictEqual(s.kind, "prompt");
  assert.strictEqual(s.text, "resize bộ {bộ} sang 4x5");
  assert.strictEqual(CLC.suggest(h, { buttons: [{ name: "R", prompt: "resize bộ {bộ} sang 4x5" }] }), null);
  assert.strictEqual(CLC.suggest(CLC.decline(h, s.key), CLC.empty()), null);
});

test("tự học: resize rồi RAW liền nhau 3 lần → gợi ý quy trình", () => {
  let h = CLC.habitsEmpty(), t = 0;
  for (let i = 0; i < 3; i++) {
    h = CLC.recordAction(h, { action: "resize", platform: "FB", ratios: ["4-5"], items: [] }, t += 1000);
    h = CLC.recordAction(h, { action: "rawcut", mode: "both", items: ["a", "b"] }, t += 1000);
    t += 60 * 60 * 1000;                                     // lượt sau cách xa → không nối rawcut>resize
  }
  const s = CLC.suggest(h, CLC.empty());
  assert.strictEqual(s.kind, "flow");
  assert.deepStrictEqual(s.steps.map(x => x.type), ["resize", "rawcut"]);
  assert.strictEqual(s.steps[1].scope, "set");
  assert.strictEqual(CLC.suggestName(s), "Resize FB → RAW");
});

test("projectFacts: bin voice / sequence theo mẫu {bộ}", () => {
  const items = [
    { name: "39.0 - Audrey.mp3", path: "VO / 39x", isFolder: false, mediaType: "audio" },
    { name: "40.1 - Audrey.mp3", path: "VO / 40x", isFolder: false, mediaType: "audio" },
    { name: "AeriSoft vid40.0 [a]", path: "Sequence / FB / 40x", isFolder: false, mediaType: "sequence" },
    { name: "AeriSoft vid39.0 [a]", path: "Sequence / FB / 39x", isFolder: false, mediaType: "sequence" },
  ];
  const f = CLC.projectFacts(items, SEQ);
  assert.match(f, /Sản phẩm.*AeriSoft, bộ 40/);
  assert.match(f, /bin: VO \/ \{bộ\}x/);
  assert.match(f, /Sequence \/ FB \/ \{bộ\}x/);
  assert.match(f, /Các bộ đã có: 39, 40/);
  assert.strictEqual(CLC.projectFacts([], SEQ), "");
});
