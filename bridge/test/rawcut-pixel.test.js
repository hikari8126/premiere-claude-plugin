// bridge/test/rawcut-pixel.test.js — khung hình nhân vật pixel của tab RAW (plugin/rawcut-pixel.js)
const assert = require('assert');
const RCPX = require('../../plugin/rawcut-pixel.js');

const PAL = { A: '#a', L: '#l', D: '#d', W: '#w', G: '#g', K: '#k', S: '#s', Y: '#y', R: '#r' };
for (const [name, frames] of Object.entries(RCPX.SCENES)) {
  assert.ok(frames.length >= 2, name + ': cần ≥ 2 khung để chuyển động');
  assert.ok(RCPX.FPS[name] > 0, name + ': thiếu FPS');
  frames.forEach((f, i) => {
    assert.strictEqual(f.length, 18, name + '#' + i + ' phải 18 hàng');
    f.forEach(r => {
      assert.strictEqual(r.length, 18, name + '#' + i + ' hàng phải 18 ô');
      assert.ok(/^[.ALDWGKSYR]+$/.test(r), name + '#' + i + ' có màu lạ: ' + r);
    });
  });
  // các khung phải khác nhau (thật sự chuyển động)
  assert.ok(new Set(frames.map(f => f.join(''))).size === frames.length, name + ': có khung trùng nhau');
}
// SVG: gộp pixel cùng màu trên một hàng thành 1 rect, bỏ ô trống
const svg = RCPX.toSvg(['AA.L'.padEnd(18, '.')].concat(Array(17).fill('.'.repeat(18))), PAL, 36);
assert.ok(svg.startsWith('<svg width="36" height="36" viewBox="0 0 18 18"'));
assert.strictEqual((svg.match(/<rect/g) || []).length, 2);
assert.ok(svg.includes('<rect x="0" y="0" width="2" height="1" fill="#a"/>'));
assert.ok(svg.includes('<rect x="3" y="0" width="1" height="1" fill="#l"/>'));
console.log('✓ rawcut-pixel');
