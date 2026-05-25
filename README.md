# Premiere Claude Plugin

Chat với Claude AI trực tiếp trong Premiere Pro để edit timeline, thêm subtitle, apply effects, và hơn nữa.

## Kiến trúc

```
Premiere Pro (UXP Plugin)
        ↓  HTTP / SSE
Local Bridge Server (Node.js :3030)
        ↓  claude CLI
Claude Code (đã authenticate sẵn)
```

Không cần API key riêng — dùng luôn Claude Code đã cài sẵn.

---

## Cài đặt

### 1. Cài Node.js (nếu chưa có)
```bash
brew install node
```

### 2. Khởi động Bridge Server
Double-click file `bridge/start.command`  
hoặc chạy:
```bash
cd bridge
npm install
node server.js
```
Server sẽ chạy tại `http://localhost:3030`.

### 3. Cài UXP Plugin vào Premiere Pro
1. Mở **Adobe UXP Developer Tool** (tải từ Creative Cloud)
2. Chọn **Add Plugin** → trỏ đến thư mục `plugin/`
3. Click **Load** → plugin xuất hiện trong Premiere Pro dưới **Window → Extensions → Claude AI**

---

## Sử dụng

| Task | Ví dụ prompt |
|------|-------------|
| Xem timeline | "Give me an overview of my timeline" |
| Cắt clip | "Cut the first clip at 5 seconds" |
| Thêm subtitle | "Add subtitle 'Hello World' from 0 to 3 seconds" |
| Apply effect | "Apply Lumetri Color to clip 0 on track 0" |
| Thêm marker | "Add a marker at 10s called Scene 2" |
| Color grade | "Suggest a cinematic color grade and apply it" |

---

## Actions Claude có thể thực hiện

Claude trả về JSON trong block ` ```actions ``` `, plugin tự động execute:

```json
[
  { "action": "get_timeline_info" },
  { "action": "cut_clip", "trackIndex": 0, "clipIndex": 0, "time": 5.0 },
  { "action": "add_subtitle", "text": "Hello", "startTime": 0, "endTime": 3.0 },
  { "action": "apply_effect", "trackIndex": 0, "clipIndex": 0, "effectName": "Lumetri Color" },
  { "action": "add_marker", "time": 10.0, "name": "Scene 2", "color": "red" },
  { "action": "set_volume", "trackIndex": 0, "clipIndex": 0, "volumeDb": -6 }
]
```

---

## Cấu trúc files

```
premiere-claude-plugin/
├── bridge/
│   ├── server.js          ← Express server, gọi claude CLI
│   ├── package.json
│   └── start.command      ← Double-click để start (macOS)
└── plugin/
    ├── manifest.json      ← UXP plugin manifest
    ├── index.html         ← Panel UI
    ├── main.js            ← Logic: giao tiếp bridge + execute actions
    ├── premiere-api.js    ← Wrapper cho Premiere UXP APIs
    └── styles.css
```

---

## Troubleshooting

**"Bridge offline"** — Chạy `bridge/start.command` trước khi mở Premiere.

**"Cannot run claude CLI"** — Đảm bảo Claude Code đã được cài và `claude` có trong PATH:
```bash
which claude   # should print a path
claude --version
```

**Action không chạy được** — Một số API (apply_effect, subtitles) cần Premiere Pro 22+. Kiểm tra Console trong UXP Developer Tool.

---

## v1.4 — Autocut với STT-based voiceover sync

Plugin có 2 tab: **CLAUDE** (chat) và **AUTOCUT** (cutsheet → timeline).

### Quy trình

```
[1] User paste cutsheet (text dạng table) vào tab CLAUDE
        ↓
[2] Claude parse → emit ```actions [{action:"cutlist", rows:[...]}]```
        ↓
[3] Plugin tự switch sang tab AUTOCUT, render preview các dòng cut
        ↓
[4] Chế độ Auto: tự chạy luôn. Chế độ Semi: chờ user bấm PUSH
        ↓
[5] Plugin tìm voiceover audio clip dài nhất trên A1 → STT
        ↓
[6] Align từng dòng script với từ trong transcript → V[n] duration
        ↓
[7] Tính pair boundary: boundary[n+1] = boundary[n] + MAX(S[n].dur, V[n].dur)
        ↓
[8] Run transaction: insert clips vào sequence (V1, A1)
```

### Pair boundary rule

Với mỗi cặp (Source_n, Voice_n):
- Cả hai bắt đầu cùng tại `boundary[n-1]`
- Cặp tiếp theo bắt đầu tại `boundary[n-1] + MAX(S_n.duration, V_n.duration)`
- Track ngắn hơn có gap (silence cho audio, đen cho video)

### STT Engines

**1. Whisper Local** (mặc định, free, offline)
- Cần Python whisper: `pip install -U openai-whisper`
- Config qua `.env`: `WHISPER_BIN`, `WHISPER_MODEL` (tiny/base/small/medium/large), `WHISPER_LANG`
- Tốc độ: ~5x realtime với `base`; ~1x với `medium`

**2. Premiere Transcript** (dùng feature built-in của Premiere)
- Bước 1: `Window → Text → Transcript → Transcribe Sequence`
- Bước 2: Export ra .json hoặc .transcript
- Bước 3: Paste path file vào ô input trong tab Autocut

### Cutsheet format

Claude tự parse, nhưng càng rõ ràng càng tốt. Ví dụ:

```
Script                                    | Cut range  | Source
Oh my gosh, you look amazing!            | 0:02-0:08  | k11 o1
Honestly? It feels like it was made...   | 0:01-0:07  | k11.1 o2
Easy front closure, no reaching           | 0:01       | Senyue 46
                                          | 0:01       | Senyue 99
```

Quy tắc parse:
- `0:02-0:08` → sourceIn=2.0, sourceOut=8.0 giây
- `0:01` (chỉ start) → mặc định cut 1 giây
- Ô gộp (merged cells) → emit nhiều rows với cùng script hoặc cùng source
- Source name khớp Project Panel **theo fuzzy match** (token-based scoring)
- Source name dạng `output v22.0` / `v22.0` → match **sequence** (nested sequence insert)

### Action format

```json
{ "action": "cutlist",
  "rows": [
    {"source": "k11 o1", "sourceIn": 2.0, "sourceOut": 8.0, "script": "Oh my gosh..."},
    {"source": "Senyue 46", "sourceIn": 0.0, "sourceOut": 1.0, "script": "Easy front closure"}
  ]
}
```

### Bridge endpoints mới

| Endpoint | Body | Trả về |
|----------|------|--------|
| `POST /transcribe` | `{backend: "whisper" \| "premiere", audioPath \| transcriptPath, language?}` | `{words: [{text,start,end}], segments, fullText}` |
| `POST /align` | `{words, scriptLines: string[]}` | `{alignments: [{start, end, matched, status}]}` |

### Known limitations (v1.4.0)

- ⚠️ **Trim sau insert chưa implement** — clip được insert ở full duration. v1.4.1 sẽ thêm 2-pass trim.
- ⚠️ **"Create New Sequence" button hiện reuse active sequence** — v1.4.1 sẽ implement `createSequence()`.
- ⚠️ **Image cutsheet chưa support** — paste text dạng table; image OCR cần v1.5.
- ⚠️ **Voiceover detection = audio clip dài nhất trên A1** — chỉ đúng với sequence đơn giản. Sequence phức tạp có thể cần manual chọn.
