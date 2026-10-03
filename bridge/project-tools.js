// bridge/project-tools.js — trả lời tool đọc project (MCP premiere / vòng lặp API key) từ BẢN CHỤP
// danh sách bin/item plugin gửi kèm mỗi lượt /chat. Không hỏi ngược plugin giữa chừng: UXP xếp
// hàng request tới bridge khi stream /chat còn mở → POST kết quả từ plugin không tới được (kẹt
// 60s mỗi lần gọi tool). Quét project trong plugin chỉ ~0.1s nên chụp sẵn rẻ hơn nhiều.
//
// Logic đọc bin dùng chung với plugin: plugin/bin-core.js (Bridge app copy file đó cạnh server.js
// — xem bridge-app/build-app.sh; chạy từ repo thì lấy ở ../plugin).

function loadBinCore() {
  try { return require('./bin-core.js'); } catch (e) { return require('../plugin/bin-core.js'); }
}
const BINC = loadBinCore();

const MAX_ITEMS = 30000;

// Chỉ giữ trường cần, ép kiểu chuỗi — dữ liệu từ panel, không tin cấu trúc.
function sanitize(list) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, MAX_ITEMS).filter(x => x && typeof x === 'object').map(x => ({
    name: String(x.name || ''), path: String(x.path || ''), isFolder: !!x.isFolder, mediaType: String(x.mediaType || ''),
  }));
}

function runTool(items, name, input) {
  input = input || {};
  if (!items) return { ok: false, text: 'Panel không gửi kèm danh sách bin (chưa mở project, hoặc plugin cũ).' };
  if (name === 'project_bins') return { ok: true, text: BINC.binTree(items) };
  if (name === 'list_bin')     return { ok: true, text: BINC.listBin(items, String(input.path || ''), !!input.recursive) };
  if (name === 'find_items')   return { ok: true, text: BINC.findItems(items, String(input.text || '')) };
  return { ok: false, text: 'Không có tool ' + name };
}

module.exports = { sanitize, runTool, MAX_ITEMS };
