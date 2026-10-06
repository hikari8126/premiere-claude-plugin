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

test("chế độ: Giao việc ngắn, Hỏi đáp research có nguồn", () => {
  assert.match(SYSTEM_PROMPT, /chế độ "Giao việc"/);
  assert.match(SYSTEM_PROMPT, /1–2 câu/);
  assert.match(FREE_PROMPT, /chế độ "Hỏi đáp"/);
  assert.match(FREE_PROMPT, /tìm trên web/);
  assert.match(FREE_PROMPT, /\[tên\]\(url\)/);
  assert.ok(promptFor("free").startsWith(FREE_PROMPT));
  assert.ok(promptFor("command").startsWith(SYSTEM_PROMPT));
  assert.ok(promptFor(undefined).startsWith(SYSTEM_PROMPT));
});

test("prompt mô tả tool đọc project + quy ước bin voice; tool khớp MCP premiere", () => {
  const { TOOLS } = require("../premiere-mcp.js");
  for (const p of [SYSTEM_PROMPT, FREE_PROMPT]) {
    for (const tl of TOOLS) assert.ok(p.includes(tl.name), tl.name);
    assert.match(p, /Voice Over \/ Nx/);
    assert.match(p, /▸/);
  }
});

test("prompt mô tả luồng resize (GG/FB/PIN, tên bản mới) + RAW (raw/ edited/, tự bấm XUẤT)", () => {
  for (const p of [SYSTEM_PROMPT, FREE_PROMPT]) {
    assert.match(p, /GG \(Google: 9:16 \/ 4:5 \/ 1:1\)/);
    assert.match(p, /" 4x5 FB"/);
    assert.match(p, /Output\/ACT\/<vN>\/raw\//);
    assert.match(p, /tự bấm XUẤT/);
  }
});

test("prompt dạy khối remember; ghi chú + quy ước project nối cuối, cắt độ dài", () => {
  const { memberContext } = require("../chat-prompt.js");
  assert.match(promptFor("command"), /```remember/);
  assert.match(promptFor("free"), /```remember/);
  assert.strictEqual(memberContext("", ""), "");
  const m = memberContext("Voice tên VO", "- Sản phẩm: AeriSoft");
  assert.match(m, /Ghi chú riêng của bro[\s\S]*Voice tên VO/);
  assert.match(m, /Quy ước plugin đọc được[\s\S]*AeriSoft/);
  assert.ok(memberContext("x".repeat(5000), "").length < 1700);
});

test("prompt mô tả bin_set (GG/PIN, bin Sequence / GG / 40x / 40.N)", () => {
  for (const p of [SYSTEM_PROMPT, FREE_PROMPT]) {
    assert.match(p, /bin_set \{platform, set\?, idxs\?\}/);
    assert.match(p, /Sequence \/ GG \/ 40x \/ 40\.N/);
  }
  assert.strictEqual(CLA.check({ action: "bin_set", platform: "GG", set: "40" }).mode, "confirm");
  assert.strictEqual(CLA.check({ action: "bin_set", platform: "FB" }).ok, false);
});
