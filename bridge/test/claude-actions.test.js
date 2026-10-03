// bridge/test/claude-actions.test.js — whitelist action của tab Claude.
const test = require("node:test");
const assert = require("node:assert");
const CLA = require("../../plugin/claude-actions.js");

test("parse nhiều khối ```actions, bỏ khối JSON hỏng / phần tử không phải object", () => {
  const t = 'a\n```actions\n[{"action":"open_tab","tab":"voicegen"}, 3]\n```\nb\n```actions\n{oops\n```\n```actions\n{"action":"get_timeline_info"}\n```';
  assert.deepStrictEqual(CLA.parse(t).map(a => a.action), ["open_tab", "get_timeline_info"]);
  assert.deepStrictEqual(CLA.parse(""), []);
});

test("danh sách action cho phép", () => {
  assert.deepStrictEqual(CLA.ACTIONS.sort(), ["autocut_load", "get_timeline_info", "open_tab", "voicegen_script", "voicegen_sfx"]);
});

test("voicegen_script / sfx: autoGenerate=true → confirm (tốn credit), không thì auto; thiếu text → lỗi", () => {
  assert.strictEqual(CLA.check({ action: "voicegen_script", text: "hi", autoGenerate: true }).mode, "confirm");
  assert.strictEqual(CLA.check({ action: "voicegen_script", text: "hi" }).mode, "auto");
  assert.strictEqual(CLA.check({ action: "voicegen_sfx", text: "pop", autoGenerate: true }).mode, "confirm");
  assert.match(CLA.check({ action: "voicegen_script", text: "  " }).error, /script/);
  assert.match(CLA.check({ action: "voicegen_sfx" }).error, /SFX/);
});

test("open_tab chỉ nhận tab có thật; autocut_load cần rows", () => {
  assert.strictEqual(CLA.check({ action: "open_tab", tab: "rawcut" }).ok, true);
  assert.match(CLA.check({ action: "open_tab", tab: "photoshop" }).error, /tab/);
  assert.match(CLA.check({ action: "autocut_load", rows: [] }).error, /rows/);
  assert.strictEqual(CLA.check({ action: "autocut_load", rows: [{ script: "a" }] }).mode, "auto");
});

test("action cũ sửa timeline / chưa làm bị chặn, không sửa object gốc", () => {
  for (const a of ["move_clip", "trim_clip", "set_volume", "apply_effect", "cut_clip", "cutlist", "add_subtitle", "add_marker", "create_set", "qc_run", undefined]) {
    assert.match(CLA.check({ action: a }).error, /không hỗ trợ/, String(a));
  }
  const orig = { action: "open_tab", tab: "voicegen" };
  const r = CLA.check(orig);
  assert.notStrictEqual(r.action, orig);
});
