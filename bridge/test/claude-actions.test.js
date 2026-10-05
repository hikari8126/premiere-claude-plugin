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
  assert.deepStrictEqual(CLA.ACTIONS.slice().sort(), ["autocut_load", "bin_set", "fix_voice_bins", "get_timeline_info", "move_items", "open_tab", "rawcut", "resize", "voicegen_script", "voicegen_sfx"]);
});

test("resize: nền tảng GG/FB/PIN, ratio chuẩn hoá về khoá tab Resize, luôn hỏi xác nhận", () => {
  const r = CLA.check({ action: "resize", platform: "FB", ratios: ["9:16", "4x5", "4-5"], items: ["Sequence / FB / 39x ▸ A vid39.0"] });
  assert.strictEqual(r.mode, "confirm");
  assert.deepStrictEqual(r.action.ratios, ["9-16", "4-5"]);
  assert.deepStrictEqual(CLA.check({ action: "resize", platform: "GG" }).action.items, []);
  assert.match(CLA.check({ action: "resize", platform: "TT" }).error, /GG, FB hoặc PIN/);
  assert.match(CLA.check({ action: "resize", platform: "GG", ratios: ["16:9"] }).error, /16:9/);
  assert.match(CLA.check({ action: "resize", platform: "GG", items: "x" }).error, /danh sách/);
});

test("rawcut: mode source/render/both, luôn hỏi xác nhận", () => {
  assert.strictEqual(CLA.check({ action: "rawcut", mode: "both", items: [] }).mode, "confirm");
  assert.deepStrictEqual(CLA.check({ action: "rawcut", mode: "source" }).action.items, []);
  assert.match(CLA.check({ action: "rawcut", mode: "raw" }).error, /source, render hoặc both/);
});

test("move_items / fix_voice_bins luôn hỏi xác nhận; move_items cần item + to", () => {
  assert.strictEqual(CLA.check({ action: "move_items", moves: [{ item: "Voice Over ▸ 40.0 - A.mp3", to: "Voice Over / 40x" }] }).mode, "confirm");
  assert.match(CLA.check({ action: "move_items", moves: [] }).error, /moves/);
  assert.match(CLA.check({ action: "move_items", moves: [{ item: "x" }] }).error, /item và to/);
  assert.strictEqual(CLA.check({ action: "fix_voice_bins" }).mode, "confirm");
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
