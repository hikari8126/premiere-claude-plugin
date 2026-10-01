// bridge/test/fixtures/rawcut-fake-engine.js — giả xmlcut.py: in protocol, đẻ 1 tiến trình
// con ngủ lâu (đóng vai ffmpeg). Tham số "quick" → in xong thoát 0.
const { spawn } = require('child_process');
const kid = spawn('sleep', ['30'], { stdio: 'ignore' });
process.stdout.write('Cutting with 2 parallel job(s) ...\n');
process.stdout.write('  >> video/1/0/25 01_a.mp4\n');
process.stdout.write('  [1/2] OK  01_a.mp4\n');
process.stdout.write('  [2/2] FAIL 02_b.mp4\n        ffmpeg exited 1\n');
process.stdout.write('KID ' + kid.pid + '\n');
if (process.argv[2] === 'quick') { kid.kill(); process.exit(0); }
setInterval(() => {}, 1000);
