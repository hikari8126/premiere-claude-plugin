#!/bin/bash
# ── release.sh — tạo GitHub Release trên repo PUBLIC + cập nhật gist ─────────
# Source code ở repo private; release assets (.ccx + .zip) đẩy sang repo public
# riêng để đồng nghiệp tải được không cần đăng nhập.
#
# Usage:
#   ./release.sh path/to/claude-ai-assistant-vX.Y.Z.ccx path/to/premiere-claude-plugin-vX.Y.Z.zip
#   (nếu bỏ trống → tự tìm .ccx / .zip theo version trong thư mục hiện tại)
# ──────────────────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$0")"

RELEASE_REPO="${RELEASE_REPO:-hikari8126/premiere-claude-plugin-releases}"

BRIDGE_VERSION=$(grep -A1 'CFBundleShortVersionString' bridge-app/build-app.sh \
  | grep '<string>' | head -1 | grep -o '[0-9.]*')
PLUGIN_VERSION=$(grep '"version"' plugin/manifest.json | grep -o '[0-9.]*' | head -1)
TAG="v${PLUGIN_VERSION}-bridge${BRIDGE_VERSION}"

CCX="${1:-claude-ai-assistant-v${PLUGIN_VERSION}.ccx}"
ZIP="${2:-premiere-claude-plugin-v${PLUGIN_VERSION}.zip}"

echo ""
echo "  Repo release : ${RELEASE_REPO}"
echo "  Tag          : ${TAG}"
echo "  Assets       : ${CCX}  |  ${ZIP}"
echo ""

for f in "$CCX" "$ZIP"; do
  [ -f "$f" ] || { echo "❌ Không thấy file: $f"; exit 1; }
done

# Tạo (hoặc cập nhật) release trên repo PUBLIC. --target main để tag bám vào commit README.
if gh release view "$TAG" -R "$RELEASE_REPO" >/dev/null 2>&1; then
  echo "  ↻ Release ${TAG} đã tồn tại → upload đè assets"
  gh release upload "$TAG" "$CCX" "$ZIP" -R "$RELEASE_REPO" --clobber
else
  gh release create "$TAG" "$CCX" "$ZIP" \
    -R "$RELEASE_REPO" \
    --target main \
    --title "$TAG" \
    --notes "Plugin ${PLUGIN_VERSION} / Bridge ${BRIDGE_VERSION}"
fi

echo ""
echo "  📡 Cập nhật gist manifest..."
bash update-gist.sh

echo ""
echo "  ✅ Release xong: https://github.com/${RELEASE_REPO}/releases/tag/${TAG}"
echo ""
