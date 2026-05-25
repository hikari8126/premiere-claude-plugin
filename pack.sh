#!/bin/bash
# ── pack.sh — đóng gói plugin để gửi đồng nghiệp ──────────────────────────
set -e
cd "$(dirname "$0")"

VERSION=$(grep '"version"' plugin/manifest.json | grep -o '[0-9.]*' | head -1)
OUT="premiere-claude-plugin-v${VERSION}.zip"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Premiere Claude Plugin — Pack v${VERSION}       ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# Xóa file cũ nếu có
[ -f "$OUT" ] && rm "$OUT" && echo "  🗑  Đã xóa bản cũ: $OUT"

# Đảm bảo start.command có quyền thực thi
chmod +x bridge/start.command

# Tạo zip
zip -r "$OUT" \
  CLAUDE.md \
  README.md \
  plugin/manifest.json \
  plugin/index.html \
  plugin/main.js \
  plugin/styles.css \
  bridge/server.js \
  bridge/package.json \
  bridge/start.command \
  bridge/.env.example \
  -x "*.DS_Store" \
  -x "__MACOSX/*" \
  -x "*.log"

SIZE=$(du -sh "$OUT" | cut -f1)

echo ""
echo "  ✅ Đã tạo: $OUT  ($SIZE)"
echo ""
echo "  📋 Nội dung zip:"
zip -sf "$OUT" | grep -v "^Archive" | head -20
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  📤 Gửi file này cho đồng nghiệp."
echo ""
echo "  Hướng dẫn cho người nhận:"
echo "  1. Giải nén file zip"
echo "  2. Double-click  bridge/start.command"
echo "     (hoặc nhờ Claude đọc CLAUDE.md để được hỗ trợ cài đặt)"
echo "  3. Làm theo hướng dẫn trên màn hình"
echo "  4. Load thư mục plugin/ vào UXP Developer Tool"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
