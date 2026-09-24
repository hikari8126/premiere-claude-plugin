// bridge/test/cli-auth.test.js
// Đọc trạng thái đăng nhập Claude CLI và dựng script mở Terminal.
const assert = require('assert');
const { parseStatus, buildLoginScript } = require('../cli-auth.js');

// 1. JSON thật của `claude auth status` lúc phiên hết hạn
assert.deepStrictEqual(
  parseStatus('{\n  "loggedIn": false,\n  "authMethod": "none",\n  "apiProvider": "firstParty"\n}\n'),
  { loggedIn: false, authMethod: 'none' });

// 2. JSON khi đã đăng nhập — có chữ "oauth" nhưng KHÔNG được coi là lỗi
//    (bài học của checkAuth() trong Bridge app)
assert.strictEqual(
  parseStatus('{"loggedIn": true, "authMethod": "claude.ai", "oauthSessionExpiry": "x"}').loggedIn, true);

// 3. Bản CLI cũ in chữ thay vì JSON
assert.strictEqual(parseStatus('Not logged in. Run claude auth login').loggedIn, false);
assert.strictEqual(parseStatus('Logged in as a@b.com').loggedIn, true);

// 4. Không đọc được → null, không đoán bừa
assert.strictEqual(parseStatus('').loggedIn, null);

// 5. Script AppleScript: đúng lệnh, dấu " bên trong được escape
const sc = buildLoginScript();
assert.ok(/tell application "Terminal" to do script "/.test(sc), sc);
assert.ok(sc.indexOf('claude auth login') >= 0);
const inner = sc.split('do script "')[1].slice(0, -1);
assert.ok(!/(^|[^\\])"/.test(inner), 'không còn " chưa escape trong chuỗi lệnh: ' + inner);

console.log('cli-auth: OK');
