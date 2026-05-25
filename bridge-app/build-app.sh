#!/bin/bash
# ── build-app.sh — Build Claude Bridge.app ────────────────────────────────
set -e
cd "$(dirname "$0")/.."   # run from project root

APP_NAME="Claude Bridge"
APP_DIR="${APP_NAME}.app"
SDK=$(xcrun --show-sdk-path)
MACOS_MIN="13.0"

echo ""
echo "╔════════════════════════════════════════════════╗"
echo "║   Build Claude Bridge.app — menubar edition    ║"
echo "╚════════════════════════════════════════════════╝"
echo ""

# ── 0. Clean previous build ───────────────────────────────────────────────
[ -d "$APP_DIR" ] && rm -rf "$APP_DIR" && echo "  🗑  Removed old build"

# ── 1. Create .app structure ──────────────────────────────────────────────
mkdir -p "${APP_DIR}/Contents/MacOS"
mkdir -p "${APP_DIR}/Contents/Resources/server"
echo "  📁 App bundle structure created"

# ── 2. Compile Swift (arm64 + x86_64 universal) ───────────────────────────
echo ""
echo "  🔨 Compiling Swift app..."

SWIFT_FLAGS="-framework Cocoa -framework Foundation -sdk ${SDK} -Onone -Xfrontend -strict-concurrency=minimal"

echo "     → arm64..."
swiftc bridge-app/main.swift -o /tmp/cb-arm64 \
  -target arm64-apple-macosx${MACOS_MIN} ${SWIFT_FLAGS} 2>&1 \
  | grep -vE "^$|warning:" | grep -v "^$" || true

echo "     → x86_64..."
swiftc bridge-app/main.swift -o /tmp/cb-x64 \
  -target x86_64-apple-macosx${MACOS_MIN} ${SWIFT_FLAGS} 2>&1 \
  | grep -vE "^$|warning:" | grep -v "^$" || true

echo "     → lipo (universal binary)..."
lipo -create /tmp/cb-arm64 /tmp/cb-x64 -output "${APP_DIR}/Contents/MacOS/${APP_NAME}"
chmod +x "${APP_DIR}/Contents/MacOS/${APP_NAME}"
echo "  ✅ Swift compiled — universal binary"

# ── 3. Bundle bridge server ───────────────────────────────────────────────
echo ""
echo "  📦 Bundling bridge server + node_modules..."

cp    bridge/server.js          "${APP_DIR}/Contents/Resources/server/"
cp    bridge/package.json       "${APP_DIR}/Contents/Resources/server/"
cp    bridge/.env.example       "${APP_DIR}/Contents/Resources/server/.env.example"
cp -r bridge/node_modules       "${APP_DIR}/Contents/Resources/server/"

echo "  ✅ server.js + node_modules bundled (no npm install needed)"

# ── 4. Info.plist ─────────────────────────────────────────────────────────
cat > "${APP_DIR}/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
    <string>com.claudeai.bridge</string>
  <key>CFBundleName</key>
    <string>Claude Bridge</string>
  <key>CFBundleDisplayName</key>
    <string>Claude Bridge</string>
  <key>CFBundleExecutable</key>
    <string>Claude Bridge</string>
  <key>CFBundleVersion</key>
    <string>4.1.2</string>
  <key>CFBundleShortVersionString</key>
    <string>4.1.2</string>
  <key>CFBundlePackageType</key>
    <string>APPL</string>
  <key>NSHighResolutionCapable</key>
    <true/>
  <key>LSUIElement</key>
    <true/>
  <key>NSAppleEventsUsageDescription</key>
    <string>Claude Bridge dùng Terminal để cài Claude CLI và đăng nhập Claude.ai.</string>
  <key>NSPrincipalClass</key>
    <string>NSApplication</string>
</dict>
</plist>
PLIST
echo "  ✅ Info.plist written"

# ── 5. Ad-hoc code sign (allows running without Gatekeeper block) ─────────
echo ""
echo "  🔏 Code signing (ad-hoc)..."
codesign --force --deep --sign - "${APP_DIR}" 2>&1 | grep -v "^$" || true
echo "  ✅ Signed"

# ── 6. Summary ────────────────────────────────────────────────────────────
SIZE=$(du -sh "${APP_DIR}" | cut -f1)
echo ""
echo "  ✅ Built: ${APP_DIR}  (${SIZE})"
echo ""
echo "  Để test: open '${APP_DIR}'"
echo "  Nếu bị block: right-click → Open → Open"
echo ""

# ── 7. Create distribution zip ────────────────────────────────────────────
VERSION=$(grep '"version"' plugin/manifest.json | grep -o '[0-9.]*' | head -1)
DIST_ZIP="premiere-claude-plugin-v${VERSION}.zip"

[ -f "$DIST_ZIP" ] && rm "$DIST_ZIP"

zip -r "$DIST_ZIP" \
  "${APP_DIR}" \
  plugin/manifest.json \
  plugin/index.html \
  plugin/main.js \
  plugin/styles.css \
  CLAUDE.md \
  README.md \
  -x "*.DS_Store" -x "__MACOSX/*"

DIST_SIZE=$(du -sh "$DIST_ZIP" | cut -f1)
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  📦 Distribution: ${DIST_ZIP}  (${DIST_SIZE})"
echo ""
echo "  Hướng dẫn cho teammate:"
echo "  1. Giải nén zip"
echo "  2. Kéo 'Claude Bridge.app' vào Applications"
echo "  3. Double-click để chạy (lần đầu: right-click → Open)"
echo "  4. Load thư mục plugin/ vào UXP Developer Tool"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
