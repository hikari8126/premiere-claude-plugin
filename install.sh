#!/bin/bash
# ── install.sh — Cài toàn bộ Claude AI Plugin bằng một lệnh ────────────────
#
#   curl -fsSL https://raw.githubusercontent.com/hikari8126/premiere-claude-plugin-releases/main/install.sh | bash
#
# Tuỳ chọn (thêm sau `bash -s --`):
#   --no-whisper   bỏ qua Whisper (~1GB, chỉ Autocut cần)
#   --dry-run      chỉ kiểm tra + tải thử bản release, không cài gì
#
# Chạy lại lệnh này = cập nhật lên bản mới nhất; thứ gì đã có sẽ được bỏ qua.
#
# File gốc nằm ở repo build; repo releases chỉ giữ bản copy để link trên public.
# Sửa ở repo build rồi đẩy sang — xem AGENTS.md mục "Phát hành".

set -euo pipefail

RELEASE_REPO="hikari8126/premiere-claude-plugin-releases"
APP_DEST="/Applications/Claude Bridge.app"
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"

WITH_WHISPER=1
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --no-whisper) WITH_WHISPER=0 ;;
    --dry-run)    DRY_RUN=1 ;;
    *) echo "Tuỳ chọn không hợp lệ: $arg"; exit 1 ;;
  esac
done

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$HOME/.npm-global/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

ok()   { echo "  ✅ $*"; }
info() { echo "  📦 $*"; }
warn() { echo "  ⚠️  $*"; }
die()  { echo ""; echo "  ❌ $*"; echo ""; exit 1; }
step() { echo ""; echo "▸ $*"; }
have() { command -v "$1" &>/dev/null; }

# Khi chạy qua `curl | bash`, stdin là nội dung script chứ không phải bàn phím.
# Lệnh cần người gõ (mật khẩu, đăng nhập) phải đọc từ /dev/tty.
TTY=/dev/null
if [ -r /dev/tty ] && (exec </dev/tty) 2>/dev/null; then TTY=/dev/tty; fi

# ── 0. Hệ thống ─────────────────────────────────────────────────────────────
check_system() {
  [ "$(uname -s)" = "Darwin" ] || die "Script này chỉ chạy trên macOS."
  step "macOS $(sw_vers -productVersion) · $(uname -m)"
  [ "$DRY_RUN" = 1 ] && warn "Chế độ --dry-run: chỉ kiểm tra, không cài gì."
  return 0
}

# ── 1. Homebrew ─────────────────────────────────────────────────────────────
ensure_brew() {
  step "Homebrew"
  if have brew; then ok "đã có ($(brew --version | head -1))"; return; fi
  if [ "$DRY_RUN" = 1 ]; then info "[dry-run] sẽ cài Homebrew"; return; fi
  [ "$TTY" = /dev/tty ] || die "Cần cài Homebrew nhưng không có Terminal để nhập mật khẩu. Hãy chạy lệnh này trong app Terminal."
  info "Đang cài Homebrew — macOS sẽ hỏi mật khẩu máy tính..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" <"$TTY"
  local bin
  for bin in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$bin" ] && eval "$("$bin" shellenv)" && break
  done
  have brew || die "Cài Homebrew không thành công."
  # Để Terminal lần sau cũng thấy brew / node / claude
  local line="eval \"\$($(command -v brew) shellenv)\""
  grep -qsF "$line" "$HOME/.zprofile" || echo "$line" >> "$HOME/.zprofile"
  ok "Homebrew đã cài xong"
}

brew_install() {  # brew_install <formula> <lệnh kiểm tra>
  if have "$2"; then ok "$1 — đã có"; return; fi
  if [ "$DRY_RUN" = 1 ]; then info "[dry-run] sẽ cài $1"; return; fi
  have brew || die "Không có Homebrew để cài $1."
  info "Đang cài $1..."
  brew install "$1" || die "Cài $1 không thành công."
  ok "$1 đã cài xong"
}

# ── 2. Node.js ──────────────────────────────────────────────────────────────
ensure_node() {
  step "Node.js"
  if have node; then
    local major; major=$(node -p 'process.versions.node.split(".")[0]')
    if [ "$major" -ge 18 ]; then ok "đã có ($(node --version))"; return; fi
    warn "Node $(node --version) quá cũ (cần v18+)"
    if [ "$DRY_RUN" = 1 ]; then info "[dry-run] sẽ nâng Node"; return; fi
    have brew && brew install node && ok "đã nâng lên $(node --version)" && return
    die "Không nâng được Node — cài bản mới tại https://nodejs.org rồi chạy lại."
  fi
  brew_install node node
}

