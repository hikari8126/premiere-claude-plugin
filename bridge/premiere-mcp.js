// bridge/premiere-mcp.js — MCP server (stdio) cho tab Claude: cho Claude ĐỌC project Premiere.
//
// Claude CLI chạy file này làm tiến trình con (--mcp-config, xem chat-cli.js). Lời gọi tool đi:
//   Claude → (stdio) server này → POST bridge /chat/tool-call → bridge trả lời từ bản chụp bin/item
//   plugin gửi kèm lượt /chat (project-tools.js) → trả về Claude.
// Chỉ có tool ĐỌC. Việc thay đổi project (chuyển item…) đi bằng khối action + thẻ xác nhận.
// Không phụ thuộc thư viện: JSON-RPC 2.0, mỗi dòng một message (MCP stdio transport).

const TOOLS = [
  {
    name: 'project_bins',
    description: 'Cây bin của project Premiere đang mở: mỗi bin một dòng ("A / B / C — N item", N = số item trực tiếp). Gọi trước để biết cấu trúc.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_bin',
    description: 'Liệt kê item trong một bin. Mỗi dòng: "<bin> ▸ <tên>  (loại)" — dùng nguyên chuỗi "<bin> ▸ <tên>" làm item khi đề xuất chuyển (action move_items). path rỗng = gốc project.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Đường dẫn bin, các cấp nối bằng " / ", vd "Voice Over / 40x"' },
        recursive: { type: 'boolean', description: 'true = gồm cả bin con' },
      },
      required: ['path'], additionalProperties: false,
    },
  },
  {
    name: 'find_items',
    description: 'Tìm item trong cả project theo một phần tên (không phân biệt hoa thường). Trả dòng "<bin> ▸ <tên>  (loại)".',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Chữ có trong tên item' } },
      required: ['text'], additionalProperties: false,
    },
  },
];

// Xử lý một message JSON-RPC. callTool(name, args) → Promise<{ok, text}>.
// Trả về object response, hoặc null với notification (không có id).
function createHandler(callTool) {
  return async function handle(msg) {
    if (!msg || typeof msg !== 'object') return null;
    const id = msg.id;
    const reply = result => ({ jsonrpc: '2.0', id, result });
    if (id === undefined || id === null) return null;                     // notification
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'premiere', version: '1.0.0' },
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = msg.params && msg.params.name;
        if (!TOOLS.some(t => t.name === name)) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Không có tool ' + name } };
        }
        let r;
        try { r = await callTool(name, (msg.params && msg.params.arguments) || {}); }
        catch (e) { r = { ok: false, text: e.message }; }
        return reply({ content: [{ type: 'text', text: String((r && r.text) || '') }], isError: !(r && r.ok) });
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Không hỗ trợ ' + msg.method } };
    }
  };
}

// Gọi bridge (đang giữ kết nối SSE với plugin của lượt chat này).
function bridgeCaller(bridgeUrl, chatId) {
  return async function (name, input) {
    const res = await fetch(bridgeUrl + '/chat/tool-call', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, name, input }),
    });
    const j = await res.json().catch(() => ({}));
    return { ok: !!j.ok, text: j.text || j.error || ('bridge lỗi HTTP ' + res.status) };
  };
}

function main() {
  const handle = createHandler(bridgeCaller(process.env.PREMIERE_BRIDGE_URL || 'http://127.0.0.1:3030', process.env.PREMIERE_CHAT_ID || ''));
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      handle(msg).then(out => { if (out) process.stdout.write(JSON.stringify(out) + '\n'); });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (require.main === module) main();

module.exports = { TOOLS, createHandler };
