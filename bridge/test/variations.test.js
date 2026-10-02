// bridge/test/variations.test.js — collectVariations giữ phần đã gen khi lỗi giữa chừng (VG2).
const assert = require('assert');
const { collectVariations } = require('../variations.js');

(async () => {
  // 1. đủ cả 2
  let r = await collectVariations(2, async v => 'f' + v);
  assert.deepStrictEqual(r.results, ['f1', 'f2']);
  assert.deepStrictEqual(r.errors, []);

  // 2. variation 2 lỗi → vẫn trả variation 1 + errors
  r = await collectVariations(2, async v => { if (v === 2) throw new Error('quota_exceeded'); return 'f' + v; });
  assert.deepStrictEqual(r.results, ['f1']);
  assert.deepStrictEqual(r.errors, [{ variation: 2, error: 'quota_exceeded' }]);

  // 3. variation 1 lỗi → ném như cũ
  await assert.rejects(collectVariations(2, async () => { throw new Error('bad key'); }), /bad key/);

  // 4. một variation
  r = await collectVariations(1, async v => 'only' + v);
  assert.deepStrictEqual(r.results, ['only1']);

  console.log('variations: OK');
})().catch(e => { console.error(e); process.exit(1); });
