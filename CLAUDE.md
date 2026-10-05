# Premiere Claude Plugin — Setup Guide

> **Dành cho Claude:** Đây là dự án UXP plugin cho Adobe Premiere Pro.
> Khi đồng nghiệp nhờ cài đặt, hãy chạy từng lệnh trong phần SETUP theo thứ tự.
> Luôn kiểm tra kết quả từng bước trước khi tiếp tục.

---

## Tổng quan

Plugin tích hợp thẳng vào Adobe Premiere Pro:
- **Tab Claude (Clawd)** — chế độ **Lệnh**: Claude (Opus 5.5) hiểu ý rồi điều phối các tab (mở tab, đẩy script/SFX sang Voice Gen, sắp bảng Autocut, **Resize**, chuẩn bị **RAW**), xem bin/item trong project (MCP premiere) và đề xuất chuyển item / sắp bin voice — mọi thay đổi project đều qua thẻ xem trước + bấm xác nhận; chế độ **Hỏi tự do**: research (tìm web, đọc file trong thư mục sản phẩm). Nhật ký 20 lệnh gần nhất. **⚙ Tuỳ biến** theo từng member: nút lệnh có biến `{bộ}`, quy trình nhiều bước, ghi chú riêng gửi kèm mọi lệnh, xuất/nhập `.json`; **tự học**: gợi ý lưu nút khi lặp lại, Claude đề xuất ghi nhớ, đọc quy ước bin/tên từ project
- **ElevenLabs Voice Gen** — tạo giọng đọc / SFX / nhạc nền
- **Autocut** — tự động dựng timeline từ cutsheet script
- **Raw Cut** — cắt từng cut của timeline ra file riêng (raw/ từ file gốc, edited/ do Premiere render) + clips.csv/manifest.json
- **Đổi tên source hàng loạt** (tab Watch) — đổi tên file trên đĩa theo mẫu, relink clip Premiere + `.aep`, có hoàn tác

**Version hiện tại:** 5.17.0 (Bridge app 3.20 · server 1.24.0)  
**Yêu cầu hệ điều hành:** macOS (Apple Silicon hoặc Intel)

---

## Kiến trúc

```
Adobe Premiere Pro
  └── UXP Plugin (plugin/)
        ↓ HTTP POST / SSE  →  localhost:3030
  Bridge Server (bridge/server.js — Node.js + Express)
        ↓ Anthropic SDK hoặc Claude CLI
  Claude AI  (claude-opus-5-5 mặc định; CLI cần ≥ 2.1.280, cũ hơn thì CLI tự chọn model)
        
  Bridge cũng tích hợp:
  ├── ElevenLabs REST API  (TTS / SFX / Music)
  └── Whisper CLI          (Speech-to-Text cho Autocut)
  └── xmlcut.py (Python)   (engine Raw Cut — bridge/rawcut-engine/, cần python3 ≥3.8 + ffmpeg)
```

---

## Cấu trúc thư mục

