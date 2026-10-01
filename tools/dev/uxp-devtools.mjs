// tools/dev/uxp-devtools.mjs — nói chuyện với UXP Developer Tool (service ws://127.0.0.1:14001)
// để load / reload / gỡ bản DEV của plugin trong Premiere, và chạy thử JS trong panel.
//
//   node tools/dev/uxp-devtools.mjs load   <thư mục plugin> <file session>
//   node tools/dev/uxp-devtools.mjs unload <file session>
//   node tools/dev/uxp-devtools.mjs eval   <file session> <file.js | ->   (biểu thức, được await)
//
// Protocol lấy từ chính app UXP Developer Tool (socket /socket/cli): gửi
// {command:'proxy', clientId, requestId, message:{command:'Plugin', action:…}}, app trả
// {command:'reply', requestId, …}. Action 'debug' cho URL CDP của panel → Runtime.evaluate.
// UXP không hỗ trợ awaitPromise → bọc biểu thức, gán kết quả vào window rồi poll.
import fs from 'node:fs';

const SERVICE = 'ws://127.0.0.1:14001/socket/cli';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

function connect() {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === 'undefined') return reject(new Error('Node quá cũ — cần Node ≥ 22 (có WebSocket sẵn)'));
    const ws = new WebSocket(SERVICE);
    const apps = [], pend = new Map();
    let rid = 0;
    const timer = setTimeout(() => reject(new Error('Không kết nối được UXP Developer Tool — mở app "Adobe UXP Developer Tools" trước')), 5000);
    ws.onerror = () => { clearTimeout(timer); reject(new Error('Không kết nối được UXP Developer Tool — mở app "Adobe UXP Developer Tools" trước')); };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.command === 'didAddRuntimeClient') apps.push(m);
      else if (m.command === 'reply' && pend.has(m.requestId)) { pend.get(m.requestId)(m); pend.delete(m.requestId); }
    };
    ws.onopen = async () => {
      clearTimeout(timer);
      await sleep(1000);   // service báo các app đang kết nối ngay sau khi mở socket
      const app = apps.find(a => a.app && a.app.appId === 'premierepro');
      if (!app) { ws.close(); return reject(new Error('Premiere chưa kết nối với UXP Developer Tool — mở Premiere (bật Developer Mode) rồi thử lại')); }
      const req = message => {
        const requestId = ++rid;
        ws.send(JSON.stringify({ command: 'proxy', clientId: app.id, requestId, message }));
        return new Promise((res, rej) => {
          pend.set(requestId, res);
          setTimeout(() => { if (pend.has(requestId)) { pend.delete(requestId); rej(new Error('UXP Developer Tool không trả lời (' + message.action + ')')); } }, 20000).unref();
        });
      };
      resolve({ ws, app, req });
    };
  });
}

const readSession = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '');

async function load(plugDir, sessFile) {
  const { ws, app, req } = await connect();
  const sid = readSession(sessFile);
  if (sid) {
    const r = await req({ command: 'Plugin', action: 'reload', pluginSessionId: sid });
    if (!r.error) { console.log('✓ Đã reload bản DEV trong Premiere ' + app.app.appVersion); ws.close(); return; }
    // Session cũ không còn (Premiere đã khởi động lại…) → load mới.
  }
  const r = await req({ command: 'Plugin', action: 'load', params: { provider: { type: 'disk', path: plugDir } }, breakOnStart: false });
  if (r.error || !r.pluginSessionId) { ws.close(); fail('Load lỗi: ' + (r.error || JSON.stringify(r))); }
  fs.writeFileSync(sessFile, r.pluginSessionId);
  console.log('✓ Đã load bản DEV vào Premiere ' + app.app.appVersion + ' — mở Window → Extensions → Claude AI DEV');
  ws.close();
}

async function unload(sessFile) {
  const sid = readSession(sessFile);
  if (!sid) { console.log('· Không có bản DEV nào đang load'); return; }
  try {
    const { ws, req } = await connect();
    const r = await req({ command: 'Plugin', action: 'unload', pluginSessionId: sid });
    console.log(r.error ? '· Gỡ: ' + r.error : '✓ Đã gỡ bản DEV khỏi Premiere');
    ws.close();
  } catch (e) { console.log('· ' + e.message); }
  fs.rmSync(sessFile, { force: true });
}

async function evaluate(sessFile, src) {
  const sid = readSession(sessFile);
  if (!sid) fail('Chưa load bản DEV — chạy: bash dev.sh');
  const expr = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
  const { ws, req } = await connect();
  const d = await req({ command: 'Plugin', action: 'debug', pluginSessionId: sid });
  if (!d.wsdebugUrl) { ws.close(); fail('Không mở được debug: ' + (d.error || JSON.stringify(d))); }
  const cdp = new WebSocket('ws://' + String(d.wsdebugUrl).replace(/^ws=/, ''));
  let cid = 0;
  const cp = new Map(), ctxs = [], logs = [];
  cdp.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && cp.has(m.id)) { cp.get(m.id)(m); cp.delete(m.id); }
    else if (m.method === 'Runtime.executionContextCreated') ctxs.push(m.params.context);
    else if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + m.params.args.map(x => (x.value !== undefined ? x.value : x.description || '')).join(' '));
  };
  const call = (method, params) => { const id = ++cid; cdp.send(JSON.stringify({ id, method, params })); return new Promise(r => cp.set(id, r)); };
  await new Promise(r => { cdp.onopen = r; });
  await call('Runtime.enable', {});
  await sleep(600);
  const ctx = ctxs.length ? { contextId: ctxs[0].id } : {};
  const wrapped = 'window.__devOut = null; Promise.resolve((' + expr.trim().replace(/;$/, '') + ')).then('
    + "function (v) { window.__devOut = (typeof v === 'string') ? v : JSON.stringify(v); },"
    + "function (e) { window.__devOut = 'ERR ' + ((e && (e.stack || e.message)) || e); }); 'started'";
  const start = await call('Runtime.evaluate', Object.assign({ expression: wrapped, returnByValue: true }, ctx));
  if (start.result && start.result.exceptionDetails) { cdp.close(); ws.close(); fail('Lỗi cú pháp: ' + JSON.stringify(start.result.exceptionDetails.exception || start.result.exceptionDetails).slice(0, 500)); }
  let out = null;
  for (let i = 0; i < 1200 && out == null; i++) {
    await sleep(500);
    const rr = await call('Runtime.evaluate', Object.assign({ expression: 'window.__devOut', returnByValue: true }, ctx));
    out = rr.result && rr.result.result ? rr.result.result.value : null;
  }
  logs.forEach(l => console.error('[panel] ' + l.slice(0, 600)));
  console.log(out == null ? '(hết giờ chờ kết quả)' : out);
  cdp.close(); ws.close();
}

const [, , cmd, a, b] = process.argv;
try {
  if (cmd === 'load') await load(a, b);
  else if (cmd === 'unload') await unload(a);
  else if (cmd === 'eval') await evaluate(a, b);
  else fail('Dùng: load <plugin dir> <session> | unload <session> | eval <session> <file.js|->');
} catch (e) { fail(e.message); }
