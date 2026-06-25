# Premiere Codex Plugin — Setup Guide

> **Dành cho Codex:** Đây là dự án UXP plugin cho Adobe Premiere Pro.
> Khi đồng nghiệp nhờ cài đặt, hãy chạy từng lệnh trong phần SETUP theo thứ tự.
> Luôn kiểm tra kết quả từng bước trước khi tiếp tục.

---

## Tổng quan

Plugin 3-in-1 tích hợp thẳng vào Adobe Premiere Pro:
- **Codex AI Chat** — trò chuyện với Codex để edit timeline
- **ElevenLabs Voice Gen** — tạo giọng đọc / SFX / nhạc nền
- **Autocut** — tự động dựng timeline từ cutsheet script

**Version hiện tại:** 4.1.27  
**Yêu cầu hệ điều hành:** macOS (Apple Silicon hoặc Intel)

---

## Kiến trúc

```
Adobe Premiere Pro
  └── UXP Plugin (plugin/)
        ↓ HTTP POST / SSE  →  localhost:3030
  Bridge Server (bridge/server.js — Node.js + Express)
        ↓ Anthropic SDK hoặc Codex CLI
  Codex AI  (Codex-sonnet-4-6 mặc định)
        
  Bridge cũng tích hợp:
  ├── ElevenLabs REST API  (TTS / SFX / Music)
  └── Whisper CLI          (Speech-to-Text cho Autocut)
```

---

## Cấu trúc thư mục

```
premiere-Codex-plugin/
├── AGENTS.md               ← File này
├── README.md               ← Mô tả ngắn
├── plugin/                 ← UXP Plugin (load vào Premiere)
│   ├── manifest.json       ← UXP manifest v5, id: com.claudeai.premiere-assistant
│   ├── index.html          ← UI 3 tab: Codex / Voice Gen / Autocut
│   ├── main.js             ← Toàn bộ logic plugin (~7300 lines, no ES modules)
│   └── styles.css          ← Dark purple theme (~3350 lines)
├── bridge/
│   ├── server.js           ← Express proxy + Whisper + align logic
│   ├── package.json        ← dependencies: express, cors, dotenv, @anthropic-ai/sdk
│   ├── start.command       ← macOS: double-click để cài + khởi động tự động
│   └── .env.example        ← copy → .env để điền API key (tùy chọn)
└── pack.sh                 ← Script đóng gói zip để gửi đồng nghiệp
```

---

## SETUP — Hướng dẫn cài đặt đầy đủ

### Bước 0 — Kiểm tra hệ thống

```bash
# Kiểm tra macOS
sw_vers -productVersion

# Kiểm tra những gì đã cài
which brew && brew --version || echo "Homebrew: CHƯA CÀI"
which node && node --version  || echo "Node.js: CHƯA CÀI"
which Codex && Codex --version || echo "Codex CLI: CHƯA CÀI"
which python3 && python3 --version || echo "Python: CHƯA CÀI"
which whisper && whisper --help | head -1 || echo "Whisper: CHƯA CÀI (tùy chọn)"
```

---

### Bước 1 — Cài Homebrew (nếu chưa có)

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
# Sau khi cài, thêm vào PATH:
eval "$(/opt/homebrew/bin/brew shellenv)"    # Apple Silicon
# hoặc:
eval "$(/usr/local/bin/brew shellenv)"       # Intel Mac
```

**Kiểm tra:** `brew --version` → in ra phiên bản

---

### Bước 2 — Cài Node.js (nếu chưa có)

```bash
brew install node
```

**Kiểm tra:** `node --version` → phải là v18+ (v20 hoặc v22 khuyến nghị)

---

### Bước 3 — Cài Codex CLI (nếu chưa có)

```bash
npm install -g @anthropic-ai/Codex
```

**Đăng nhập Codex (1 lần duy nhất):**
```bash
Codex login
# Trình duyệt sẽ mở → đăng nhập tài khoản Codex.ai
# Cần gói Pro hoặc Max để dùng được
```

**Kiểm tra:** `Codex --version` và thử `echo "hi" | Codex --print`

> **Thay thế không cần subscription:** Copy `bridge/.env.example` → `bridge/.env`
> và điền `ANTHROPIC_API_KEY=sk-ant-api03-...` (lấy từ console.anthropic.com)

---

### Bước 4 — Cài dependencies bridge

```bash
cd bridge
npm install
```

**Kiểm tra:** thư mục `bridge/node_modules/` xuất hiện

---

### Bước 5 — Cài Whisper (tùy chọn — chỉ cần cho Autocut)

```bash
# Cần Python 3.9–3.12 (Python 3.14 cũng OK)
pip3 install -U openai-whisper

