// plugin/clawd-pixel.js — Clawd (linh vật Claude Code) dạng pixel cho tab Claude (global CLAWD).
//
// Dáng gốc theo logo khối của Claude Code:
//    ▐▛███▜▌        thân rộng dẹt, hai mắt là hai khe dọc khoét vào thân,
//   ▝▜█████▛▘       hai tay ngắn chìa ra giữa hông,
//     ▘▘ ▝▝         bốn chân nhỏ (hai cặp).
// Quy về pixel vuông: Clawd 18×10 (ô terminal cao gấp đôi rộng), đặt trong khung 24×18
// — 8 hàng trên chừa cho hiệu ứng (bong bóng nghĩ, lấp lánh, nhảy lên, giọt mồ hôi).
//
// Cảnh (mỗi khung 250ms, claude-tab.js lặp theo tick):
//   idle  — đứng thở (nhún 1px), thỉnh thoảng chớp mắt
//   think — mắt liếc lên phía bong bóng nghĩ đang to dần, một chân gõ nhịp
//   work  — hai tay vung thay nhau, chạy tại chỗ, bụi tung sau chân (đang chạy action)
//   done  — nhún lấy đà, bật nhảy giơ hai tay, đáp xuống cười, lấp lánh
//   fail  — gục xuống, tay buông thõng, mắt cụp, giọt mồ hôi chảy
//   party — ăn mừng (thẻ "Xong" tab RAW): nhảy liên tục, tay vẫy, pháo giấy nhiều màu rơi quanh
// Hàm thuần — test ở bridge/test/clawd-pixel.test.js.
//
// Ký tự: O thân · K mắt (lỗ khoét, nền tối) · W chấm suy nghĩ · Y lấp lánh/tia lửa ·
//        B giọt mồ hôi · . trong suốt  (W cũng là bụi khi chạy)

