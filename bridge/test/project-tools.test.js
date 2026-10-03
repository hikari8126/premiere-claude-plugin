// bridge/test/project-tools.test.js — tool đọc project trả lời từ bản chụp plugin gửi kèm.
const test = require("node:test");
const assert = require("node:assert");
const P = require("../project-tools.js");

const snap = [
  { name: "Voice Over", path: "", isFolder: true, mediaType: "folder" },
  { name: "40x", path: "Voice Over", isFolder: true, mediaType: "folder" },
  { name: "40.0 - Audrey.mp3", path: "Voice Over", isFolder: false, mediaType: "audio" },
  { name: "40.1 - Audrey.mp3", path: "Voice Over / 40x", isFolder: false, mediaType: "audio" },
];

test("sanitize: chỉ giữ trường cần, ép chuỗi, bỏ rác; không phải mảng → null", () => {
  const s = P.sanitize([{ name: 5, path: null, isFolder: 1, mediaType: "audio", item: { x: 1 } }, null, "x"]);
  assert.deepStrictEqual(s, [{ name: "5", path: "", isFolder: true, mediaType: "audio" }]);
  assert.strictEqual(P.sanitize(undefined), null);
});

test("runTool: 3 tool đọc + báo rõ khi thiếu bản chụp / tool lạ", () => {
  assert.match(P.runTool(snap, "project_bins").text, /Voice Over \/ 40x — 1 item/);
  assert.match(P.runTool(snap, "list_bin", { path: "Voice Over" }).text, /^Voice Over ▸ 40\.0 - Audrey\.mp3  \(audio\)$/);
  assert.strictEqual(P.runTool(snap, "list_bin", { path: "Voice Over", recursive: true }).text.split("\n").length, 2);
  assert.match(P.runTool(snap, "find_items", { text: "40.1" }).text, /Voice Over \/ 40x ▸ 40\.1/);
  assert.strictEqual(P.runTool(null, "project_bins").ok, false);
  assert.strictEqual(P.runTool(snap, "move_items").ok, false);
});
