// bridge/test/chat-prompt.test.js — prompt tab Claude (2 chế độ) khớp whitelist của plugin.
const test = require("node:test");
const assert = require("node:assert");
const { SYSTEM_PROMPT, FREE_PROMPT, promptFor } = require("../chat-prompt.js");
const CLA = require("../../plugin/claude-actions.js");

test("cả hai chế độ nhắc đủ action whitelist và mọi tab open_tab nhận", () => {
  for (const p of [SYSTEM_PROMPT, FREE_PROMPT]) {
    for (const a of CLA.ACTIONS) assert.ok(p.includes(a), a);
    for (const t of CLA.TABS) assert.ok(p.includes(t), t);
  }
});

test("không nhắc action đã gỡ (plugin chặn)", () => {
  for (const a of ["move_clip", "trim_clip", "set_volume", "apply_effect", "cutlist", "cut_clip", "add_marker", "add_subtitle"]) {
    assert.ok(!SYSTEM_PROMPT.includes(a) && !FREE_PROMPT.includes(a), a);
    assert.strictEqual(CLA.check({ action: a }).ok, false);
  }
});

test("dặn hỏi trước khi gen tốn credit; nói rõ không chạy lệnh / không sửa file", () => {
  for (const p of [SYSTEM_PROMPT, FREE_PROMPT]) {
    assert.match(p, /autoGenerate: true khi họ nói rõ "gen luôn"/);
    assert.match(p, /KHÔNG chạy lệnh, KHÔNG sửa\/xoá\/tạo file/);
  }
});

test("chế độ: Lệnh ngắn, Hỏi tự do research có nguồn", () => {
  assert.match(SYSTEM_PROMPT, /chế độ "Lệnh"/);
  assert.match(SYSTEM_PROMPT, /1–2 câu/);
  assert.match(FREE_PROMPT, /chế độ "Hỏi tự do"/);
  assert.match(FREE_PROMPT, /tìm trên web/);
  assert.match(FREE_PROMPT, /\[tên\]\(url\)/);
  assert.strictEqual(promptFor("free"), FREE_PROMPT);
  assert.strictEqual(promptFor("command"), SYSTEM_PROMPT);
  assert.strictEqual(promptFor(undefined), SYSTEM_PROMPT);
});