var CLAWD = (function () {
  var W = 24, H = 18, OX = 3, OY = 8;           // Clawd 18×10 đặt ở (3,8) → đáy chạm hàng 17
  var COLORS = { O: '#D97757', K: '#141414', W: '#d4d4d4', Y: '#F2C14E', B: '#6CB4EE',
                 R: '#F472B6', G: '#4ADE80', C: '#22D3EE',     // R/G/C: pháo giấy
                 D: '#B85F42', T: '#C9B27F' };                 // D: khớp tay (đậm) · T: tia pháo nhạt

  function blank() {
    var g = [];
    for (var y = 0; y < H; y++) { var r = []; for (var x = 0; x < W; x++) r.push('.'); g.push(r); }
    return g;
  }
  function px(g, x, y, c) { if (x >= 0 && y >= 0 && x < W && y < H) g[y][x] = c; }
  function rect(g, x0, y0, w, h, c) { for (var y = y0; y < y0 + h; y++) for (var x = x0; x < x0 + w; x++) px(g, x, y, c); }

  // Một tư thế Clawd. Toạ độ cục bộ 18×10: thân cột 3..14, tay cột 1-2 / 15-16, chân 4,6,11,13.
  //   dy    — dời cả người (âm = bay lên, dương = lún xuống)
  //   eyes  — open | closed | up | happy | sad
  //   arms  — side | up | down | leftUp | rightUp | leftMid | rightMid
  //   legs  — stand | squash | stepA | stepB
  function clawd(g, o) {
    var dy = o.dy || 0, bx = OX + (o.dx || 0), by = OY + dy;
    var legs = o.legs || 'stand';
    var squash = legs === 'squash';
    var top = by + (squash ? 1 : 0);              // nhún: thân hạ 1px, chân còn 1px

    // Thân 12×8
    rect(g, bx + 3, top, 12, 8, 'O');

    // Mắt — khe dọc 1×2 ở cột 5 và 12 (hàng 2-3 của thân)
    var e = o.eyes || 'open';
    [[5, 0], [12, 1]].forEach(function (p) {
      var ex = bx + p[0];
      if (e === 'open')   { px(g, ex, top + 2, 'K'); px(g, ex, top + 3, 'K'); }
      if (e === 'closed') { px(g, ex - 1, top + 3, 'K'); px(g, ex, top + 3, 'K'); px(g, ex + 1, top + 3, 'K'); }
      if (e === 'up')     { px(g, ex + 1, top + 1, 'K'); px(g, ex + 1, top + 2, 'K'); }                        // liếc lên-phải
      if (e === 'happy')  { px(g, ex - 1, top + 3, 'K'); px(g, ex, top + 2, 'K'); px(g, ex + 1, top + 3, 'K'); }   // ^ ^
      if (e === 'sad')    {                                                                                          // mắt cụp xuống phía ngoài
        var out = p[1] ? 1 : -1;
        px(g, ex - out, top + 3, 'K'); px(g, ex, top + 3, 'K'); px(g, ex + out, top + 4, 'K');
      }
    });

    // Tay — mẩu 2×2 hai bên hông (như logo). Giơ lên: đường chéo dày 2px chĩa ra ngoài-lên từ
    // vai, hai tay thành chữ V (cột thẳng dính thân trông như cái xô). Vung: mẩu tay nhấc lên vai.
    function arm(side, pose) {
      var ax = side < 0 ? bx + 1 : bx + 15;
      var out = side < 0 ? -1 : 1;                     // hướng ra ngoài
      if (pose === 'side') rect(g, ax, top + 4, 2, 2, 'O');
      if (pose === 'up') {
        for (var k = 0; k < 3; k++) rect(g, ax + out * k, top + 2 - k, 2, 1, 'O');   // bậc chéo 2px
        px(g, (side < 0 ? ax : ax + 1) + out * 2, top - 1, 'O');                       // đầu ngón chĩa lên
      }
      if (pose === 'mid')  rect(g, ax, top + 2, 2, 2, 'O');
      // Duỗi dài cầm que pháo (ảnh mẫu): tay 4px có khớp đậm, que đen 2px ở mép trên bàn tay
      if (pose === 'hold') {
        rect(g, ax, top + 4, 4, 2, 'O'); rect(g, ax + 1, top + 4, 1, 2, 'D');
        rect(g, ax + 4, top + 4, 2, 1, 'W');   // que xám nhạt (que đen chìm vào nền tối)
      }
      // Buông thõng: mẩu tay 2px vẫn dính hông nhưng chĩa chéo xuống dưới-ra ngoài
      var inX = side < 0 ? ax + 1 : ax, outX = side < 0 ? ax : ax + 1;
      if (pose === 'down') {
        px(g, inX, top + 5, 'O');
        px(g, inX, top + 6, 'O'); px(g, outX, top + 6, 'O');
        px(g, outX, top + 7, 'O');
      }
    }
    var a = o.arms || 'side';
    var L = { side: 'side', up: 'up', down: 'down', leftUp: 'up', rightUp: 'side', leftMid: 'mid', rightMid: 'side', hold: 'side' }[a];
    var R = { side: 'side', up: 'up', down: 'down', leftUp: 'side', rightUp: 'up', leftMid: 'side', rightMid: 'mid', hold: 'hold' }[a];
    arm(-1, L); arm(1, R);

    // Chân — 4 cột 1×2 dưới thân
    var ly = top + 8;
    [4, 6, 11, 13].forEach(function (c, i) {
      var lifted = (legs === 'stepA' && i >= 2) || (legs === 'stepB' && i < 2);
      if (squash) px(g, bx + c, ly, 'O');
      else { px(g, bx + c, ly, 'O'); if (!lifted) px(g, bx + c, ly + 1, 'O'); }
    });
  }

  // Hiệu ứng
  // Bong bóng nghĩ lên phía trên bên phải: chấm 1px → bóng 2×2 → đám mây 7×3 có
  // `dots` chấm tối "…" bên trong (0..3, như đang gõ).
  function thought(g, n, dots) {
    if (n >= 1) px(g, 18, 7, 'W');
    if (n >= 2) rect(g, 19, 4, 2, 2, 'W');
    if (n >= 3) {
      rect(g, 18, 0, 5, 1, 'W'); rect(g, 17, 1, 7, 1, 'W'); rect(g, 18, 2, 5, 1, 'W');
      for (var d = 0; d < (dots || 0); d++) px(g, 18 + d * 2, 1, 'K');
    }
  }
  function dust(g, n) {                           // bụi tung sau chân khi chạy
    if (n === 0) { px(g, 2, 16, 'W'); px(g, 1, 15, 'W'); }
    else { px(g, 1, 16, 'W'); px(g, 0, 14, 'W'); }
  }
  function sparkle(g, x, y, big) {                // dấu + lấp lánh (to) hoặc một chấm (nhỏ)
    px(g, x, y, 'Y');
    if (big) { px(g, x - 1, y, 'Y'); px(g, x + 1, y, 'Y'); px(g, x, y - 1, 'Y'); px(g, x, y + 1, 'Y'); }
  }
  function drop(g, y) { px(g, 21, y, 'B'); rect(g, 20, y + 1, 2, 2, 'B'); }   // giọt nước: chóp 1px, bầu 2×2

  function frame(pose, fx) {
    var g = blank();
    clawd(g, pose);
    if (fx) fx(g);
    return g.map(function (r) { return r.join(''); });
  }

  var IDLE = { eyes: 'open', arms: 'side', legs: 'stand' };
  function P(extra) { var o = {}; for (var k in IDLE) o[k] = IDLE[k]; for (var j in extra) o[j] = extra[j]; return o; }

  // Pháo giấy: mỗi mảnh rơi 1 hàng/khung, lắc ngang theo nhịp, lặp lại sau H hàng.
  var CONFETTI = [[1, 0, 'Y'], [4, 5, 'R'], [7, 2, 'G'], [10, 8, 'C'], [13, 1, 'B'], [16, 6, 'Y'],
                  [19, 3, 'R'], [22, 9, 'G'], [2, 11, 'C'], [21, 13, 'Y'], [0, 15, 'G'], [23, 7, 'R']];
  function confetti(g, t) {
    CONFETTI.forEach(function (p, i) {
      var y = (p[1] + t) % H, x = p[0] + ((t + i) % 4 < 2 ? 0 : 1);
      if (g[y] && g[y][x] === '.') px(g, x, y, p[2]);   // chỉ rơi vào ô trống — không đè thân / tay
    });
  }

  // Tia pháo hoa quanh đầu que (cx, cy): lõi vàng + tia toả, 4 dạng xoay vòng cho lấp lánh.
  var SPARKS = [   // lệch tối đa ±2 quanh đầu que để không bị mép khung cắt
    [[0,0,'Y'],[1,0,'Y'],[0,-1,'Y'],[0,1,'Y'],[-1,-2,'T'],[2,-2,'Y'],[2,1,'T'],[-1,2,'Y'],[2,2,'T']],
    [[0,0,'Y'],[0,1,'Y'],[1,-1,'Y'],[-1,-1,'T'],[2,0,'Y'],[1,2,'Y'],[0,-2,'T'],[2,-2,'T'],[-2,1,'T']],
    [[0,0,'Y'],[1,0,'T'],[-1,1,'Y'],[1,-2,'Y'],[2,1,'Y'],[0,2,'T'],[-2,-2,'Y'],[2,2,'Y']],
    [[0,0,'Y'],[0,-1,'Y'],[1,1,'Y'],[2,-1,'Y'],[-1,0,'T'],[-1,-2,'Y'],[2,2,'T'],[1,-2,'T'],[-2,2,'Y']]
  ];
  function sparkler(g, cx, cy, t) {
    SPARKS[t % SPARKS.length].forEach(function (p) {
      var x = cx + p[0], y = cy + p[1];
      if (g[y] && g[y][x] === '.') px(g, x, y, p[2]);
    });
  }

  var SCENES = {
    // 16 khung = 4s: đứng, nhún thở ở khung 7, chớp mắt ở khung 13
    idle: (function () {
      var out = [];
      for (var i = 0; i < 16; i++) {
        if (i === 7) out.push(frame(P({ legs: 'squash' })));
        else if (i === 13) out.push(frame(P({ eyes: 'closed' })));
        else out.push(frame(P({})));
      }
      return out;
    })(),
    // chân phải gõ nhịp (stepA = nhấc cặp chân phải) trong khi bong bóng nghĩ hiện dần
    think: [
      frame(P({ eyes: 'up' })),
      frame(P({ eyes: 'up', legs: 'stepA' }), function (g) { thought(g, 1); }),
      frame(P({ eyes: 'up' }), function (g) { thought(g, 2); }),
      frame(P({ eyes: 'up', legs: 'stepA' }), function (g) { thought(g, 3, 1); }),
      frame(P({ eyes: 'up' }), function (g) { thought(g, 3, 2); }),
      frame(P({ eyes: 'up', legs: 'stepA' }), function (g) { thought(g, 3, 3); }),
      frame(P({ eyes: 'closed' }), function (g) { thought(g, 3, 3); })
    ],
    work: [
      frame(P({ arms: 'leftMid', legs: 'stepA', dy: -1 }), function (g) { dust(g, 0); }),
      frame(P({ arms: 'side', legs: 'stand' }), function (g) { dust(g, 1); }),
      frame(P({ arms: 'rightMid', legs: 'stepB', dy: -1 }), function (g) { dust(g, 0); }),
      frame(P({ arms: 'side', legs: 'stand' }), function (g) { dust(g, 1); })
    ],
    done: [
      frame(P({ legs: 'squash', eyes: 'closed' })),                                         // nhún lấy đà
      frame(P({ dy: -2, arms: 'up', eyes: 'happy' })),                                      // bật lên
      frame(P({ dy: -3, arms: 'up', eyes: 'happy' }), function (g) { sparkle(g, 1, 1, true); sparkle(g, 22, 2, true); }),
      frame(P({ dy: -2, arms: 'up', eyes: 'happy' }), function (g) { sparkle(g, 1, 1, false); sparkle(g, 22, 2, false); }),
      frame(P({ legs: 'squash', arms: 'up', eyes: 'happy' })),                              // đáp
      frame(P({ arms: 'up', eyes: 'happy' }), function (g) { sparkle(g, 1, 2, true); sparkle(g, 22, 1, false); }),
      frame(P({ arms: 'up', eyes: 'happy' }), function (g) { sparkle(g, 1, 2, false); sparkle(g, 22, 1, true); })
    ],
    // Ăn mừng theo sticker Clawd cầm pháo que: lùi sang trái lấy chỗ, tay phải duỗi cầm que,
    // nhún nhảy nhẹ, đầu que toé tia vàng. 8 khung lặp.
    party: (function () {
      var hops = [0, -1, -2, -1, 0, 'sq', 0, -1];
      return hops.map(function (h, t) {
        var pose = h === 'sq' ? P({ dx: -3, legs: 'squash', arms: 'hold', eyes: 'happy' })
                              : P({ dx: -3, dy: h, arms: 'hold', eyes: h <= -2 ? 'happy' : 'open' });
        var top = OY + (h === 'sq' ? 1 : h);
        return frame(pose, function (g) { sparkler(g, 21, top + 4, t); });
      });
    })(),
    fail: [
      frame(P({ legs: 'squash', arms: 'down', eyes: 'sad' }), function (g) { drop(g, 8); }),
      frame(P({ legs: 'squash', arms: 'down', eyes: 'sad' }), function (g) { drop(g, 9); }),
      frame(P({ legs: 'squash', arms: 'down', eyes: 'sad' }), function (g) { drop(g, 10); }),
      frame(P({ legs: 'squash', arms: 'down', eyes: 'closed' }), function (g) { drop(g, 11); })
    ]
  };

  function frames(name) { return SCENES[name] || SCENES.idle; }

  // crop {x,y,w,h}: chỉ vẽ một phần khung (icon tab bỏ phần trời trống cho Clawd to hơn).
  // Gộp ô cùng màu liền nhau trên một hàng thành một <rect> cho nhẹ DOM.
  // palette: ghi đè màu theo ký tự (vd Clawd âm bản trên nền cam: { O: '#1a1a1a', K: '#D97757' }).
  function toSvg(frame, width, crop, palette) {
    var c = crop || { x: 0, y: 0, w: W, h: H };
    var pal = palette || COLORS;
    var out = [];
    for (var y = 0; y < frame.length; y++) {
      var row = frame[y], x = 0;
      while (x < row.length) {
        var ch = row.charAt(x), x0 = x;
        while (x < row.length && row.charAt(x) === ch) x++;
        if (ch === '.') continue;
        // Phủ chồng 0.1px sang phải/xuống dưới: UXP khử răng cưa từng <rect> nên giữa các hàng
        // lộ vạch nền mờ; ô vẽ sau (bên phải / hàng dưới) đè lại phần chồng nên hình không đổi.
        out.push('<rect x="' + x0 + '" y="' + y + '" width="' + (x - x0 + 0.1) + '" height="1.1" fill="' + (pal[ch] || COLORS[ch]) + '"/>');
      }
    }
    var w = width || 24, h = Math.round(w * c.h / c.w);
    return '<svg viewBox="' + c.x + ' ' + c.y + ' ' + c.w + ' ' + c.h + '" width="' + w + '" height="' + h +
           '" shape-rendering="crispEdges">' + out.join('') + '</svg>';
  }

  // Khung cắt cho icon tab: bỏ hiệu ứng hai bên, giữ chỗ cho cú nhảy (dy -3).
  var TAB_CROP = { x: 3, y: 4, w: 18, h: 14 };

  return { W: W, H: H, frames: frames, toSvg: toSvg, TAB_CROP: TAB_CROP, SCENES: Object.keys(SCENES) };
})();

(function (root) {
  if (root) { root.CLAWD = CLAWD; }
  if (typeof module !== "undefined" && module.exports) { module.exports = CLAWD; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
