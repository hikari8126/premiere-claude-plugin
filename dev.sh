#!/bin/bash
# dev.sh — chạy BẢN DEV của plugin + bridge song song với bản đang cài.
#
#   bash dev.sh            dựng lại bản DEV từ plugin/, khởi động lại bridge dev, load/reload vào Premiere
#   bash dev.sh stop       gỡ bản DEV khỏi Premiere, tắt bridge dev
#   bash dev.sh log        xem log bridge dev (tail -f)
#   bash dev.sh eval f.js  chạy biểu thức JS trong panel DEV (in kết quả) — để dò API Premiere
#   bash dev.sh app        build "Claude Bridge DEV.app" (icon menu bar làm hết việc trên) rồi mở nó
#
# Bản DEV: id com.claudeai.premiere-assistant-dev, panel "Claude AI DEV"
# (Window → Extensions), bridge chạy code trong repo ở port 3035 (DEV_PORT để đổi).
# Bản cài (Claude AI + Claude Bridge.app ở 3030) không bị đụng. Mọi thứ dựng ra nằm ở .dev/.
# Cần: Premiere đang mở + app "Adobe UXP Developer Tools" đang chạy, Node ≥ 22.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DEV="$ROOT/.dev"
PLUG="$DEV/plugin"
PORT="${DEV_PORT:-3035}"
TOOL="$ROOT/tools/dev/uxp-devtools.mjs"
SESSION="$DEV/plugin.session"
PIDF="$DEV/bridge.pid"
LOG="$DEV/bridge.log"

build_plugin() {
  rm -rf "$PLUG"
  mkdir -p "$DEV"
  cp -R "$ROOT/plugin" "$PLUG"
  # id/tên riêng + trỏ bridge sang port dev. localStorage của bản DEV cũng riêng.
  node - "$PLUG" "$PORT" <<'EOF'
const fs = require('fs'), path = require('path');
const [dir, port] = process.argv.slice(2);
const mf = path.join(dir, 'manifest.json');
const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
m.id += '-dev';
m.name += ' DEV';
(m.entrypoints || []).forEach(e => { if (e.label && e.label.default) e.label.default += ' DEV'; });
const doms = m.requiredPermissions.network.domains;
['http://localhost:' + port, 'http://127.0.0.1:' + port].forEach(d => { if (!doms.includes(d)) doms.push(d); });
fs.writeFileSync(mf, JSON.stringify(m, null, 2));
let n = 0;
for (const f of fs.readdirSync(dir)) {
  if (!/\.(js|html)$/.test(f)) continue;
  const p = path.join(dir, f);
  const s = fs.readFileSync(p, 'utf8');
  const t = s.replace(/localhost:3030/g, () => { n++; return 'localhost:' + port; });
  if (t !== s) fs.writeFileSync(p, t);
}
if (!n) { console.error('✗ Không thấy localhost:3030 nào trong plugin/ — bản DEV sẽ gọi nhầm bridge thật'); process.exit(1); }
console.log('✓ Dựng bản DEV ở .dev/plugin (bridge → localhost:' + port + ', ' + n + ' chỗ)');
EOF
}

# PID đang nghe PORT, chỉ khi đó là bridge chạy từ thư mục bridge/ của repo này.
dev_bridge_on_port() {
  local pid
  for pid in $(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do
    if lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep -qx "n$ROOT/bridge"; then echo "$pid"; fi
  done
}

stop_bridge() {
  local pid
  if [ -f "$PIDF" ]; then
    pid="$(cat "$PIDF")"
    kill "$pid" 2>/dev/null || true
    rm -f "$PIDF"
  fi
  # Bridge dev mồ côi (pid file mất / lần chạy trước bị ngắt) cũng dọn luôn.
  for pid in $(dev_bridge_on_port); do kill "$pid" 2>/dev/null || true; done
  for _ in $(seq 1 20); do
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || return 0
    sleep 0.25
  done
}

start_bridge() {
  stop_bridge
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "✗ Port $PORT đang bị chương trình khác dùng — đặt DEV_PORT=... rồi chạy lại"; exit 1
  fi
  if [ ! -d "$ROOT/bridge/node_modules" ]; then (cd "$ROOT/bridge" && npm install --silent); fi
  mkdir -p "$DEV/data/watchfolder"
  # WATCHFOLDER_DIR riêng: watch của bản DEV không chung hàng đợi import với bridge thật.
  # cd trước rồi mới đưa riêng node vào nền — để $! là PID của node, không phải subshell.
  ( cd "$ROOT/bridge" || exit 1
    PORT="$PORT" WATCHFOLDER_DIR="$DEV/data/watchfolder" nohup node server.js >"$LOG" 2>&1 &
    echo $! >"$PIDF" )
  for _ in $(seq 1 40); do
    if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
      echo "✓ Bridge dev chạy ở http://localhost:$PORT (log: .dev/bridge.log)"; return
    fi
    sleep 0.25
  done
  echo "✗ Bridge dev không lên — xem log:"; tail -20 "$LOG"; exit 1
}

case "${1:-start}" in
  start|reload)
    build_plugin
    start_bridge
    node "$TOOL" load "$PLUG" "$SESSION"
    ;;
  stop)
    node "$TOOL" unload "$SESSION" || true
    stop_bridge
    echo "✓ Đã tắt bridge dev"
    ;;
  log)
    tail -f "$LOG"
    ;;
  app)
    bash "$ROOT/tools/dev/build-dev-app.sh"
    open "$ROOT/Claude Bridge DEV.app"
    ;;
  eval)
    [ -n "${2:-}" ] || { echo "Dùng: bash dev.sh eval <file.js | ->"; exit 1; }
    node "$TOOL" eval "$SESSION" "$2"
    ;;
  *)
    echo "Dùng: bash dev.sh [start|stop|log|app|eval <file.js>]"; exit 1
    ;;
esac