# Kiểm tra
whisper --help | head -3
```

> **Nếu `pip3` báo lỗi externally-managed:**
> ```bash
> pip3 install -U openai-whisper --break-system-packages
> # hoặc dùng venv:
> python3 -m venv ~/whisper-env && source ~/whisper-env/bin/activate
> pip install openai-whisper
> ```

Sau khi cài, tìm đường dẫn whisper:
```bash
which whisper
# Ví dụ: /Library/Frameworks/Python.framework/Versions/3.12/bin/whisper
```

Nếu đường dẫn khác `/Library/Frameworks/Python.framework/Versions/3.14/bin/whisper`,
thêm vào `bridge/.env`:
```
WHISPER_BIN=/đường/dẫn/đến/whisper
```

---

### Bước 6 — Khởi động Bridge Server

**Cách 1 (khuyến nghị):** Double-click file `bridge/start.command`
- Script tự kiểm tra và cài Homebrew, Node.js, Codex CLI nếu thiếu
- Tự đăng nhập Codex nếu cần
- Khởi động server

**Cách 2 (Terminal):**
```bash
cd bridge
node server.js
# Phải thấy dòng: "Bridge running on http://localhost:3030"
```

**Kiểm tra bridge đang chạy:**
```bash
curl http://localhost:3030/health
# Phải trả về: {"status":"ok","mode":"api-key"} hoặc {"status":"ok","mode":"cli"}
```

---

### Bước 7 — Load Plugin vào Premiere Pro

1. Tải **UXP Developer Tool** từ Adobe Creative Cloud Desktop App
   - Creative Cloud → Apps → Tìm "UXP Developer Tool" → Install

2. Mở **UXP Developer Tool**:
   - Click **Add Plugin** → chọn thư mục `plugin/` trong project này
   - Plugin xuất hiện trong danh sách với tên "Codex AI"

3. Click **Load** bên cạnh plugin

4. Mở **Adobe Premiere Pro** (phiên bản ≥ 25.6.0)

5. Menu: **Window → Extensions → Codex AI**

> **Lưu ý:** Bridge phải đang chạy (bước 6) trước khi mở plugin trong Premiere.

---

## Cấu hình (tùy chọn)

### Dùng Anthropic API Key (thay cho Codex CLI)

```bash
cp bridge/.env.example bridge/.env
# Mở bridge/.env và điền:
# ANTHROPIC_API_KEY=sk-ant-api03-...
```

API key được ưu tiên hơn CLI. Lấy key tại: https://console.anthropic.com

### Thay đổi Codex model

Trong `bridge/.env`:
```
ANTHROPIC_MODEL=Codex-opus-4-7     # mạnh nhất, chậm nhất
ANTHROPIC_MODEL=Codex-sonnet-4-6   # mặc định, cân bằng tốt
ANTHROPIC_MODEL=Codex-haiku-4-5    # nhanh nhất, rẻ nhất
```

### ElevenLabs (VoiceGen tab)

Không cần cấu hình file — điền API key trực tiếp trong tab **Voice Gen → Settings**.
Lấy key tại: https://elevenlabs.io → Profile → API Keys

---

## Kiểm tra nhanh sau cài đặt

```bash
# 1. Bridge chạy OK?
curl -s http://localhost:3030/health | python3 -m json.tool

# 2. Codex OK?
echo "Trả lời 'OK' thôi" | Codex --print

# 3. Whisper OK? (tùy chọn)
whisper --version

# 4. ElevenLabs OK? (cần API key)
curl -s "https://api.elevenlabs.io/v1/user" \
  -H "xi-api-key: YOUR_KEY_HERE" | python3 -m json.tool
