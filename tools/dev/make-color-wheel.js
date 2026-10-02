// Dựng PNG vòng màu (HSV: góc = tông, bán kính = độ đậm, V = 1), nền trong suốt, viền khử răng cưa, lọc Paeth.
const zlib = require('zlib'), fs = require('fs');
const N = Number(process.argv[2] || 240), R = N / 2 - 1, cx = N / 2, cy = N / 2, ST = N * 4;
function hsv(h, s, v) { const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c; let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]; }
const px = Buffer.alloc(ST * N);
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d = Math.sqrt(dx * dx + dy * dy);
  const a = Math.max(0, Math.min(1, R - d + 0.5)), o = y * ST + x * 4;
  if (a <= 0) continue;   // ngoài vòng: trong suốt, RGB = 0 cho nén tốt
  const [r, g, b] = hsv((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, Math.min(1, d / R), 1);
  px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = Math.round(a * 255);
}
function paeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c); }
const raw = Buffer.alloc((ST + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (ST + 1)] = 4;
  for (let i = 0; i < ST; i++) {
    const cur = px[y * ST + i], left = i >= 4 ? px[y * ST + i - 4] : 0, up = y ? px[(y - 1) * ST + i] : 0, ul = (y && i >= 4) ? px[(y - 1) * ST + i - 4] : 0;
    raw[y * (ST + 1) + 1 + i] = (cur - paeth(left, up, ul)) & 255;
  }
}
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync(process.argv[3], png);
const js = "// plugin/color-wheel.js — ảnh vòng màu " + N + "×" + N + " (HSV, V = 1) cho Settings › Màu giao diện.\n"
  + "// UXP canvas không có drawImage/getImageData và vẽ lại 180 lát quạt mỗi lần kéo thì hiện hình vẽ dở\n"
  + "// → vòng màu là ảnh dựng sẵn; chấm đánh dấu + lớp tối độ sáng là div đặt chồng lên.\n"
  + "// Tạo lại: node tools/dev/make-color-wheel.js " + N + " /tmp/wheel.png > plugin/color-wheel.js (in ra JS).\n"
  + "var PI_COLOR_WHEEL_PNG = 'data:image/png;base64," + png.toString('base64') + "';\n";
process.stdout.write(js);
console.error('png bytes ' + png.length);
