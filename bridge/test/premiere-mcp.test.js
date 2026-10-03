// bridge/test/premiere-mcp.test.js — MCP server cho tab Claude (giao thức + chạy thật qua stdio).
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { spawn } = require("child_process");
const { TOOLS, createHandler } = require("../premiere-mcp.js");

test("handshake + tools/list + tools/call + lỗi", async () => {
  const calls = [];
  const h = createHandler(async (name, args) => { calls.push([name, args]); return { ok: true, text: "kết quả " + name }; });
  const init = await h({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.strictEqual(init.result.protocolVersion, "2025-06-18");
  assert.deepStrictEqual(init.result.capabilities, { tools: {} });
  assert.strictEqual(await h({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const list = await h({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepStrictEqual(list.result.tools.map(t => t.name), ["project_bins", "list_bin", "find_items"]);
  const call = await h({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_bin", arguments: { path: "Voice Over" } } });
  assert.deepStrictEqual(call.result, { content: [{ type: "text", text: "kết quả list_bin" }], isError: false });
  assert.deepStrictEqual(calls, [["list_bin", { path: "Voice Over" }]]);
  const bad = await h({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "move_items", arguments: {} } });
  assert.match(bad.error.message, /Không có tool/);
  const fail = await createHandler(async () => { throw new Error("plugin chưa mở"); })({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "project_bins" } });
  assert.strictEqual(fail.result.isError, true);
  assert.match(fail.result.content[0].text, /plugin chưa mở/);
});

test("chỉ có tool đọc — không tool nào thay đổi project", () => {
  for (const t of TOOLS) assert.ok(!/move|delete|rename|import|create/i.test(t.name), t.name);
});

test("chạy thật qua stdio: một dòng vào, một dòng ra", async () => {
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "premiere-mcp.js")], { env: { ...process.env, PREMIERE_BRIDGE_URL: "http://127.0.0.1:1" } });
  const out = await new Promise((resolve, reject) => {
    let buf = "";
    proc.stdout.on("data", d => { buf += d; if (buf.includes("\n")) resolve(JSON.parse(buf.split("\n")[0])); });
    proc.on("error", reject);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }) + "\n");
  });
  proc.kill();
  assert.strictEqual(out.id, 7);
  assert.strictEqual(out.result.tools.length, 3);
});