# ── 3. Claude CLI + đăng nhập ───────────────────────────────────────────────
ensure_claude() {
  step "Claude CLI"
  if have claude; then
    ok "đã có ($(claude --version 2>/dev/null | head -1))"
  elif [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] sẽ cài @anthropic-ai/claude-code"; return
  else
    have npm || die "Không có npm để cài Claude CLI."
    info "Đang cài Claude CLI..."
    if ! npm install -g @anthropic-ai/claude-code; then
      # Node cài từ nodejs.org → thư mục global cần sudo. Chuyển sang ~/.npm-global
      # (Bridge app có tìm ở đây).
      warn "npm global không ghi được — chuyển sang ~/.npm-global"
      mkdir -p "$HOME/.npm-global"
      npm config set prefix "$HOME/.npm-global"
      npm install -g @anthropic-ai/claude-code || die "Cài Claude CLI không thành công."
      local line='export PATH="$HOME/.npm-global/bin:$PATH"'
      grep -qsF "$line" "$HOME/.zprofile" || echo "$line" >> "$HOME/.zprofile"
    fi
    have claude || die "Đã cài Claude CLI nhưng không tìm thấy lệnh claude."
    ok "Claude CLI đã cài xong"
  fi

  if claude auth status 2>/dev/null | grep -qiE '"loggedIn": *true|logged in as'; then
    ok "đã đăng nhập Claude"
  elif [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] sẽ mở đăng nhập Claude"
  elif [ "$TTY" = /dev/tty ]; then
    info "Đăng nhập Claude — trình duyệt sẽ mở, đăng nhập tài khoản Pro/Max..."
    claude auth login <"$TTY" || warn "Chưa đăng nhập được — làm lại sau trong plugin (tab Claude) hoặc chạy: claude auth login"
  else
    warn "Chưa đăng nhập Claude — sau khi cài xong, chạy: claude auth login"
  fi
}

# ── 4. ffmpeg + Python + Whisper ────────────────────────────────────────────
find_whisper() {
  have whisper && return 0
  local p
  for p in /Library/Frameworks/Python.framework/Versions/3.*/bin/whisper \
           /Library/Python/3.*/bin/whisper \
           "$HOME"/Library/Python/3.*/bin/whisper "$HOME/.local/bin/whisper"; do
    [ -x "$p" ] && return 0
  done
  return 1
}

ensure_media_tools() {
  step "ffmpeg"
  brew_install ffmpeg ffmpeg

  step "Python 3 (engine Raw-cutter)"
  if have python3 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' 2>/dev/null; then
    ok "đã có ($(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])'))"
  else
    brew_install python3 python3
  fi

  step "Whisper (nhận diện giọng nói cho Autocut)"
  if [ "$WITH_WHISPER" = 0 ]; then warn "bỏ qua (--no-whisper)"; return; fi
  if find_whisper; then ok "đã có"; return; fi
  have pip3 || brew_install python3 pip3
  if [ "$DRY_RUN" = 1 ]; then info "[dry-run] sẽ cài openai-whisper qua pip3"; return; fi
  info "Đang cài Whisper (~1GB, vài phút)..."
  # Python của Homebrew chặn pip cài vào hệ thống (PEP 668) → thử lại với cờ cho phép.
  pip3 install -U openai-whisper || pip3 install -U openai-whisper --break-system-packages \
    || { warn "Cài Whisper không thành công — Autocut sẽ dùng transcript của Premiere. Các phần khác vẫn chạy."; return; }
  find_whisper && ok "Whisper đã cài xong" \
    || warn "Đã cài nhưng chưa thấy lệnh whisper — kiểm tra lại qua menu 🐍 của Claude Bridge."
}

# ── 5. Tải bản release mới nhất ─────────────────────────────────────────────
WORK=""
cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; return 0; }
trap cleanup EXIT

download_release() {
  step "Tải bản mới nhất"
  local latest
  latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${RELEASE_REPO}/releases/latest") \
    || die "Không kết nối được GitHub."
  TAG="${latest##*/}"                       # v5.9.1-bridge3.14
  case "$TAG" in v*-bridge*) ;; *) die "Không đọc được bản release mới nhất (nhận: $latest)";; esac
  PLUGIN_VER="${TAG%-bridge*}"; PLUGIN_VER="${PLUGIN_VER#v}"
  BRIDGE_VER="${TAG##*-bridge}"
  info "Plugin ${PLUGIN_VER} · Bridge ${BRIDGE_VER}"

  WORK=$(mktemp -d "${TMPDIR:-/tmp}/claude-ai-install.XXXXXX")
  local zip="premiere-claude-plugin-v${PLUGIN_VER}-manual.zip"
  curl -fL --progress-bar -o "$WORK/$zip" \
    "https://github.com/${RELEASE_REPO}/releases/download/${TAG}/${zip}" \
    || die "Tải $zip không thành công."
  ditto -x -k "$WORK/$zip" "$WORK/pkg" || die "Giải nén $zip không thành công."

  NEW_APP="$WORK/pkg/Claude Bridge.app"
  CCX="$WORK/pkg/claude-ai-assistant-v${PLUGIN_VER}.ccx"
  [ -x "$NEW_APP/Contents/MacOS/Claude Bridge" ] || die "Bản tải về thiếu Claude Bridge.app."
  [ -f "$CCX" ] || die "Bản tải về thiếu claude-ai-assistant-v${PLUGIN_VER}.ccx."
  ok "đã tải và kiểm tra ($(du -sh "$WORK/$zip" | cut -f1))"
}

