// plugin/clawd-pixel.js — Clawd (linh vật Claude) pixel 12×9 cho tab Claude (global CLAWD).
//
// Cảnh: 'idle' (đứng), 'blink' (chớp mắt), 'think' (bước chân khi Claude đang nghĩ),
// 'done' (giơ tay), 'fail' (mếu). UXP không chạy CSS @keyframes / GIF động ổn định →
// claude-tab.js đổi khung SVG bằng JS như rawcut-pixel.js. Hàm thuần — test ở
// bridge/test/clawd-pixel.test.js.
// O = thân cam, K = mắt (nền tối), . = trong suốt.

var CLAWD = (function () {
  var BODY = '#D97757', EYE = '#1a1a1a';
  var E = '............';
  var TOP = '..OOOOOOOO..', EYES = '..OKOOOOKO..', ARMS = 'OOOOOOOOOOOO';
  var LEG_A = '..O.O..O.O..', LEG_B = '...O.O..O.O.';

  var IDLE  = [E, TOP, EYES, EYES, ARMS, ARMS, TOP, LEG_A, LEG_A];
  var BLINK = [E, TOP, TOP, EYES, ARMS, ARMS, TOP, LEG_A, LEG_A];
  // Đang nghĩ: mắt liếc lên, chân bước.
  var THINK_A = [E, TOP, EYES, TOP, ARMS, ARMS, TOP, LEG_A, LEG_A];
  var THINK_B = [E, TOP, EYES, TOP, ARMS, ARMS, TOP, LEG_B, LEG_B];
  // Xong: giơ hai tay, nhún.
  var DONE_A = ['O..........O', 'O.OOOOOOOO.O', 'OOOKOOOOKOOO', '..OKOOOOKO..', TOP, TOP, TOP, LEG_A, LEG_A];
  var DONE_B = [E, 'O.OOOOOOOO.O', 'OOOKOOOOKOOO', '..OKOOOOKO..', TOP, TOP, TOP, LEG_A, LEG_A];
  // Lỗi: lún xuống một pixel, mắt khép sụp, tay buông thõng.
  var FAIL = [E, E, TOP, '..OKKOOKKO..', '.OOOOOOOOOO.', 'O.OOOOOOOO.O', 'O.OOOOOOOO.O', LEG_A, LEG_A];

  var SCENES = {
    idle:  [IDLE],
    blink: [BLINK],
    think: [THINK_A, THINK_B],
    done:  [DONE_A, DONE_B],
    fail:  [FAIL]
  };

  function frames(name) { return SCENES[name] || SCENES.idle; }

  // Gộp ô cùng màu liền nhau trên một hàng thành một <rect> cho nhẹ DOM.
  function toSvg(frame, width) {
    var out = [];
    for (var y = 0; y < frame.length; y++) {
      var row = frame[y], x = 0;
      while (x < row.length) {
        var c = row.charAt(x), x0 = x;
        while (x < row.length && row.charAt(x) === c) x++;
        if (c === '.') continue;
        out.push('<rect x="' + x0 + '" y="' + y + '" width="' + (x - x0) + '" height="1" fill="' + (c === 'K' ? EYE : BODY) + '"/>');
      }
    }
    var w = width || 16, h = Math.round(w * 9 / 12);
    return '<svg viewBox="0 0 12 9" width="' + w + '" height="' + h + '" shape-rendering="crispEdges">' + out.join('') + '</svg>';
  }

  return { frames: frames, toSvg: toSvg, SCENES: Object.keys(SCENES) };
})();

(function (root) {
  if (root) { root.CLAWD = CLAWD; }
  if (typeof module !== "undefined" && module.exports) { module.exports = CLAWD; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
