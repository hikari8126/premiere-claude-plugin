// plugin/rawcut-pixel.js — nhân vật pixel 18×18 báo tab RAW đang chạy (global RCPX).
//
// Cảnh: 'read' (đọc timeline — vạch quét chạy dọc dải phim), 'cut' (engine cắt — kéo cắt
// dải phim đang chạy), 'render' (Premiere render — cuộn phim quay), 'done' (✓), 'fail' (mếu).
// UXP không chạy CSS @keyframes / GIF động ổn định → JS đổi khung SVG (rect từng pixel,
// gộp theo hàng). Màu lấy từ --accent* mà piApplyAccent đặt lên :root (người dùng đổi màu
// thì nhân vật đổi theo). Phần dựng khung là hàm thuần — test ở bridge/test/rawcut-pixel.test.js.

var RCPX = (function () {
  var N = 18;

  function blank() {
    var g = [];
    for (var y = 0; y < N; y++) { g.push([]); for (var x = 0; x < N; x++) g[y].push('.'); }
    return g;
  }
  function px(g, x, y, c) { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < N && y < N) g[y][x] = c; }
  function line(g, x0, y0, x1, y1, c) {
    var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx - dy;
    for (var guard = 0; guard < 64; guard++) {
      px(g, x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      var e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }
  // Vòng tròn: tô điểm có khoảng cách tới tâm trong [r0, r1).
  function disc(g, cx, cy, r0, r1, c) {
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      var d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
      if (d >= r0 && d < r1) g[y][x] = c;
    }
  }
  function rows(g) { return g.map(function (r) { return r.join(''); }); }

  // Dải phim nằm ngang ở hàng y0..y0+5, chạy sang trái theo off.
  function strip(g, y0, off) {
    for (var x = 0; x < N; x++) {
      var k = x + off;
      g[y0][x] = 'G'; g[y0 + 5][x] = 'G';
      g[y0 + 1][x] = g[y0 + 4][x] = (k % 3 === 0) ? 'K' : 'G';
      g[y0 + 2][x] = g[y0 + 3][x] = (k % 6 === 0) ? 'D' : 'L';
    }
  }

  // Kéo dựng đứng, lưỡi chúi xuống dải phim. open: 0 = khép, 3 = mở hết.
  function scissors(g, open) {
    disc(g, 4.5, 2.5, 1.1, 2.5, 'A');    // vòng tay cầm trái
    disc(g, 12.5, 2.5, 1.1, 2.5, 'A');   // vòng tay cầm phải
    line(g, 6, 4, 8, 7, 'A');
    line(g, 11, 4, 9, 7, 'A');
    line(g, 8, 8, 8 - open, 12, 'S');    // lưỡi trái
    line(g, 9, 8, 9 + open, 12, 'S');    // lưỡi phải
    px(g, 8 - open, 13, 'W'); px(g, 9 + open, 13, 'W');   // mũi kéo cắm vào phim
    px(g, 8, 7, 'D'); px(g, 9, 7, 'D');  // chốt
  }

  function sceneCut() {
    var out = [], opens = [3, 2, 0, 2];
    for (var t = 0; t < 4; t++) {
      var g = blank();
      strip(g, 11, t);
      scissors(g, opens[t]);
      if (opens[t] === 0) { px(g, 6, 10, 'W'); px(g, 11, 10, 'W'); px(g, 5, 9, 'L'); px(g, 12, 9, 'L'); }   // "xoẹt"
      out.push(rows(g));
    }
    return out;
  }

  function sceneRender() {
    var out = [];
    for (var t = 0; t < 6; t++) {
      var g = blank(), th = t * Math.PI / 9;   // 20° mỗi khung, 3 lỗ → lặp sau 120°
      disc(g, 8.5, 8.5, 0, 8.4, 'D');
      disc(g, 8.5, 8.5, 6.6, 8.4, 'A');
      for (var k = 0; k < 3; k++) {
        var a = th + k * 2 * Math.PI / 3;
        disc(g, 8.5 + Math.cos(a) * 3.8, 8.5 + Math.sin(a) * 3.8, 0, 1.7, 'K');
      }
      disc(g, 8.5, 8.5, 0, 1.2, 'W');
      // đuôi phim chạy ra góc dưới phải
      for (var x = 13; x < N; x++) { px(g, x, 15, 'G'); px(g, x, 16, (x + t) % 2 ? 'L' : 'G'); px(g, x, 17, 'G'); }
      out.push(rows(g));
    }
    return out;
  }

  function sceneRead() {
    var out = [];
    for (var t = 0; t < 9; t++) {
      var g = blank(), x = 1 + t * 2;
      strip(g, 6, 0);
      line(g, x, 4, x, 13, 'W');
      px(g, x - 1, 3, 'A'); px(g, x, 3, 'A'); px(g, x + 1, 3, 'A'); px(g, x, 4, 'A');
      out.push(rows(g));
    }
    return out;
  }

  function sceneDone() {
    var a = blank(), b = blank();
    [a, b].forEach(function (g) {
      disc(g, 8.5, 8.5, 6.8, 8.4, 'Y');
      line(g, 4, 9, 7, 12, 'Y'); line(g, 4, 10, 7, 13, 'Y');
      line(g, 7, 12, 13, 6, 'Y'); line(g, 7, 13, 13, 7, 'Y');
    });
    px(b, 15, 2, 'W'); px(b, 2, 3, 'W'); px(b, 16, 15, 'W');   // lấp lánh
    return [rows(a), rows(b)];
  }

  function sceneFail() {
    var a = blank(), b;
    disc(a, 8.5, 8.5, 6.8, 8.4, 'R');
    px(a, 6, 6, 'W'); px(a, 6, 7, 'W'); px(a, 11, 6, 'W'); px(a, 11, 7, 'W');
    line(a, 6, 12, 11, 12, 'R'); px(a, 5, 13, 'R'); px(a, 12, 13, 'R');
    b = a.map(function (r) { return r.slice(); });
    px(b, 12, 9, 'L'); px(b, 12, 10, 'L');   // giọt nước mắt
    return [rows(a), rows(b)];
  }

  var SCENES = { cut: sceneCut(), render: sceneRender(), read: sceneRead(), done: sceneDone(), fail: sceneFail() };
  var FPS = { cut: 8, render: 10, read: 12, done: 3, fail: 2 };

  // Khung → SVG (gộp các pixel liền màu trên cùng hàng thành 1 rect).
  function toSvg(frame, pal, size) {
    var s = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + N + ' ' + N + '" shape-rendering="crispEdges">';
    for (var y = 0; y < N; y++) {
      var r = frame[y], x = 0;
      while (x < N) {
        var c = r.charAt(x), w = 1;
        while (x + w < N && r.charAt(x + w) === c) w++;
        if (c !== '.' && pal[c]) s += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="1" fill="' + pal[c] + '"/>';
        x += w;
      }
    }
    return s + '</svg>';
  }

  // ── Phần DOM (chỉ chạy trong plugin) ──
  var host = null, timer = null, hideTimer = null, cache = {};
  function cssVar(name, dflt) {
    try {
      var v = document.documentElement.style.getPropertyValue(name);
      if (v && v.trim()) return v.trim();
    } catch (e) {}
    return dflt;
  }
  function palette() {
    return {
      A: cssVar('--accent', '#a855f7'), L: cssVar('--accent-light', '#c084fc'), D: cssVar('--accent-dark', '#9333ea'),
      W: '#f4f4f5', G: '#71717a', K: '#27272a', S: '#d4d4d8', Y: '#22c55e', R: '#ef4444'
    };
  }
  function framesFor(scene, size) {
    var pal = palette(), key = scene + '|' + size + '|' + pal.A;
    if (!cache[key]) cache[key] = SCENES[scene].map(function (f) { return toSvg(f, pal, size); });
    return cache[key];
  }
  function stopTimers() {
    if (timer) { clearInterval(timer); timer = null; }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }
  // play('cut' | 'render' | 'read'): chạy lặp. finish(ok): ✓ / mếu ~2.5s rồi ẩn. hide(): ẩn ngay.
  function play(scene, el) {
    host = el || host;
    if (!host || !SCENES[scene]) return;
    if (host.getAttribute('data-scene') === scene && timer) return;
    stopTimers();
    host.setAttribute('data-scene', scene);
    host.style.display = '';
    var frames = framesFor(scene, Number(host.getAttribute('data-size')) || 36), i = 0;
    host.innerHTML = frames[0];
    timer = setInterval(function () { i = (i + 1) % frames.length; host.innerHTML = frames[i]; }, Math.round(1000 / FPS[scene]));
  }
  function finish(ok) {
    if (!host) return;
    play(ok ? 'done' : 'fail');
    hideTimer = setTimeout(hide, 2500);
  }
  function hide() {
    stopTimers();
    if (host) { host.style.display = 'none'; host.innerHTML = ''; host.removeAttribute('data-scene'); }
  }

  return { N: N, SCENES: SCENES, FPS: FPS, toSvg: toSvg, play: play, finish: finish, hide: hide };
})();

(function (root) {
  if (root) { root.RCPX = RCPX; }
  if (typeof module !== "undefined" && module.exports) { module.exports = RCPX; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
