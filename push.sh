#!/bin/bash
# ── push.sh — auto-generate CHANGELOG rồi git push ────────────────────────
# Dùng thay cho `git push`. Flow:
#   1. Lấy diff + commits chưa push
#   2. Gọi claude --print để sinh CHANGELOG entry
#   3. Prepend vào CHANGELOG.md, commit, rồi push
#
# Usage:
#   ./push.sh                  # push branch hiện tại lên origin
#   ./push.sh --no-changelog   # push thẳng, bỏ qua generate
# ──────────────────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$0")"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
REMOTE="origin"
NO_CHANGELOG=0
for arg in "$@"; do
  [ "$arg" = "--no-changelog" ] && NO_CHANGELOG=1
done

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  premiere-claude-plugin — Push              ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "  Branch : $BRANCH → $REMOTE"
echo ""

# ── Kiểm tra commits chưa push ───────────────────────────────────────────
REMOTE_REF="$REMOTE/$BRANCH"
if git rev-parse --verify "$REMOTE_REF" >/dev/null 2>&1; then
  COMMITS=$(git log --oneline "$REMOTE_REF..HEAD" 2>/dev/null)
else
  COMMITS=$(git log --oneline -15 2>/dev/null)
fi

if [ -z "$COMMITS" ] && [ -z "$(git status --porcelain)" ]; then
  echo "  ℹ️  Không có gì để push (up to date)."
  echo ""
  exit 0
fi

echo "  📋 Commits sẽ push:"
echo "$COMMITS" | sed 's/^/     /'
echo ""

# ── Generate CHANGELOG entry ──────────────────────────────────────────────
if [ "$NO_CHANGELOG" = "0" ]; then
  VERSION=$(grep '"version"' plugin/manifest.json | grep -oE '[0-9]+\.[0-9]+\.[0-9a-z.\-]+' | head -1)
  TODAY=$(date '+%Y-%m-%d')

  echo "  🤖 Đang tạo CHANGELOG entry cho v${VERSION}..."

  # Lấy diff các file quan trọng (giới hạn để tránh token quá lớn)
  if git rev-parse --verify "$REMOTE_REF" >/dev/null 2>&1; then
    DIFF_STAT=$(git diff --stat "$REMOTE_REF..HEAD" 2>/dev/null)
    DIFF_CODE=$(git diff "$REMOTE_REF..HEAD" -- \
      plugin/main.js bridge/server.js plugin/index.html plugin/styles.css \
      2>/dev/null | head -600)
  else
    DIFF_STAT=$(git show --stat HEAD 2>/dev/null | tail -10)
    DIFF_CODE=$(git show HEAD -- plugin/main.js bridge/server.js 2>/dev/null | head -600)
  fi

  PROMPT="Bạn là developer senior của project premiere-claude-plugin (UXP plugin cho Adobe Premiere Pro).

Dựa trên commits và diff dưới đây, hãy viết đúng 1 mục CHANGELOG theo format sau — KHÔNG thêm giải thích hay text ngoài format:

## v${VERSION} — ${TODAY}

### ✅ Thêm mới / Cải tiến
- [mô tả ngắn gọn, developer-friendly]

### 🐛 Bugs đã fix
- **[tên bug ngắn gọn]** — Nguyên nhân: [lý do kỹ thuật]. Cách fix: [phương pháp cụ thể, API/function đã dùng]

### 🔧 Kỹ thuật / Approach
- [API/pattern/constraint UXP đã dùng để giải quyết, đủ chi tiết để tái dùng sau]

Nếu không có bugs thì bỏ section 🐛. Viết bằng tiếng Việt, súc tích.

--- COMMITS ---
${COMMITS}

--- FILES CHANGED ---
${DIFF_STAT}

--- CODE DIFF (key files) ---
${DIFF_CODE}"

  ENTRY=$(echo "$PROMPT" | claude --print 2>/dev/null || echo "")

  if [ -z "$ENTRY" ]; then
    echo "  ⚠️  Claude không khả dụng — bỏ qua tạo changelog tự động."
    echo "     (Chạy lại sau hoặc thêm entry vào CHANGELOG.md thủ công)"
    echo ""
  else
    # Prepend entry vào CHANGELOG.md (newest on top, sau header)
    CHANGELOG="CHANGELOG.md"
    HEADER=$(head -5 "$CHANGELOG")
    BODY=$(tail -n +6 "$CHANGELOG")

    {
      echo "$HEADER"
      echo ""
      echo "$ENTRY"
      echo ""
      echo "---"
      echo ""
      echo "$BODY"
    } > "${CHANGELOG}.tmp" && mv "${CHANGELOG}.tmp" "$CHANGELOG"

    echo "  ✅ CHANGELOG.md đã được cập nhật"
    echo ""
    echo "  Preview entry:"
    echo "$ENTRY" | head -20 | sed 's/^/     /'
    echo ""

    # Commit CHANGELOG
    git add CHANGELOG.md
    git commit -m "chore: changelog v${VERSION}" --no-verify
    echo "  📝 Đã commit CHANGELOG.md"
    echo ""
  fi
fi

# ── Git push ──────────────────────────────────────────────────────────────
echo "  🚀 Pushing $BRANCH → $REMOTE..."
git push "$REMOTE" "$BRANCH"

echo ""
echo "  ✅ Push xong!"
echo ""