# ── 6. Claude Bridge.app → /Applications ────────────────────────────────────
install_bridge() {
  step "Claude Bridge → /Applications"
  if [ -d "$APP_DEST" ]; then
    local cur; cur=$(defaults read "$APP_DEST/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "?")
    info "bản đang có: $cur → thay bằng $BRIDGE_VER"
  fi
  if [ "$DRY_RUN" = 1 ]; then info "[dry-run] sẽ chép Claude Bridge.app"; return; fi

  pkill -f "$APP_DEST/Contents/MacOS/" 2>/dev/null && sleep 1 || true
  local bak="${APP_DEST}.bak"
  rm -rf "$bak"
  [ -d "$APP_DEST" ] && mv "$APP_DEST" "$bak"
  if ditto "$NEW_APP" "$APP_DEST"; then
    rm -rf "$bak"
  else
    rm -rf "$APP_DEST"; [ -d "$bak" ] && mv "$bak" "$APP_DEST"
    die "Không chép được vào /Applications (bản cũ đã được giữ nguyên)."
  fi
  xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || true
  ok "Claude Bridge ${BRIDGE_VER} đã cài"
}

# ── 7. Plugin CCX → Premiere Pro ────────────────────────────────────────────
install_plugin() {
  step "Plugin → Premiere Pro"
  if [ ! -x "$UPIA" ]; then
    warn "Không thấy trình cài plugin của Adobe (cần Creative Cloud Desktop)."
    [ "$DRY_RUN" = 1 ] && { info "[dry-run] sẽ mở file .ccx bằng Creative Cloud"; return; }
    cp "$CCX" "$HOME/Downloads/" && open "$HOME/Downloads/$(basename "$CCX")"
    warn "Đã mở $(basename "$CCX") — bấm Install trong hộp thoại Creative Cloud."
    return
  fi
  if [ "$DRY_RUN" = 1 ]; then info "[dry-run] sẽ cài $(basename "$CCX")"; return; fi
  local out
  if out=$("$UPIA" --install "$CCX" 2>&1); then
    ok "Claude AI Assistant ${PLUGIN_VER} đã cài vào Premiere"
  else
    echo "$out" | tail -5 | sed 's/^/     /'
    cp "$CCX" "$HOME/Downloads/" && open "$HOME/Downloads/$(basename "$CCX")"
    warn "Cài tự động không được — đã mở file .ccx, bấm Install trong hộp thoại Creative Cloud."
  fi
}

# ── 8. Khởi động Bridge + kiểm tra ──────────────────────────────────────────
start_bridge() {
  step "Khởi động Claude Bridge"
  if [ "$DRY_RUN" = 1 ]; then info "[dry-run] sẽ mở Claude Bridge"; return; fi
  open "$APP_DEST"
  local i
  for i in $(seq 1 30); do
    if curl -fsS --max-time 2 http://localhost:3030/health >/dev/null 2>&1; then
      ok "Bridge đang chạy ở localhost:3030"; return
    fi
    sleep 1
  done
  warn "Bridge chưa trả lời sau 30 giây — bấm icon ⚡ trên thanh menu để xem lỗi."
}

main() {
  echo ""
  echo "╔════════════════════════════════════════════════╗"
  echo "║   Cài đặt Claude AI Plugin cho Premiere Pro    ║"
  echo "╚════════════════════════════════════════════════╝"
  check_system
  ensure_brew
  ensure_node
  ensure_claude
  ensure_media_tools
  download_release
  install_bridge
  install_plugin
  start_bridge
  echo ""
  if [ "$DRY_RUN" = 1 ]; then
    echo "  ✔ Dry-run xong — chạy lại không có --dry-run để cài thật."
  else
    echo "  🎉 Xong! Mở (hoặc khởi động lại) Premiere Pro → Window → Extensions → Claude AI"
  fi
  echo ""
}

# Gọi main ở dòng cuối: nếu `curl | bash` bị đứt giữa chừng thì không chạy nửa script.
main "$@"
