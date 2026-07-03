#!/bin/bash
# ── build-app.sh — Build Claude Bridge.app + Installer ────────────────────
set -e
cd "$(dirname "$0")/.."   # run from project root

APP_NAME="Claude Bridge"
APP_DIR="${APP_NAME}.app"
INSTALLER_NAME="Installer Claude AI"
INSTALLER_DIR="${INSTALLER_NAME}.app"
SDK=$(xcrun --show-sdk-path)
MACOS_MIN="13.0"
PLUGIN_VERSION=$(grep '"version"' plugin/manifest.json | grep -o '[0-9.]*' | head -1)

echo ""
echo "╔════════════════════════════════════════════════╗"
echo "║   Build Claude Bridge.app + Installer          ║"
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

SWIFT_FLAGS="-framework Cocoa -framework Foundation -framework Carbon -sdk ${SDK} -Onone -Xfrontend -strict-concurrency=minimal"

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
cat > "${APP_DIR}/Contents/Info.plist" << PLIST
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
    <string>2.36</string>
  <key>CFBundleShortVersionString</key>
    <string>2.36</string>
  <key>PluginVersion</key>
    <string>${PLUGIN_VERSION}</string>
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

# ── 7. Build Installer.app ────────────────────────────────────────────────
echo ""
echo "  🔨 Building Installer Claude AI.app..."

[ -d "$INSTALLER_DIR" ] && rm -rf "$INSTALLER_DIR" && echo "  🗑  Removed old installer build"

mkdir -p "${INSTALLER_DIR}/Contents/MacOS"
mkdir -p "${INSTALLER_DIR}/Contents/Resources"

# Compile installer Swift app (universal binary)
echo "     → arm64..."
swiftc installer-app/main.swift -o /tmp/installer-arm64 \
  -target arm64-apple-macosx${MACOS_MIN} ${SWIFT_FLAGS} 2>&1 \
  | grep -vE "^$|warning:" || true

echo "     → x86_64..."
swiftc installer-app/main.swift -o /tmp/installer-x64 \
  -target x86_64-apple-macosx${MACOS_MIN} ${SWIFT_FLAGS} 2>&1 \
  | grep -vE "^$|warning:" || true

echo "     → lipo (universal binary)..."
lipo -create /tmp/installer-arm64 /tmp/installer-x64 \
  -output "${INSTALLER_DIR}/Contents/MacOS/${INSTALLER_NAME}"
chmod +x "${INSTALLER_DIR}/Contents/MacOS/${INSTALLER_NAME}"

# Info.plist for installer
VERSION=$(grep '"version"' plugin/manifest.json | grep -o '[0-9.]*' | head -1)
cat > "${INSTALLER_DIR}/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
    <string>com.claudeai.installer</string>
  <key>CFBundleName</key>
    <string>Installer Claude AI</string>
  <key>CFBundleDisplayName</key>
    <string>Installer Claude AI</string>
  <key>CFBundleExecutable</key>
    <string>Installer Claude AI</string>
  <key>CFBundleVersion</key>
    <string>${VERSION}</string>
  <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
  <key>CFBundlePackageType</key>
    <string>APPL</string>
  <key>NSHighResolutionCapable</key>
    <true/>
  <key>NSAppleEventsUsageDescription</key>
    <string>Installer Claude AI dùng Terminal để cài Node.js và Homebrew nếu cần.</string>
  <key>NSPrincipalClass</key>
    <string>NSApplication</string>
</dict>
</plist>
PLIST

echo "  ✅ Installer compiled"

# Bundle Claude Bridge.app + CCX inside installer Resources
echo "  📦 Bundling Claude Bridge.app inside installer..."
CCX_TMP_FILE="plugin.ccx"
[ -f "$CCX_TMP_FILE" ] && rm "$CCX_TMP_FILE"

# Build CCX first so we can embed it
zip -j "$CCX_TMP_FILE" \
  plugin/manifest.json \
  plugin/index.html \
  plugin/main.js \
  plugin/styles.css \
  plugin/premiere-api.js \
  -x "*.DS_Store" > /dev/null

cp -r "${APP_DIR}"     "${INSTALLER_DIR}/Contents/Resources/Claude Bridge.app"
cp    "$CCX_TMP_FILE"  "${INSTALLER_DIR}/Contents/Resources/plugin.ccx"
rm    "$CCX_TMP_FILE"

# Sign installer
codesign --force --deep --sign - "${INSTALLER_DIR}" 2>&1 | grep -v "^$" || true

INST_SIZE=$(du -sh "${INSTALLER_DIR}" | cut -f1)
echo "  ✅ Installer: ${INSTALLER_DIR}  (${INST_SIZE})"
echo ""

# ── 8. Create CCX (UXP plugin installer — double-click to install) ────────
VERSION=$(grep '"version"' plugin/manifest.json | grep -o '[0-9.]*' | head -1)
CCX_FILE="claude-ai-assistant-v${VERSION}.ccx"

[ -f "$CCX_FILE" ] && rm "$CCX_FILE"

zip -j "$CCX_FILE" \
  plugin/manifest.json \
  plugin/index.html \
  plugin/main.js \
  plugin/styles.css \
  plugin/premiere-api.js \
  -x "*.DS_Store"

CCX_SIZE=$(du -sh "$CCX_FILE" | cut -f1)
echo "  ✅ CCX: ${CCX_FILE}  (${CCX_SIZE})"

# ── 9. Create distribution zip ────────────────────────────────────────────
DIST_ZIP="premiere-claude-plugin-v${VERSION}.zip"

[ -f "$DIST_ZIP" ] && rm "$DIST_ZIP"

# Primary: installer-only zip (all-in-one)
zip -r "$DIST_ZIP" \
  "${INSTALLER_DIR}" \
  README.md \
  -x "*.DS_Store" -x "__MACOSX/*"

DIST_SIZE=$(du -sh "$DIST_ZIP" | cut -f1)

# Also create a "manual" zip for advanced users (bridge app + CCX separate)
MANUAL_ZIP="premiere-claude-plugin-v${VERSION}-manual.zip"
[ -f "$MANUAL_ZIP" ] && rm "$MANUAL_ZIP"
zip -r "$MANUAL_ZIP" \
  "${APP_DIR}" \
  "$CCX_FILE" \
  plugin/manifest.json \
  plugin/index.html \
  plugin/main.js \
  plugin/styles.css \
  CLAUDE.md \
  README.md \
  -x "*.DS_Store" -x "__MACOSX/*"
MANUAL_SIZE=$(du -sh "$MANUAL_ZIP" | cut -f1)

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🎯 Installer (all-in-one): ${DIST_ZIP}  (${DIST_SIZE})"
echo "  📦 Manual install:  ${MANUAL_ZIP}  (${MANUAL_SIZE})"
echo "  🔌 Plugin CCX:      ${CCX_FILE}  (${CCX_SIZE})"
echo ""
echo "  Hướng dẫn cho teammate (Installer):"
echo "  1. Tải ${DIST_ZIP}"
echo "  2. Giải nén → double-click 'Installer Claude AI.app'"
echo "     (lần đầu: right-click → Open)"
echo "  3. Click 'Cài đặt ngay' — xong!"
echo ""
echo "  Hướng dẫn manual (${MANUAL_ZIP}):"
echo "  1. Kéo 'Claude Bridge.app' vào Applications"
echo "  2. Double-click '${CCX_FILE}' → Creative Cloud cài plugin"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
