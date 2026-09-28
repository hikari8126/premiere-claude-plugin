#!/bin/bash
# publish-install.sh — Đẩy install.sh sang repo releases (public) để link cài một lệnh chạy được.
# Chỉ cần chạy khi install.sh thay đổi; install.sh tự lấy bản release mới nhất.
#   bash publish-install.sh "install.sh: mô tả thay đổi"
set -e
cd "$(dirname "$0")"

RELEASE_REPO="${RELEASE_REPO:-hikari8126/premiere-claude-plugin-releases}"
MSG="${1:-install.sh: cập nhật}"
API="repos/${RELEASE_REPO}/contents/install.sh"

bash -n install.sh || { echo "❌ install.sh lỗi cú pháp"; exit 1; }

SHA=$(gh api "$API" -q .sha 2>/dev/null || true)
ARGS=(-X PUT "$API" -f message="$MSG" -f content="$(base64 -i install.sh)")
[ -n "$SHA" ] && ARGS+=(-f sha="$SHA")
gh api "${ARGS[@]}" -q .commit.html_url

echo "✅ Link cài đặt:"
echo "   curl -fsSL https://raw.githubusercontent.com/${RELEASE_REPO}/main/install.sh | bash"
