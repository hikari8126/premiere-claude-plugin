#!/bin/bash
# tools/dev/build-dev-app.sh — build "Claude Bridge DEV.app" (icon menu bar cho bản DEV) ở gốc repo.
# Chỉ cho máy dev: build theo kiến trúc máy này, ký ad-hoc, không đóng gói/ship.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="Claude Bridge DEV"
APP="$ROOT/$NAME.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
swiftc "$ROOT/tools/dev/BridgeDev.swift" -o "$APP/Contents/MacOS/$NAME" \
  -framework Cocoa -O -Xfrontend -strict-concurrency=minimal 2>&1 | grep -v "warning:" || true
[ -x "$APP/Contents/MacOS/$NAME" ] || { echo "✗ Build Swift lỗi"; exit 1; }

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>com.claudeai.bridge-dev</string>
  <key>CFBundleExecutable</key><string>$NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>ClaudeRepoPath</key><string>$ROOT</string>
</dict>
</plist>
EOF
codesign --force -s - "$APP" >/dev/null 2>&1 || true
echo "✓ Đã build $NAME.app ở gốc repo — mở nó là bản DEV tự chạy (icon DEV trên menu bar)"
