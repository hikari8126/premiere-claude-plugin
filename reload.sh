#!/bin/bash
# Khi dùng UXP Developer Tool: chỉ cần bấm ↺ Reload trong Dev Tool
# Script này chỉ dùng khi KHÔNG dùng Dev Tool (fallback)

DEST="$HOME/Library/Application Support/Adobe/UXP/Plugins/External/com.claudeai.premiere-assistant_1.0.0"
SRC="$(dirname "$0")/plugin"

echo "📋 Copying plugin files..."
cp "$SRC/main.js"    "$DEST/main.js"
cp "$SRC/styles.css" "$DEST/styles.css"
cp "$SRC/index.html" "$DEST/index.html"
cp "$SRC/manifest.json" "$DEST/manifest.json"

VERSION=$(grep "PLUGIN_VERSION" "$SRC/main.js" | grep -o "'v[^']*'" | tr -d "'")
echo "✓ Synced $VERSION to Premiere Extensions folder"
echo ""
echo "→ Trong Premiere: Window > Extensions > Claude AI (đóng & mở lại)"
