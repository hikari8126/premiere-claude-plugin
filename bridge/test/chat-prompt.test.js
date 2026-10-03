// bridge/test/chat-prompt.test.js — prompt tab Claude khớp whitelist của plugin.
const test = require("node:test");
const assert = require("node:assert");
const { SYSTEM_PROMPT } = require("../chat-prompt.js");
const CLA = require("../../plugin/claude-actions.js");

test("prompt nhắc đủ mọi action trong whitelist và mọi tab open_tab nhận", () => {
  for (const a of CLA.ACTIONS) assert.ok(SYSTEM_PROMPT.includes(a), a);
  for (const t of CLA.TABS) assert.ok(SYSTEM_PROMPT.includes(t), t);
});

test("prompt không nhắc action đã gỡ (plugin chặn)", () => {
  for (const a of ["move_clip", "trim_clip", "set_volume", "apply_effect", "cutlist", "cut_clip", "add_marker", "add_subtitle"]) {
    assert.ok(!SYSTEM_PROMPT.includes(a), a);
    assert.strictEqual(CLA.check({ action: a }).ok, false);
  }
});

test("prompt dặn hỏi trước khi gen tốn credit", () => {
  assert.match(SYSTEM_PROMPT, /autoGenerate: true khi họ nói rõ "gen luôn"/);
});
