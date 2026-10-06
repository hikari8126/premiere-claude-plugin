// bridge/claude-bin.js — tìm file chạy `claude` bằng ĐƯỜNG DẪN TUYỆT ĐỐI (bug "spawn claude ENOENT" 2026-10-06).
//
// Claude Bridge.app chạy server qua launchd → PATH tối giản, không đọc .zshrc. Trước đây bridge spawn('claude')
// theo tên + mỗi chỗ tự vá PATH một kiểu (cleanEnv / cliEnv) → máy cài CLI ở ~/.npm-global/bin, ~/.local/bin,
// ~/.claude/local, nvm… thì tab Claude báo ENOENT. Giờ: dò một lần các chỗ hay cài, rồi hỏi shell đăng nhập
// (zsh -lc 'command -v claude') ở nền; mọi chỗ gọi dùng claudeBin(). env() thêm thư mục của claude vào PATH
// (bản npm cần `node` cùng thư mục, vd nvm).
const fs = require('fs');
const path = require('path');
const os = require('os');

function candidates(home) {
  home = home || os.homedir();
  const out = [
    path.join(home, '.npm-global', 'bin', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.bun', 'bin', 'claude'),
    path.join(home, '.volta', 'bin', 'claude'),
  ];
  // nvm: bản node mới nhất có claude
  try {
    const nv = path.join(home, '.nvm', 'versions', 'node');
    fs.readdirSync(nv).sort().reverse().forEach(v => out.push(path.join(nv, v, 'bin', 'claude')));
  } catch (e) {}
  return out;
}
function isExec(p) { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile() || fs.lstatSync(p).isSymbolicLink(); } catch (e) { return false; } }

let cached = '';
// Đồng bộ nhưng chỉ stat vài file — rẻ. → đường dẫn tuyệt đối hoặc '' nếu không thấy.
function findSync(home) {
  for (const c of candidates(home)) if (isExec(c)) return c;
  return '';
}
// Shell đăng nhập của user biết PATH thật (nvm, asdf, PATH tự đặt). Chạy nền, cập nhật cache.
function askShell(cb) {
  const sh = process.env.SHELL && /zsh|bash/.test(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
  require('child_process').execFile(sh, ['-lc', 'command -v claude'], { timeout: 8000 }, (err, out) => {
    const p = String(out || '').trim().split('\n').pop();
    if (p && path.isAbsolute(p) && isExec(p)) { cached = p; }
    if (cb) cb(cached);
  });
}
function claudeBin() {
  if (cached && isExec(cached)) return cached;
  cached = findSync();
  if (!cached) askShell();          // lần sau sẽ có
  return cached || 'claude';         // chưa thấy → để spawn báo lỗi như cũ
}
// env cho tiến trình claude: thêm thư mục của claude + chỗ hay có node vào PATH
function withPath(env) {
  const e = Object.assign({}, env || process.env);
  const bin = claudeBin();
  const extra = [path.isAbsolute(bin) ? path.dirname(bin) : '', path.join(os.homedir(), '.npm-global', 'bin'),
                 '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean);
  e.PATH = extra.concat([e.PATH || '/usr/bin:/bin:/usr/sbin:/sbin']).join(':');
  return e;
}
function warm(cb) { claudeBin(); askShell(cb); }

module.exports = { candidates, findSync, claudeBin, withPath, warm, _reset() { cached = ''; } };
