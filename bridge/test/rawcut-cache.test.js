// bridge/test/rawcut-cache.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../rawcut-cache.js');

assert.strictEqual(C.fnv1a64(''), 'cbf29ce484222325');
assert.strictEqual(C.fnv1a64('a'), 'af63dc4c8601ec8c');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-cache-'));
assert.strictEqual(C.renderCacheDir('/a/b/', root), path.join(root, C.fnv1a64('/a/b')));
assert.notStrictEqual(C.renderCacheDir('/a/b', root), C.renderCacheDir('/a/c', root));

// prune: chỉ xoá thư mục cũ hơn hạn
const oldD = path.join(root, 'old'), newD = path.join(root, 'new');
fs.mkdirSync(oldD); fs.mkdirSync(newD);
const now = Date.now();
const eightDays = new Date(now - 8 * 24 * 3600 * 1000);
fs.utimesSync(oldD, eightDays, eightDays);
assert.strictEqual(C.pruneCache(root, C.MAX_AGE_MS, now), 1);
assert.ok(!fs.existsSync(oldD));
assert.ok(fs.existsSync(newD));

assert.strictEqual(C.isUnder(root, newD), true);
assert.strictEqual(C.isUnder(root, root), false);
assert.strictEqual(C.isUnder(root, path.join(root, '..', 'x')), false);

assert.ok(C.freeBytes(root) > 0);
console.log('✓ rawcut-cache');
