// bridge/chat-cli.js — tham số `claude --print` cho tab Claude. Thuần, test ở
// test/chat-cli.test.js.
//
// Tool: mở tìm web (WebSearch, WebFetch) + tìm/đọc file (Read, Glob, Grep) + MCP premiere (đọc
// bin/item trong project) cho cả hai chế độ;
// chặn chạy lệnh / sửa file / sub-agent. CLI chạy --permission-mode bypassPermissions (không
// ai bấm "cho phép" trong panel) nên mọi thứ ghi/chạy được trên máy member đều phải chặn ở đây.
// Thư mục được đọc: thư mục đính kèm + thư mục chứa .prproj + thư mục sản phẩm (cấp cha).

const path = require('path');

const BLOCKED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Task', 'Agent', 'KillShell', 'BashOutput'];
const OPEN_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

// "/a/Sản phẩm/Editing File/x.prproj" → ["/a/Sản phẩm/Editing File", "/a/Sản phẩm"].
// Bỏ qua đường dẫn rỗng / tương đối / gốc ổ đĩa (không cho đọc cả "/" hay "/Volumes").
function projectDirs(prprojPath) {
  const p = String(prprojPath || '');
  if (!p || !path.isAbsolute(p) || !/\.prproj$/i.test(p)) return [];
  const depth = d => d.split(path.sep).filter(Boolean).length;
  const dir = path.dirname(p), parent = path.dirname(dir);
  return [dir, parent].filter(d => depth(d) >= 3);    // ≥ /Users/<user>/<thư mục>
}

// Cấu hình MCP "premiere" (premiere-mcp.js): tool đọc project Premiere qua plugin.
function mcpConfig(o) {
  return { mcpServers: { premiere: {
    command: o.nodePath, args: [o.scriptPath],
    env: { PREMIERE_BRIDGE_URL: o.bridgeUrl, PREMIERE_CHAT_ID: o.chatId },
  } } };
}

function chatArgs(o) {
  const args = ['--print', '--output-format', 'stream-json', '--verbose',
                '--permission-mode', 'bypassPermissions'];
  [o.attachRoot].concat(projectDirs(o.projectPath)).filter(Boolean)
    .forEach(d => args.push('--add-dir', d));
  // Chỉ nạp MCP premiere — không kéo các MCP server khác trên máy member (chậm, lộ tool lạ).
  if (o.mcpConfigPath) args.push('--mcp-config', o.mcpConfigPath, '--strict-mcp-config');
  (o.modelArgs || []).forEach(a => args.push(a));
  args.push('--disallowedTools');
  BLOCKED_TOOLS.forEach(t => args.push(t));
  return args;
}

module.exports = { BLOCKED_TOOLS, OPEN_TOOLS, projectDirs, mcpConfig, chatArgs };
