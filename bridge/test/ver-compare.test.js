// bridge/test/ver-compare.test.js — so version hiểu -beta (S4).
const assert = require('assert');
const { compareVersions: c } = require('../../plugin/ver-compare.js');

assert.strictEqual(c('1.22.0', '1.22.0'), 0);
assert.strictEqual(c('1.22.1', '1.22.0'), 1);
assert.strictEqual(c('1.9.0', '1.15.0'), -1);
assert.strictEqual(c('v5.15.0', '5.15.0'), 0);
assert.strictEqual(c('1.22.1-beta.1', '1.22.0'), 1, 'beta của bản mới > bản cũ');
assert.strictEqual(c('1.22.1-beta.1', '1.22.1'), -1, 'beta < bản chính cùng số');
assert.strictEqual(c('1.22.1-beta.2', '1.22.1-beta.1'), 1);
assert.strictEqual(c('1.22.1-beta.10', '1.22.1-beta.9'), 1, 'so số chứ không so chữ');
assert.strictEqual(c('1.22', '1.22.0'), 0);
assert.strictEqual(c('', '1.0.0'), -1);
// Bản sao trong bridge (isNewer của /plugin/check-update) phải cho kết quả y hệt.
const { compareVersions: cb } = require('../ver-compare.js');
[['1.22.1-beta.1', '1.22.1'], ['5.15.1-beta.1', '5.15.0'], ['5.15.1', '5.15.1-beta.3'], ['2.0', '10.0']]
  .forEach(([a, b]) => assert.strictEqual(cb(a, b), c(a, b), a + ' vs ' + b));
console.log('ver-compare: OK');
