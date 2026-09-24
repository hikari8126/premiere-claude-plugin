// bridge/cli-auth.js
// Trạng thái đăng nhập Claude CLI + mở luồng đăng nhập từ plugin.
//
// Vì sao cần: phiên OAuth của CLI hết hạn GIỮA CHỪNG, trong khi Bridge app chỉ
// kiểm tra đăng nhập lúc khởi động. App chạy qua đêm là mọi tính năng AI (ghép
// bin, normalize script…) hỏng mà không có cảnh báo nào.
//
// Không đăng nhập ngầm được: OAuth bắt buộc người dùng bấm trong trình duyệt.
// Ta chỉ mở Terminal chạy `claude auth login` — y hệt Bridge app đang làm lúc
// khởi động (promptLogin trong bridge-app/main.swift) — rồi để plugin poll.

const { spawnSync, execFile } = require('child_process');

const CACHE_MS = 60 * 1000;
let cache = null;          // { loggedIn, authMethod, at, error }
let refreshing = false;

// `claude auth status` in JSON: {"loggedIn": false, "authMethod": "none", ...}.
// Đọc được JSON thì tin JSON; không thì rơi về dò chữ như checkAuth() của app.
function parseStatus(out) {
  const txt = String(out || '');
  const m = txt.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (typeof j.loggedIn === 'boolean') {
        return { loggedIn: j.loggedIn, authMethod: j.authMethod || null };
      }
    } catch (e) { /* rơi xuống dò chữ */ }
  }
  const low = txt.toLowerCase();
  if (/not logged in|not authenticated|login required|please log in/.test(low)) {
    return { loggedIn: false, authMethod: null };
  }
  if (low.indexOf('logged in') >= 0) return { loggedIn: true, authMethod: null };
  return { loggedIn: null, authMethod: null };   // không đọc được — đừng đoán
}

function status(env, opts) {
  const o = opts || {};
  if (!o.fresh && cache && Date.now() - cache.at < CACHE_MS) return cache;
  const r = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8', timeout: 15000, env });
  if (r.error) {
    cache = { loggedIn: null, authMethod: null, at: Date.now(), error: r.error.code || r.error.message };
    return cache;
  }
  cache = Object.assign(parseStatus((r.stdout || '') + (r.stderr || '')), { at: Date.now() });
  return cache;
}

// Cho /health: không bao giờ chặn request. Trả giá trị đang có, làm mới ngầm
// khi cũ quá CACHE_MS.
function cachedStatus(env) {
  if (!refreshing && (!cache || Date.now() - cache.at >= CACHE_MS)) {
    refreshing = true;
    execFile('claude', ['auth', 'status'], { timeout: 15000, env }, (err, out, errOut) => {
      refreshing = false;
      if (err && !out) {
        cache = { loggedIn: null, authMethod: null, at: Date.now(), error: err.code || err.message };
        return;
      }
      cache = Object.assign(parseStatus((out || '') + (errOut || '')), { at: Date.now() });
    });
  }
  return cache;
}

// Script AppleScript mở Terminal chạy lệnh đăng nhập. Tách ra để test được.
// Escape cho chuỗi AppleScript: \ trước, rồi ".
function buildLoginScript() {
  const cmd = "claude auth login 2>&1; echo ''; echo '✅ Đăng nhập xong — quay lại Premiere, plugin tự nhận.'";
  const esc = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return 'tell application "Terminal" to activate\n'
       + 'tell application "Terminal" to do script "' + esc + '"';
}

function openLogin(cb) {
  cache = null;   // đăng nhập xong phải đọc lại ngay, không dùng cache cũ
  execFile('osascript', ['-e', buildLoginScript()], { timeout: 8000 }, (err, _o, stderr) => {
    cb(err ? new Error((stderr || err.message).trim()) : null);
  });
}

module.exports = { parseStatus, status, cachedStatus, buildLoginScript, openLogin };
