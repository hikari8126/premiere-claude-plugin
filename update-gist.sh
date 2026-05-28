#!/bin/bash
# update-gist.sh — Cập nhật Gist version manifest
# Dùng sau mỗi lần release: bash update-gist.sh
set -e
cd "$(dirname "$0")"

GIST_ID="8fb346e839dedd559dfc60317b1456cf"

# ── Đọc versions từ source ────────────────────────────────────────────────
BRIDGE_VERSION=$(grep -A1 'CFBundleShortVersionString' bridge-app/build-app.sh \
  | grep '<string>' | head -1 | grep -o '[0-9.]*')
PLUGIN_VERSION=$(grep '"version"' plugin/manifest.json | grep -o '[0-9.]*' | head -1)

if [ -z "$BRIDGE_VERSION" ] || [ -z "$PLUGIN_VERSION" ]; then
  echo "❌ Không đọc được version. Kiểm tra build-app.sh và manifest.json"
  exit 1
fi

# ── Tìm release tag ────────────────────────────────────────────────────────
TAG="v${PLUGIN_VERSION}-bridge${BRIDGE_VERSION}"
BASE_URL="https://github.com/hikari8126/premiere-claude-plugin/releases/download/${TAG}"

echo ""
echo "  Bridge:  ${BRIDGE_VERSION}"
echo "  Plugin:  ${PLUGIN_VERSION}"
echo "  Tag:     ${TAG}"
echo ""

# ── Ghi JSON ra file tạm (không dùng python encode để tránh double-encode) ─
TMP=$(mktemp /tmp/version_XXXXX.json)
cat > "$TMP" << JSON
{
  "version": "${BRIDGE_VERSION}",
  "url": "https://github.com/hikari8126/premiere-claude-plugin/releases/latest",
  "notes": "Bridge ${BRIDGE_VERSION} / Plugin ${PLUGIN_VERSION}",
  "downloadUrl": "${BASE_URL}/premiere-claude-plugin-v${PLUGIN_VERSION}.zip",
  "pluginVersion": "${PLUGIN_VERSION}",
  "pluginDownloadUrl": "${BASE_URL}/claude-ai-assistant-v${PLUGIN_VERSION}.ccx"
}
JSON

echo "  📄 Nội dung Gist:"
cat "$TMP"
echo ""

# ── Upload dùng -f (không dùng --field để tránh double-encode) ───────────
gh api --method PATCH "/gists/${GIST_ID}" \
  -f "files[version.json][content]=$(cat "$TMP")" > /dev/null

rm "$TMP"

# ── Verify ────────────────────────────────────────────────────────────────
echo "  🔍 Verify từ CDN..."
sleep 2
RESULT=$(curl -s "https://gist.githubusercontent.com/hikari8126/${GIST_ID}/raw/version.json?t=$(date +%s)")
echo "$RESULT" | python3 -m json.tool > /dev/null 2>&1 && echo "  ✅ JSON hợp lệ" || echo "  ❌ JSON không hợp lệ!"
echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print('  version:', d['version'], '/ pluginVersion:', d['pluginVersion'])"

echo ""
echo "  ✅ Gist đã cập nhật: https://gist.github.com/hikari8126/${GIST_ID}"
echo ""
