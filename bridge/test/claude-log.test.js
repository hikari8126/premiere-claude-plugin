// bridge/test/claude-log.test.js — nhật ký lệnh tab Claude.
const test = require("node:test");
const assert = require("node:assert");
const L = require("../../plugin/claude-log.js");

test("renderReply ẩn khối actions (cả khối chưa đóng khi đang stream), escape HTML", () => {
  assert.strictEqual(L.renderReply('Đã đẩy script.\n```actions\n[{"action":"x"}]\n```'), "Đã đẩy script.");
  assert.strictEqual(L.renderReply('OK\n```actions\n[{"act'), "OK");
  assert.strictEqual(L.renderReply("```actions\n[]\n```"), "");
  assert.strictEqual(L.renderReply("<b>x</b> **đậm** `code`\ndòng 2"), "&lt;b&gt;x&lt;/b&gt; <strong>đậm</strong> <code>code</code><br>dòng 2");
});

test("pushHistory giữ 20 lệnh mới nhất, không sửa mảng gốc", () => {
  let h = [];
  for (let i = 0; i < 25; i++) h = L.pushHistory(h, { cmd: "c" + i });
  assert.strictEqual(h.length, 20);
  assert.strictEqual(h[0].cmd, "c5");
  assert.strictEqual(h[19].cmd, "c24");
  const base = [{ cmd: "a" }];
  L.pushHistory(base, { cmd: "b" });
  assert.strictEqual(base.length, 1);
  assert.deepStrictEqual(L.pushHistory(null, { cmd: "x" }), [{ cmd: "x" }]);
});

test("toMessages: mỗi lệnh xong = 2 lượt, bỏ lệnh lỗi/chưa có trả lời", () => {
  const m = L.toMessages([{ cmd: "a", raw: "A" }, { cmd: "b", raw: "" }, { cmd: "c", raw: "C" }]);
  assert.deepStrictEqual(m, [
    { role: "user", content: "a" }, { role: "assistant", content: "A" },
    { role: "user", content: "c" }, { role: "assistant", content: "C" }]);
});

test("seqLabel + fmtDur + thinkingText", () => {
  assert.strictEqual(L.seqLabel(null), "Chưa mở sequence");
  assert.strictEqual(L.seqLabel("AeriSoft vid40.0", 32.4), "AeriSoft vid40.0 · 0:32");
  assert.strictEqual(L.seqLabel("X", 0), "X");
  assert.strictEqual(L.fmtDur(65), "1:05");
  assert.strictEqual(L.thinkingText(1), "Clawd đang nghĩ…");
  assert.strictEqual(L.thinkingText(12), "Clawd đang nghĩ… 12s");
  assert.strictEqual(L.thinkingText(75), "Clawd đang nghĩ… 1:15");
});
