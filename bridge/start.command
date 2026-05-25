#!/bin/bash
cd "$(dirname "$0")"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Premiere Claude Bridge — Setup & Start  ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Helpers ────────────────────────────────────────────────────────────────
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

_brew() { command -v brew &>/dev/null; }
_node() { command -v node &>/dev/null; }
_claude() { command -v claude &>/dev/null; }

# ── 0. Homebrew ────────────────────────────────────────────────────────────
echo "▸ Kiểm tra Homebrew..."
if _brew; then
  echo "  ✅ Homebrew — OK"
else
  echo "  📦 Chưa có Homebrew. Đang cài (cần mật khẩu máy tính)..."
  echo "     Có thể mất 2-5 phút, vui lòng đợi..."
  echo ""
  NONINTERACTIVE=1 /bin/bash -c \
    "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Kích hoạt brew cho phiên hiện tại
  [ -f /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
  [ -f /usr/local/bin/brew ]    && eval "$(/usr/local/bin/brew shellenv)"
  if _brew; then
    echo "  ✅ Homebrew đã cài xong"
  else
    echo "  ⚠️  Homebrew cài không thành công — bỏ qua, thử cài Node.js trực tiếp"
  fi
fi

# ── 1. Node.js ─────────────────────────────────────────────────────────────
echo ""
echo "▸ Kiểm tra Node.js..."
if _node; then
  echo "  ✅ Node.js $(node --version) — OK"
else
  echo "  ⚠️  Node.js chưa được cài."
  if _brew; then
    echo "  📦 Đang cài Node.js qua Homebrew..."
    brew install node
    _node && echo "  ✅ Node.js $(node --version) đã cài xong"
  fi
  if ! _node; then
    echo "  📦 Thử tải Node.js package trực tiếp..."
    ARCH=$(uname -m)
    [ "$ARCH" = "arm64" ] && PKG="node-lts.pkg" || PKG="node-lts.pkg"
    open "https://nodejs.org/en/download"
    echo ""
    echo "  Cài Node.js xong rồi chạy lại file này."
    read -p "  Bấm Enter để thoát..." _
    exit 1
  fi
fi

# ── 2. Claude CLI ──────────────────────────────────────────────────────────
echo ""
echo "▸ Kiểm tra Claude CLI..."
if command -v claude &>/dev/null; then
  echo "  ✅ Claude CLI — OK"
else
  echo "  📦 Đang cài Claude CLI..."
  npm install -g @anthropic-ai/claude-code 2>&1 | grep -E "added|error|warn" | head -5
  # Reload PATH sau khi cài global
  export PATH="$(npm root -g)/../.bin:$PATH"
  if command -v claude &>/dev/null; then
    echo "  ✅ Claude CLI đã cài xong"
  else
    echo "  ❌ Không tìm thấy claude sau khi cài."
    echo "     Thử chạy thủ công: npm install -g @anthropic-ai/claude-code"
    read -p "  Bấm Enter để thoát..." _
    exit 1
  fi
fi

# ── 3. npm dependencies ────────────────────────────────────────────────────
echo ""
echo "▸ Kiểm tra dependencies..."
if [ ! -d node_modules ]; then
  echo "  📦 Đang chạy npm install..."
  npm install
  echo "  ✅ Dependencies đã cài xong"
else
  echo "  ✅ node_modules — OK"
fi

# ── 4. Claude authentication ───────────────────────────────────────────────
echo ""
echo "▸ Kiểm tra đăng nhập Claude..."
AUTH_TEST=$(echo "hi" | env -i \
  PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin" \
  HOME="$HOME" USER="$USER" TMPDIR="$TMPDIR" TERM="xterm-256color" \
  claude --print 2>&1 | head -2)

if echo "$AUTH_TEST" | grep -qiE "authenticate|401|Invalid|login|not logged|OAuth|sign in"; then
  echo ""
  echo "  ⚠️  Chưa đăng nhập. Cần đăng nhập 1 lần duy nhất."
  echo "      Trình duyệt sẽ mở — đăng nhập tài khoản Claude.ai của bạn."
  echo ""
  read -p "  Bấm Enter để mở trình duyệt đăng nhập..." _
  claude login
  echo ""
  echo "  ✅ Đăng nhập xong!"
else
  echo "  ✅ Đã đăng nhập — OK"
fi

# ── 5. Start bridge ────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════"
echo "  🚀 Bridge đang chạy tại port 3030"
echo "  ⚠️  Giữ cửa sổ này mở trong khi dùng plugin"
echo "  ✖  Ctrl+C để dừng"
echo "══════════════════════════════════════════"
echo ""
node server.js
