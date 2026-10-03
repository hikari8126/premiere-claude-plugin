// bridge/test/chat-cli.test.js — tham số Claude CLI cho tab Claude.
const test = require("node:test");
const assert = require("node:assert");
const C = require("../chat-cli.js");

test("chặn chạy lệnh / sửa file, không chặn tìm web + tìm/đọc file", () => {
  for (const t of ["Bash", "Edit", "Write", "NotebookEdit"]) assert.ok(C.BLOCKED_TOOLS.includes(t), t);
  for (const t of C.OPEN_TOOLS) assert.ok(!C.BLOCKED_TOOLS.includes(t), t);
  const args = C.chatArgs({ attachRoot: "/b/.attachments" });
  const i = args.indexOf("--disallowedTools");
  assert.ok(i > 0);
  assert.deepStrictEqual(args.slice(i + 1), C.BLOCKED_TOOLS, "danh sách chặn đứng cuối (cờ nhận nhiều giá trị)");
});

test("projectDirs: thư mục .prproj + thư mục sản phẩm; bỏ đường dẫn lạ/quá nông", () => {
  assert.deepStrictEqual(C.projectDirs("/Users/a/Drive/AeriSoft/Editing File/AeriSoft.prproj"),
    ["/Users/a/Drive/AeriSoft/Editing File", "/Users/a/Drive/AeriSoft"]);
  assert.deepStrictEqual(C.projectDirs("/Users/x.prproj"), [], "không mở /Users");
  assert.deepStrictEqual(C.projectDirs("/Users/a/p.prproj"), [], "không mở cả thư mục nhà");
  assert.deepStrictEqual(C.projectDirs("/Users/a/Work/p.prproj"), ["/Users/a/Work"], "cha /Users/a quá nông → bỏ");
  assert.deepStrictEqual(C.projectDirs("relative/x.prproj"), []);
  assert.deepStrictEqual(C.projectDirs("/a/b/c.txt"), []);
  assert.deepStrictEqual(C.projectDirs(""), []);
});

test("chatArgs: add-dir cho đính kèm + project, model trước danh sách chặn", () => {
  const a = C.chatArgs({ attachRoot: "/b/att", projectPath: "/Users/a/P/Edit/p.prproj", modelArgs: ["--model", "claude-opus-5-5"] });
  assert.deepStrictEqual(a.slice(0, 6), ["--print", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"]);
  const dirs = []; a.forEach((x, i) => { if (x === "--add-dir") dirs.push(a[i + 1]); });
  assert.deepStrictEqual(dirs, ["/b/att", "/Users/a/P/Edit", "/Users/a/P"]);
  assert.ok(a.indexOf("--model") < a.indexOf("--disallowedTools"));
});

test("MCP premiere: cấu hình + cờ --strict-mcp-config, đặt trước danh sách chặn", () => {
  const cfg = C.mcpConfig({ nodePath: "/n", scriptPath: "/b/premiere-mcp.js", bridgeUrl: "http://127.0.0.1:3030", chatId: "c1" });
  assert.deepStrictEqual(cfg, { mcpServers: { premiere: { command: "/n", args: ["/b/premiere-mcp.js"], env: { PREMIERE_BRIDGE_URL: "http://127.0.0.1:3030", PREMIERE_CHAT_ID: "c1" } } } });
  const a = C.chatArgs({ attachRoot: "/b/att", mcpConfigPath: "/tmp/mcp.json" });
  const i = a.indexOf("--mcp-config");
  assert.deepStrictEqual(a.slice(i, i + 3), ["--mcp-config", "/tmp/mcp.json", "--strict-mcp-config"]);
  assert.ok(i < a.indexOf("--disallowedTools"));
  assert.ok(!C.chatArgs({}).includes("--mcp-config"), "không có đường dẫn thì không nạp");
});