```
premiere-claude-plugin/
├── CLAUDE.md               ← File này
├── README.md               ← Mô tả ngắn
├── plugin/                 ← UXP Plugin (load vào Premiere)
│   ├── manifest.json       ← UXP manifest v5, id: com.claudeai.premiere-assistant
│   ├── index.html          ← UI 2 trang tab: Voice Gen · Autocut · Tạo Sub · Un-nest | Watch · Resize · RAW
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

### Cách nhanh nhất — một lệnh (khuyến nghị cho member)

```bash
curl -fsSL https://raw.githubusercontent.com/hikari8126/premiere-claude-plugin-releases/main/install.sh | bash
```

Cài Homebrew, Node.js, Claude CLI (+ đăng nhập), ffmpeg, Whisper, `Claude Bridge.app` và plugin `.ccx`
bản mới nhất, rồi khởi động Bridge. Thứ gì đã có thì bỏ qua — chạy lại cùng lệnh để cập nhật.
Thêm `bash -s -- --no-whisper` để bỏ Whisper, `--dry-run` để chỉ kiểm tra.
Người dùng chỉ phải nhập mật khẩu máy (khi cài Homebrew) và đăng nhập Claude trên trình duyệt.
Nguồn: `install.sh` ở repo này. Các bước dưới đây là cách cài thủ công từ source.

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
ANTHROPIC_MODEL=claude-opus-5-5     # mặc định
ANTHROPIC_MODEL=claude-sonnet-5-5   # nhanh hơn, rẻ hơn
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
| `/chat` | POST | Tab Claude (SSE): `mode` command (giao việc cho tab) / free (Hỏi tự do — research); đọc file thư mục project + tìm web, chặn chạy lệnh/sửa file; `notes` (ghi chú member) + `projectFacts` (quy ước project) nối cuối prompt |
| `/open-url` | POST | Mở link http(s) trong câu trả lời tab Claude bằng trình duyệt mặc định |
| `/chat/tool-call` | POST | MCP premiere gọi tool đọc project (project_bins / list_bin / find_items) — trả lời từ bản chụp bin/item plugin gửi kèm `/chat` |
| `/tts` | POST | ElevenLabs TTS |
| `/tts/voices` | POST | Lấy danh sách voices |
| `/tts/sfx` | POST | ElevenLabs Sound FX |
| `/tts/music` | POST | ElevenLabs Music |
| `/transcribe` | POST | Whisper hoặc Premiere transcript |
| `/align` | POST | Align script lines với word timestamps |
| `/notify` | POST | Thông báo macOS khi pipeline chạm mốc |
| `/autoset/names` | POST | Dựng tên sequence/bin/voice cho bộ 3 video |
| `/autoset/voicedir` | POST | Tìm/tạo thư mục Voice Over/{bộ}x cạnh file .prproj |
| `/watch/session/start` | POST | Mở session watch cho một project, quét bù file rơi lúc panel đóng |
| `/watch/session/stop` | POST | Quét lượt cuối, ghi snapshot, dừng quét |
| `/watch/poll` | GET | Lấy tối đa 20 file chờ import + thống kê |
| `/watch/ack` | POST | Báo file đã import xong / thất bại (thất bại 3 lần → dead) |
| `/watch/config` | GET/POST | Đọc/ghi danh sách watch của project hiện tại |
| `/watch/scan-now` | POST | Đối chiếu một watch: đẩy file đã có sẵn về hàng đợi để plugin so với project |
| `/watch/browse` | GET | Liệt kê thư mục con (mặc định mở ở cấp cha của thư mục chứa .prproj) |
| `/fs/exists` | POST | File đã có chưa (Tạo Sub hỏi trước khi ghi đè .srt) |
| `/rawcut/status` | GET | Raw-cutter: python3 / ffmpeg / engine `xmlcut.py` có sẵn chưa |
| `/rawcut/scan` | POST | Lưu dump + FCP XML cạnh .prproj, engine đọc cut list (`--manifest-only`, `half: source\|render`) |
| `/rawcut/export` | POST | SSE: engine cắt vào thư mục xuất (raw/ hoặc edited/ + `renderDir`); đóng request = Dừng |
| `/rawcut/dest` | POST | Thư mục xuất `<Sản phẩm>/Output/ACT/<vN>/raw\|edited` theo SAMX_WORKSPACE, version đọc từ tên sequence |
| `/rawcut/render-cache` | POST | Thư mục cache cho Premiere render từng cut (+ dọn bản > 7 ngày, dung lượng trống) |
| `/rawcut/render-cache/clean` | POST | Xoá cache render sau lượt xuất sạch |
| `/rawcut/render-preset` | POST | Preset H.264 "Match Source" đã chỉnh bitrate theo CRF |
| `/rawcut/presets` | POST | Liệt kê / lưu / xoá preset chất lượng |
| `/rawcut/stat` · `/rawcut/unlink` | POST | Kiểm tra / xoá file render trong cache (chỉ trong cache) |
| `/rawcut/open` | POST | Mở thư mục xuất trong Finder |
| `/rename/plan` | POST | Đổi tên source: kiểm tra tên/trùng trên đĩa, quét `.aep` trong thư mục sản phẩm, cờ `aeRunning` |
| `/rename/siblings` | POST | File media cùng thư mục với source mà project chưa import (đổi tên cho đủ bộ) |
| `/rename/apply` | POST | Đổi tên file 2 pha (lỗi → tự đổi về), ghi nhật ký lượt, trả `batchId` |
| `/rename/revert` | POST | Đổi riêng vài file của lượt về tên cũ (plugin relink lỗi) |
| `/rename/note` | POST | Ghi clip đã chuyển bin trong lượt (Hoàn tác chuyển về bin cũ) |
| `/rename/aep` | POST | Sửa `fullpath` trong các `.aep` đã tick theo lượt (backup 7 ngày) |
| `/rename/journal` · `/rename/undo` | GET · POST | Lượt gần nhất của project / hoàn tác lượt đó (file + `.aep`) |

### Lệnh dev thường dùng

```bash
# Chạy bridge với auto-reload
cd bridge && npm run dev

# Xem log bridge realtime
cd bridge && node server.js 2>&1 | tee bridge.log

# Reload plugin trong UXP Developer Tool
# → Click "Reload" trong UXP Dev Tool (không cần restart Premiere)
```

### Bản DEV chạy song song bản đang cài

**Không cần Terminal:** chạy `bash dev.sh app` một lần để build **Claude Bridge DEV.app** (ở gốc repo,
không commit). Từ đó chỉ cần mở app: icon **DEV** trên menu bar (● xanh = bridge dev đang chạy,
… = đang dựng, ✕ = lỗi) tự dựng + load bản DEV; menu có *Dựng lại & reload* (⌘R),
*Tự reload khi sửa code* (bật sẵn — lưu file trong `plugin/` hoặc `bridge/` là tự reload),
*Tắt bản DEV*, *Xem log*; *Thoát* là gỡ plugin DEV + tắt bridge dev. Kéo app vào Dock/Login Items tuỳ ý.

Lệnh tương đương:

```bash
bash dev.sh          # dựng .dev/plugin (id …-dev, panel "Claude AI DEV"), bridge repo ở :3035, load/reload vào Premiere
bash dev.sh stop     # gỡ bản DEV khỏi Premiere + tắt bridge dev
bash dev.sh log      # tail log bridge dev
bash dev.sh eval f.js  # chạy biểu thức JS trong panel DEV, in kết quả (dò API Premiere)
```

Bản cài (Claude AI + Claude Bridge.app ở :3030) không bị đụng; bản DEV có localStorage và hàng đợi
Watch folder riêng. Cần Premiere đang mở + app **Adobe UXP Developer Tools** đang chạy, Node ≥ 22.
Mỗi lần sửa code chạy lại `bash dev.sh` (dựng lại + khởi động lại bridge + reload panel).
