// bridge/test/rawcut-python.test.js
const assert = require('assert');
const { findPython, parseVer } = require('../rawcut-python.js');

assert.deepStrictEqual(parseVer('3.9\n'), [3, 9]);
assert.strictEqual(parseVer('rác'), null);

// 1. bỏ bản quá cũ, lấy bản kế tiếp đủ mới
const fake = { '/opt/homebrew/bin/python3': '3.7', '/usr/bin/python3': '3.9' };
let r = findPython({ env: {}, exists: p => p in fake, run: p => fake[p] + '\n' });
assert.strictEqual(r.ok, true);
assert.strictEqual(r.bin, '/usr/bin/python3');
assert.strictEqual(r.version, '3.9');
assert.ok(r.tried.some(t => /3\.7/.test(t)), 'phải ghi lý do bỏ 3.7: ' + r.tried);

// 2. PYTHON_BIN được ưu tiên
r = findPython({ env: { PYTHON_BIN: '/x/py' }, exists: p => p === '/x/py' || p in fake, run: p => (p === '/x/py' ? '3.12' : fake[p]) });
assert.strictEqual(r.bin, '/x/py');

// 3. không có gì
r = findPython({ env: {}, exists: () => false, run: () => '' });
assert.strictEqual(r.ok, false);
assert.strictEqual(r.bin, '');

// 4. chạy thử ném lỗi (stub CLT bật hộp thoại → timeout) → bỏ qua, không crash
r = findPython({ env: {}, exists: p => p === '/usr/bin/python3', run: () => { throw new Error('timeout'); } });
assert.strictEqual(r.ok, false);

const real = findPython();
console.log('✓ rawcut-python — máy này:', real.ok ? real.bin + ' ' + real.version : 'KHÔNG CÓ python3 ≥3.8');
