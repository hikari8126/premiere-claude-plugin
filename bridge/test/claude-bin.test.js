// bridge/test/claude-bin.test.js — tìm `claude` bằng đường dẫn tuyệt đối (launchd không có PATH của shell).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const C = require("../claude-bin.js");

test("findSync thấy claude ở ~/.npm-global/bin, ~/.local/bin, nvm", () => {
  for (const rel of [[".npm-global", "bin"], [".local", "bin"], [".nvm", "versions", "node", "v22.1.0", "bin"]]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cb-"));
    const dir = path.join(home, ...rel);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "claude");
    fs.writeFileSync(f, "#!/bin/sh\necho 2.1.0\n"); fs.chmodSync(f, 0o755);
    // nvm xếp sau bản hệ thống (/opt/homebrew, /usr/local) — máy có cả hai thì dùng bản hệ thống
    if (rel[0] === ".nvm") assert.ok(C.candidates(home).includes(f));
    else assert.strictEqual(C.findSync(home), f);
  }
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cb-"));
  const got = C.findSync(empty);
  assert.ok(got === "" || got.startsWith("/opt/homebrew") || got.startsWith("/usr/local"));   // máy CI có thể có bản hệ thống
});

test("withPath thêm thư mục của claude vào PATH", () => {
  const e = C.withPath({ PATH: "/usr/bin:/bin" });
  assert.ok(e.PATH.endsWith("/usr/bin:/bin"));
  assert.ok(e.PATH.includes(".npm-global/bin"));
});
