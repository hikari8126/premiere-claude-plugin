# Premiere Claude Plugin — Setup Guide

> **Dành cho Claude:** Đây là dự án UXP plugin cho Adobe Premiere Pro.
> Khi đồng nghiệp nhờ cài đặt, hãy chạy từng lệnh trong phần SETUP theo thứ tự.
> Luôn kiểm tra kết quả từng bước trước khi tiếp tục.

---

## Tổng quan

Plugin 3-in-1 tích hợp thẳng vào Adobe Premiere Pro:
- **Claude AI Chat** — trò chuyện với Claude để edit timeline
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
        ↓ Anthropic SDK hoặc Claude CLI
  Claude AI  (claude-sonnet-4-6 mặc định)
        
  Bridge cũng tích hợp:
  ├── ElevenLabs REST API  (TTS / SFX / Music)
  └── Whisper CLI          (Speech-to-Text cho Autocut)
```

---

## Cấu trúc thư mục

```
premiere-claude-plugin/
├── CLAUDE.md               ← File này
├── README.md               ← Mô tả ngắn
├── plugin/                 ← UXP Plugin (load vào Premiere)
│   ├── manifest.json       ← UXP manifest v5, id: com.claudeai.premiere-assistant
│   ├── index.html          ← UI 3 tab: Claude / Voice Gen / Autocut
│   ├── main.js             ← Toàn bộ logic plugin (~4100 lines, no ES modules)
│   ├── styles.css          ← Dark purple theme (~2200 lines)
│   └── premiere-api.js     ← UNUSED (dead code, kept for reference)
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
which claude && claude --version || echo "Claude CLI: CHƯA CÀI"
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

### Bước 3 — Cài Claude CLI (nếu chưa có)

```bash
npm install -g @anthropic-ai/claude-code
```

**Đăng nhập Claude (1 lần duy nhất):**
```bash
claude login
# Trình duyệt sẽ mở → đăng nhập tài khoản Claude.ai
# Cần gói Pro hoặc Max để dùng được
```

**Kiểm tra:** `claude --version` và thử `echo "hi" | claude --print`

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
- Script tự kiểm tra và cài Homebrew, Node.js, Claude CLI nếu thiếu
- Tự đăng nhập Claude nếu cần
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
   - Plugin xuất hiện trong danh sách với tên "Claude AI"

3. Click **Load** bên cạnh plugin

4. Mở **Adobe Premiere Pro** (phiên bản ≥ 25.6.0)

5. Menu: **Window → Extensions → Claude AI**

> **Lưu ý:** Bridge phải đang chạy (bước 6) trước khi mở plugin trong Premiere.

---

## Cấu hình (tùy chọn)

### Dùng Anthropic API Key (thay cho Claude CLI)

```bash
cp bridge/.env.example bridge/.env
# Mở bridge/.env và điền:
# ANTHROPIC_API_KEY=sk-ant-api03-...
```

API key được ưu tiên hơn CLI. Lấy key tại: https://console.anthropic.com

### Thay đổi Claude model

Trong `bridge/.env`:
```
ANTHROPIC_MODEL=claude-opus-4-7     # mạnh nhất, chậm nhất
ANTHROPIC_MODEL=claude-sonnet-4-6   # mặc định, cân bằng tốt
ANTHROPIC_MODEL=claude-haiku-4-5    # nhanh nhất, rẻ nhất
```

### ElevenLabs (VoiceGen tab)

Không cần cấu hình file — điền API key trực tiếp trong tab **Voice Gen → Settings**.
Lấy key tại: https://elevenlabs.io → Profile → API Keys

---

## Kiểm tra nhanh sau cài đặt

```bash
# 1. Bridge chạy OK?
curl -s http://localhost:3030/health | python3 -m json.tool

# 2. Claude OK?
echo "Trả lời 'OK' thôi" | claude --print

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

### Lỗi "Cannot run claude CLI" / "Authentication required"
```bash
claude login
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
| `/chat` | POST | Stream chat với Claude (SSE) |
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
