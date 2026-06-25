# CHANGELOG — premiere-claude-plugin

> Mỗi entry ghi rõ: lỗi gì, nguyên nhân, cách fix, API/pattern đã dùng.
> Dùng làm reference khi gặp lại vấn đề tương tự.

## v4.8.5 — 2026-06-25

### ✅ Thêm mới / Cải tiến
- **Autocut — hiện đường dẫn source khi match**: mỗi source khớp clip trong bin nay hiện dòng nhỏ `📁 …/folder/clip` (folder chứa nó / tên clip) để xác nhận đúng clip. Áp dụng cho cả validate thường, bind tay (modal 📁) và unbind.
- **Autocut — nút "Về block" sau khi cut xong**: đổi tên "Back to script" → "Về block"; bấm nay trả về **block view** (script editor vẫn thu gọn) thay vì bung lại bảng script.
- **Voice Gen — redesign Create Voice**: bỏ dropdown Method, thay bằng **2 thẻ** Clone Voice / Design Voice (có mô tả). Luồng Clone chia **3 bước progressive**: ① chọn nguồn + Extract/Browse → ② có audio mới hiện nút "Clone this voice" → ③ bấm mới hiện Voice Name + Description + Create.

### 🔧 Kỹ thuật / Approach
- Matched path lookup: dò `sacBinItems` (flat scan có `.parent`/`.name`/`.item`) tìm record có `.item === matchedItem` → label `…/parent/name`; helper `sacMatchedPathLabel()` + `sacSetMatchMsg()` dùng chung cho 3 nhánh "found ✓".
- Clone step machine: `vcRefreshCloneSteps()` reveal/collapse Step 2/3 theo `vcSelectedFilePath`; gọi sau extract/browse (finally) và reset khi đổi tab nguồn. Chỉ dùng attribute `hidden` (tránh `position:fixed`/`grid`/`new Audio()` theo ràng buộc UXP).
- Method picker chuyển từ `<select>` sang 2 `div.vc-choiceCard role=button` + `classList.toggle('is-active')`; segmented tabs = radio ẩn (`display:none`) + `input:checked + span`.

---

## v4.7.1 — 2026-06-16

### ✅ Thêm mới / Cải tiến
- **Autocut — preset thứ tự cột cutsheet**: dropdown cạnh tiêu đề "Script input" cho chọn 1 trong 6 hoán vị thứ tự cột (Script / In→Out / Source). Thứ tự lưu `localStorage` (`sac_col_order`), khôi phục khi mở lại. Paste khối nhiều cột map theo đúng thứ tự đang hiển thị.

### 🐛 Bugs đã fix
- **Đổi preset không cập nhật UI, phải hover chuột mới đổi** — Nguyên nhân: UXP defer **paint** của thay đổi CSS flex `order` (reflow ≠ repaint), chỉ vẽ lại khi vùng bị invalidate (hover/scroll). Cách fix: bỏ `style.order`, **di chuyển cell thật trong DOM** bằng `appendChild` theo `SAC_COL_ORDER` (`sacOrderCells`) — DOM mutation buộc UXP render lại ngay.

### 🔧 Kỹ thuật / Approach
- Đọc input theo **semantic** qua `dataset.colIdx` (`sacInputBySem`) bằng single-class selector `.sac-input` (descendant combinator `.sac-col-x .sac-input` flaky trong UXP) → `parseBlocks`/validate/run/paste đúng cột bất kể vị trí vật lý.
- Reorder cả header lẫn từng row qua cùng `sacOrderCells(container)`; action cell luôn `appendChild` cuối.

---

## v4.2.0-beta.22 — 2026-05-30

### ✅ Thêm mới / Cải tiến
- **SAC Phase 5 Assembly**: Thêm voice panel dưới block list — nút "⚡ Gen voice → Voice Gen", file picker, progress player (play/pause + progress bar + timestamp)
- **`autocut_load` action**: Claude có thể đẩy cutsheet đã tổ chức thẳng vào spreadsheet Autocut (tự switch tab). Nhận `rows[]` dạng SAC-native hoặc cutlist-style (`script/source/sourceIn/sourceOut`)
- **Bin traversal + fuzzy matching**: 3-pass lookup — (1) exact (tolerant extension), (2) prefix word-boundary, (3) folder+clip split ("Senyue 62" → folder "Senyue" / clip "62"). BFS walk toàn project tree qua `ppro.FolderItem.cast()`
- **Folder hint button (📁)**: Mỗi ô Source có nút gợi ý folder từ bin scan gần nhất, reset gate validate khi sửa
- **Unified Run gate**: `sacActionBtn` chỉ hiện khi CẢ HAI pass — structure validated (`sacValidatePassed`) VÀ voice aligned (`sacVoiceReady`)
- **Multi-time zip mode**: Time cell nhiều dòng nay hỗ trợ B1 (zip src theo từng time) lẫn B2 (carry cùng một src cho tất cả times)
- **Collapsible UI**: Spreadsheet section có toggle ▾/▸; Block cards có collapse/expand theo click header
- **Block voice badge**: Mỗi block card có `sac-blockVoiceBadge` (điền sau khi align voice)
- **VoiceGen ⚙ panel**: API Key Profiles + Output Format gom vào panel collapsible (nút ⚙), thay vì luôn hiển thị. Thêm nút "→ Autocut" trên từng variation
- **Screenshot panel**: Thay `<canvas>` + nút "Chọn file ảnh" bằng `<img>` + drop zone clickable toàn bộ
- **`POST /superautocut/voice-align`**: Bridge endpoint mới — Whisper transcribe 1 file audio → align từng block's text → trả `{start, end, duration, matched, status}` per block
- **`push.sh`**: Script build + push tự động lên GitHub (134 lines)
- Bridge version bump: `1.5.0-beta.1` → `1.5.0-beta.3`

### 🐛 Bugs đã fix
- **EL_PROFILES rỗng sau load settings** — Nguyên nhân: migration path cũ không khởi tạo profile nếu `elevenlabsKey` undefined. Cách fix: thêm guard sau `applySettings()` — nếu `EL_PROFILES.length === 0` thì tạo profile Default với `ELEVENLABS_KEY`
- **Multi-time B2: src bị xóa ở row > 0** — Nguyên nhân: logic cũ luôn dùng `i === 0 ? src : ''`. Cách fix: detect `zipSrc = srcLines.length === times.length`, nếu false thì carry `src` cho tất cả rows

### 🔧 Kỹ thuật / Approach
- Bin traversal dùng `ppro.FolderItem.cast(item)` — trả `null` cho clip/sequence (không phải folder), tránh infinite loop; BFS với guard `< 10000`
- `sacNorm()` collapse toàn bộ whitespace (`\s+` → `' '`) — xử lý NBSP và double-space trong tên bin
- `sacCountBinMatches()` đếm distinct matches Pass 1+2 để phát hiện tên ambiguous trước khi validate
- Voice player dùng UXP `uxp.storage` path + `HTMLMediaElement` (không dùng `new Audio()` — unsupported trong UXP)
- `autocut_load` handler trong `ppExecuteAction()` gọi `window.AutocutPushRows()` (exposed từ IIFE SAC module) — tránh coupling trực tiếp vào closure

---

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
