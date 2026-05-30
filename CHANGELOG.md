# CHANGELOG — premiere-claude-plugin

> Mỗi entry ghi rõ: lỗi gì, nguyên nhân, cách fix, API/pattern đã dùng.
> Dùng làm reference khi gặp lại vấn đề tương tự.

---

## v4.2.0-beta.22 — 2026-05-30

### ✅ Thêm mới
- **Phase 5 Assembly** (`sacRunAutoCut`): ghép source clips lên V1 và voice lên A1 tự động

### 🔧 Kỹ thuật / Approach
- `parseSourceTime("0:02-0:08")` → `{inSec:2, outSec:8}`. Single timestamp (vd `"0:04"`) → default 3s duration
- `sacMakeTime(seconds)` — tạo TickTime cho UXP: thử `ppro.TickTime.fromSeconds()` → fallback `new ppro.TickTime(ticks)` → fallback plain object `{seconds, ticks}`. Cần thiết vì UXP TickTime constructor không nhất quán giữa Premiere versions
- `sacGetSequenceEnd(seq)` — traverse V1 track items với `getClipItems()`, lấy `max(getEnd())` để cursor bắt đầu ngay sau content hiện có, tránh ghi đè
- `sacImportFile(path)` — gọi `project.importFiles([path])` rồi BFS toàn bộ project bin với `sacCollectBinItems()` để tìm lại ProjectItem vừa import (import API không trả về item trực tiếp)
- `sacSetItemPoints(item, inSec, outSec)` — gọi `item.setInPoint(tickTime, 0)` + `item.setOutPoint(tickTime, 0)` với quality=0 (loose) trước mỗi `overwriteClip`. Pattern: set → insert → set → insert cho cùng một source clip nhưng khác in/out
- `sacInsertClipAt(seq, item, atSec, vIdx, aIdx)` — thử `seq.overwriteClip` trước (phổ biến hơn trong UXP), fallback sang `seq.insertClip`. Track index: 0-based, -1 = bỏ qua track loại đó
- Block duration = `max(srcTotal, voiceDuration)` — nếu voice dài hơn video, cursor nhảy đến hết voice (không bỏ sót audio)

---

## v4.2.0-beta.19 — 2026-05-xx

### ✅ Thêm mới
- **Phase 4a Voice Pipeline**: file picker + transcribe/align + mini player + cross-tab VoiceGen→Autocut
- **Phase 3 Source Validation**: bin search 3-pass, sacSourceMap, folder/clip matching
- **Phase 2 Screenshot Parser**: bridge endpoint `/superautocut/parse-image` (Claude Vision)

### 🔧 Kỹ thuật / Approach
- Voice align: POST `/superautocut/voice-align` với `{audioPath, blocks:[{texts}]}` → bridge chạy Whisper + match text → trả `alignments[i].{start, end, duration, status}`
- Bin search 3-pass: (1) exact match ext-tolerant, (2) prefix + boundary char `[\s._-]`, (3) folder+clip split — xử lý case cutsheet "Senyue 70" = folder "Studio Senyue" + clip "70.MOV"
- UXP audio playback: không dùng `new Audio()` (unsupported) — dùng bridge endpoint `/tts/play` (afplay) + DOM timer để update progress bar
- Cross-tab: `window.AutocutPushVoice(path)` và `window.VoiceGenPushScript(text)` — expose qua `window` vì các module là separate IIFE, không share scope

### 🐛 Bugs fixed
- **`.hidden` attribute không hoạt động trong UXP** — Nguyên nhân: UXP Chromium không hỗ trợ HTML `hidden` attribute trên custom elements. Cách fix: thay bằng `el.style.display = 'none'/'flex'`
- **TSV paste multi-line cells** — Nguyên nhân: Google Sheets wrap cell có `\n` trong double-quotes, naive split('\n') phá vỡ. Cách fix: viết parser TSV đầy đủ theo spec (state machine: inQ flag, escaped quote `""`)
- **Block section không scroll được** — Nguyên nhân: UXP flex container cần `flex:1 1 0; min-height:0; overflow-y:auto` trên *inner child*, không phải container. Cách fix: thêm wrapper div với đúng pattern

---

## v4.1.39 — 2026-05-xx

### ✅ Thêm mới
- Phase 1 SAC: Spreadsheet UI + block parsing, TSV paste từ Google Sheets

### 🔧 Kỹ thuật
- Multi-row paste: intercept `paste` event trên bất kỳ input nào trong bảng, detect `\n` trong clipboard → parse toàn bộ, clear bảng, re-render
- Expand rows: multi-line text cell → split thành nhiều rows (first row giữ time+src); multi-timestamp cell (`"0:04 0:07 0:13"`) → split thành rows riêng, mang theo src name

---

## v4.1.38 — 2026-05-xx

### ✅ Thêm mới
- Manual "Check for updates" button trong Settings
- Plugin auto-update via Creative Cloud (CCX format)
- Bridge app kiểm tra cả Bridge + Plugin updates đồng thời

### 🔧 Kỹ thuật
- Update check: fetch Gist JSON `{version, downloadUrl, bridgeVersion, bridgeDownloadUrl}`, so sánh với version đang chạy
- CCX install: download → spawn `open file.ccx` → macOS tự mở Creative Cloud installer
- `update-gist.sh`: dùng `jq` để build JSON payload tránh double-encoding khi push lên GitHub Gist

---

## v4.1.36 — 2026-05-xx

### ✅ Thêm mới
- Voice Clone: lấy audio từ A1 track trong sequence → extract qua ffmpeg → clone voice qua ElevenLabs

### 🔧 Kỹ thuật
- Đọc A1 track: thử Path A `seq.trackGroup(MEDIATYPE_AUDIO).getTrack(0)` trước, fallback Path B `seq.getAudioTrack(0)` (Premiere version compatibility)
- Extract audio segments: `getInPoint()`/`getOutPoint()` → ffmpeg `-ss {in} -to {out} -c copy` cho từng clip → concat với filter_complex
- `vcGetTrackItemFilePath`: thử `getProjectItem()` → `ClipProjectItem.cast()` → `getMediaFilePath()`, 3 fallback paths vì UXP API không nhất quán

---

## v4.1.x — earlier

### 🔧 UXP Constraints đã học được
- `position:fixed` → không hoạt động, dùng flex layout
- `display:grid` → không hoạt động, dùng flex
- `window.innerWidth` → không hoạt động
- `title=""` attribute → không render tooltip
- `new Audio()` → không hoạt động, dùng bridge `/tts/play`
- `keypress` event → không fire, dùng `keydown`
- `textarea rows/cols` → bị ignore, dùng CSS height
- Scrolling: `overflow-y:auto` phải đặt trên inner child với `flex:1 1 0; min-height:0`, không phải flex container
- Tất cả Premiere API async: `getStart()`, `getEnd()`, clip name, track count đều phải `await`
- Keyboard focus: `window.claimKeyboard()` / `window.releaseKeyboard()` trên focus/blur của mọi input
- ES Modules: không dùng — `main.js` là non-module script

---