```

---

## Troubleshooting

### Plugin báo "Bridge offline"
```bash
# Kiểm tra bridge có đang chạy không
curl http://localhost:3030/health
# Nếu lỗi → khởi động lại: cd bridge && node server.js
# Kiểm tra port 3030 có bị chặn không
lsof -i :3030
```

### Lỗi "Cannot run Codex CLI" / "Authentication required"
```bash
Codex login
# Sau đó restart bridge
```

### Lỗi npm install
```bash
# Xóa node_modules và cài lại
cd bridge && rm -rf node_modules package-lock.json && npm install
```

### Plugin không hiện trong Premiere
- Kiểm tra UXP Developer Tool → plugin phải ở trạng thái "Loaded"
- Premiere Pro phải là phiên bản ≥ 25.6.0
- Thử: Window → Workspaces → Reset to Saved Layout

### Whisper không tìm thấy
```bash
# Tìm đường dẫn đúng
find /Library /usr/local /opt/homebrew -name "whisper" -type f 2>/dev/null
# Hoặc
python3 -c "import whisper; print('whisper installed')"
# Thêm WHISPER_BIN= vào bridge/.env với đường dẫn tìm được
```

### Phím tắt Premiere bị bắt (B/V/C/etc.)
Plugin tự xử lý keyboard focus — click vào vùng trắng trong plugin rồi click lại vào textarea.

---

## Thông tin kỹ thuật (cho developer)

### UXP Constraints quan trọng
- **Không dùng:** `position:fixed`, `z-index`, `display:grid`, `window.innerWidth`, `title=""` attribute, `new Audio()`
- **Scrolling:** Phải dùng `flex:1 1 0; min-height:0; overflow-y:auto` trên **inner child**, không phải flex container
- **Tất cả Premiere API async:** `getStart()`, `getEnd()`, clip name, track count — đều phải `await`
- **Keyboard:** `window.claimKeyboard()` / `window.releaseKeyboard()` trên focus/blur của input
- **ES Modules:** Không dùng — `main.js` là non-module script (không có `import`/`export`)
- **Persistence:** localStorage (sync) + UXP `getDataFolder()` file (async backup)

### Bridge endpoints

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/health` | GET | Kiểm tra bridge + mode (api-key / cli) |
| `/chat` | POST | Stream chat với Codex (SSE) |
| `/tts` | POST | ElevenLabs TTS |
| `/tts/voices` | POST | Lấy danh sách voices |
| `/tts/sfx` | POST | ElevenLabs Sound FX |
| `/tts/music` | POST | ElevenLabs Music |
| `/transcribe` | POST | Whisper hoặc Premiere transcript |
| `/align` | POST | Align script lines với word timestamps |

### Lệnh dev thường dùng

```bash
# Chạy bridge với auto-reload
cd bridge && npm run dev

# Xem log bridge realtime
cd bridge && node server.js 2>&1 | tee bridge.log

# Reload plugin trong UXP Developer Tool
# → Click "Reload" trong UXP Dev Tool (không cần restart Premiere)
```

---

## Phát hành (Release) — để cả team auto-update

> ⚠️ **QUAN TRỌNG:** Build zip phân phối bằng `bridge-app/build-app.sh`, **KHÔNG dùng `pack.sh`**.
> `pack.sh` chỉ tạo zip ~180KB chứa source code (gửi thủ công). Zip thật phải ~4.3MB và
> chứa `Installer Claude AI.app/.../Claude Bridge.app` — Bridge auto-updater tải zip này
> rồi tìm `Claude Bridge.app` bên trong; thiếu → lỗi `Install failed: Claude Bridge.app not found in zip`.

Quy trình release đầy đủ:

```bash
# 1. Bump version: plugin/manifest.json + PLUGIN_VERSION trong plugin/main.js
#    (Bridge version nằm ở bridge-app/build-app.sh: CFBundleShortVersionString)

# 2. Commit + push source
git add -A && git commit -m "feat(vX.Y.Z): ..." && git push origin main

# 3. Build artifacts THẬT (Installer app + Bridge.app + ccx + 2 zip)
bash bridge-app/build-app.sh
#    → premiere-claude-plugin-vX.Y.Z.zip        (all-in-one ~4.3MB, có Bridge.app)
#    → premiere-claude-plugin-vX.Y.Z-manual.zip (Bridge.app + ccx rời)
#    → claude-ai-assistant-vX.Y.Z.ccx           (UXP plugin package)

# 4. Tag + GitHub release (tag format: v{plugin}-bridge{bridgeApp})
git tag vX.Y.Z-bridge{BRIDGE} && git push origin vX.Y.Z-bridge{BRIDGE}
gh release create vX.Y.Z-bridge{BRIDGE} --title "..." --notes "..." \
  claude-ai-assistant-vX.Y.Z.ccx \
  premiere-claude-plugin-vX.Y.Z.zip \
  premiere-claude-plugin-vX.Y.Z-manual.zip

# 5. Trỏ Gist version manifest sang release mới → team nhận thông báo update
bash update-gist.sh
```

**Kiểm tra trước khi báo team:**
```bash
# Dist zip phải ~4MB và chứa Claude Bridge.app
unzip -l premiere-claude-plugin-vX.Y.Z.zip | grep "Claude Bridge.app/Contents/MacOS"
# Download công khai phải trả về content-length lớn (không phải ~180KB)
curl -sIL ".../premiere-claude-plugin-vX.Y.Z.zip" | grep -i content-length
```

> `.zip`/`.ccx` đã `.gitignore` — chỉ upload lên GitHub Release, không commit vào repo.
