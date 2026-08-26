# Handoff — Trang Auto (dựng bộ 3 video ads)

**Nhánh:** `feat/autocut-auto-page` (44+ commit, chưa merge vào `main`)
**Ngày:** 2026-08-26 · **Plugin** v5.6.0 · **Bridge** 1.15.0
**Trạng thái:** người dùng xác nhận **đã chạy được** trong Premiere.

---

## 1. Tính năng làm gì

Một trang "Auto" trong tab Autocut, khai báo cả **bộ 3 video ads** một lần rồi
chạy tự động: validate → gen voice → (dừng nghe thử) → dựng 3 timeline.

Người dùng làm video quảng cáo theo sản phẩm. Mỗi order = một bộ 3 video
`.0/.1/.2`. Trước đây phải lặp tay 3 lần, mỗi lần tự chọn thư mục lưu voice và tự
đặt tên sequence.

**Tên là deliverable giao cho CO** — sai một ký tự là giao file sai tên:
- Sequence: `SonaShape vid33.0 [c.ha.ttdo] [hoang.vietnguyen]` (ngoặc vuông và
  tiền tố `c.` là ký tự **thật**)
- Voice: `Voice Over/33x/33.0 - Advertising Voice 2.mp3`
- Bin sequence: `Sequence / FB / 33x`

---

## 2. Luồng sử dụng

**Khai một lần cho mỗi project** (nút ⚙ trên trang Auto): Sản phẩm · CO · Editor ·
mẫu bin. Lưu localStorage theo project.

**Mỗi bộ:** điền `Bộ` → chọn tab video `.0/.1/.2` → mỗi video đặt **Voice + Ratio
riêng** → dán script vào bảng → bấm **Chạy cả bộ**.

| Chặng | Việc | Ghi chú |
|---|---|---|
| 1 | Validate cả 3 video | Có video lỗi → **DỪNG HẲN**, tự nhảy về tab video đó với đúng bảng + Blocks để sửa source thiếu |
| 2 | Gen voice tuần tự → `/tts/move` vào `Voice Over/{bộ}x` → import vào bin | Tuần tự để tránh rate limit ElevenLabs |
| ⏸ | Dừng cho nghe thử — bấm "Chạy cả bộ" **lần nữa** để tiếp | Tick "Bỏ qua nghe thử" thì chạy một mạch |
| 3 | Align voice → `sacRunAutoCut('new')` → chuyển sequence vào bin | |

Thông báo macOS ở các mốc (`POST /notify`) để người dùng rời máy được.

---

## 3. Kiến trúc — và LÝ DO (đọc phần này trước khi sửa)

### 3.1 Nguyên tắc quan trọng nhất: DÙNG LẠI, ĐỪNG NHÂN BẢN

Đây là bài học đắt nhất của cả session. **Mọi lỗi nặng đều đến từ việc tôi viết
cơ chế song song với thứ đã chạy được:**

| Tôi đã làm | Hậu quả | Sửa bằng cách |
|---|---|---|
| Tự viết reader bảng (`'.sac-col-text input'`) | **Mất sạch script.** Selector đó không khớp trong UXP: DOM có 14 dòng mà đọc ra 0 → ghi rỗng vào job → dựng lại bảng theo job rỗng | Dùng `sacInputBySem(row, sem)` — cách `parseBlocks()` vẫn dùng (chỉ số cột nằm trên input qua `dataset.colIdx`, vì đổi preset cột sẽ **xáo thứ tự DOM**) |
| Tự viết `autoSyncBlocks()` | **Blocks không hiện.** Nó ẩn khối Blocks mỗi lần dựng tab, đánh nhau với Manual vốn tự quản | Xoá hẳn |
| Mượn **từng mảnh** (bảng → dropdown voice → Blocks) | Lần nào cũng thiếu một thứ (thiếu Parse AI, thiếu Validate, thiếu Blocks) | **Bê nguyên `#sacPanelManual`** |

→ Trước khi viết hàm mới, `grep` xem Autocut/VoiceGen đã có hàm làm việc đó chưa.

**Bổ sung (2026-08-26) — mượn DOM chỉ giải quyết được MARKUP, không giải quyết
STATE.** Bảng `#sacBody`, `parsedBlocks`, `sacSourceMap`, `sacValidatePassed` đều
là **một** bản dùng chung cho cả 3 video. Pipeline mượn chúng cho video nó đang
xử lý, trong khi UI vẫn nói người dùng đang ở tab khác. Từ đó ra một loạt lỗi:

| Triệu chứng | Nguyên nhân |
|---|---|
| Bấm chạy → Blocks ở tab .0 đổi thành .2 | Mỗi lần validate lại `renderBlocks()` vào cùng `#sacBlockList`, tab không đổi theo |
| Tab .0 giữ script/blocks của .2 **vĩnh viễn** | Đổi tab giữa lúc chạy → `autoCaptureRows`/`autoStashJobState` chép nội dung video pipeline đang xử lý đè lên tab đang rời, rồi `autoSaveState()` ghi xuống localStorage |
| vid.1 dựng ra không có hình | `sacJobContext` không lưu `sacSourceMap` — map toàn cục bị `sacValidateSources` reset mỗi lần validate, tới chặng 3 chỉ còn của job cuối |

Đã vá bằng: cất/khôi phục state theo job (`autoStashJobState`/`autoApplyJobState`),
tab bám theo video pipeline đang làm (`autoMarkRunningTab`), chặn đổi tab khi
`autoRunning`. **Nhưng đây vẫn là vá quanh thiết kế state toàn cục.** Hướng sạch
hơn: cho `sacValidateAll`/`renderBlocks`/`sacRunAutoCut` nhận tham số "làm việc
trên state nào" thay vì đọc/ghi biến toàn cục — chưa làm, xem §7.

### 3.2 Cách trang Auto tái dùng Manual: MƯỢN DOM

`autoBorrowManual()` **di chuyển** chính node `#sacPanelManual` vào
`#sacAutoManualSlot`, `autoReturnManual()` trả về đúng vị trí cũ.

**Cả 3 cặp borrow/return đều dùng PLACEHOLDER, không dùng `nextSibling`:**
`autoBorrowManual`/`Return`, `autoBorrowVoiceDrop`/`Return`, `autoBorrowSub`/`Return`.
Lúc mượn thì chèn một `<div>` ẩn vào đúng chỗ cũ, lúc trả thì `insertBefore` vào
placeholder đó. Lý do ở §4 mục 10.

Nhờ vậy bảng script, Parse cutsheet AI, Validate, Blocks, voice panel, cut panel
đều là **chính** phần tử của Manual — không có bản sao để lệch hành vi. Handler
gắn theo id nên đổi cha không ảnh hưởng.

Tương tự: `autoBorrowVoiceDrop()` mượn `#vgVoiceDrop` (dropdown voice có tìm
kiếm) từ tab Voice Gen, và `autoBorrowSub()` mượn `.st-app` (cả tab TẠO SUB) vào
`#sacAutoSubSlot` cho trang Auto Sub.

**Nút Validate bị ẩn** khi ở Auto ("Chạy cả bộ" đã validate cả 3), trả lại khi thoát.

### 3.3 Ranh giới IIFE — sai là ReferenceError lúc chạy

`plugin/main.js` (~12k dòng) chia nhiều IIFE tách biệt, giao tiếp **chỉ qua `window.*`**.

| Thứ | Ở đâu | Từ trang Auto |
|---|---|---|
| `$`, `parsedBlocks`, `parseTSV`, `expandRows`, `createRow`, `sacInputBySem`, `sacAlignVoice`, `sacRunAutoCut`, `sacValidateAll`, `sacValidatePassed`, `renderBlocks`, `sacVP` | IIFE Autocut (mở 2803, đóng `END Super Auto Cut module`) | ✅ trực tiếp |
| `getActiveProject`, `ppGetOrCreateBin`, `ppMoveToBin`, `sacCollectBinItems`, `BRIDGE_URL` | top-level | ✅ trực tiếp |
| `VG_VOICES_DATA`, `lastVariations`, `vgSetVoice`, `vgCurrentVoiceId` | IIFE VoiceGen | ❌ **phải qua `window.*`** |

Accessor đã có: `window.VoiceGenGetVoices`, `VoiceGenGetLastVariations`,
`VoiceGenSetVoice`, `VoiceGenGetVoiceId`, `VoiceGenPushScript`.

### 3.4 Vì sao logic tên đặt ở bridge

`bridge/autoset-names.js` là module **thuần**, test được bằng `node` + `assert`.
`plugin/main.js` không có hạ tầng test (phụ thuộc DOM + Premiere API), nên phần
dễ sai và hậu quả nặng nhất (tên deliverable) được đẩy sang nơi test được.

Việc thư mục cũng ở bridge (`POST /autoset/voicedir`): UXP bị sandbox
(`tryLoadByPath` ở `main.js:2202` viết kiểu best-effort, try/catch trả `false`),
project lại nằm trên Google Drive nên không chắc phân biệt hoa/thường. Node `fs`
không có vấn đề đó và test được.

---

## 4. Bẫy UXP đã phải trả giá để biết

1. **`hidden` không có tác dụng nếu thiếu rule CSS riêng.** Mọi chỗ dùng `hidden`
   phải kèm `.class[hidden] { display: none; }` (xem `.sac-newseq-modal[hidden]`,
   `styles.css:1115`). Thiếu → phần tử hiện vĩnh viễn.
2. **Native input/select vẽ ĐÈ lên overlay** bất chấp thứ tự lớp. Modal Settings
   phải **ẩn hẳn** nội dung phía sau (`display:none` cho `.sac-autoScroll` +
   `#sacAutoRun`), lớp nền mờ không cứu được.
3. **Selector lồng kiểu `.cell input` không khớp.** Đọc input theo class trực
   tiếp + `dataset` (xem `sacInputBySem`).
4. **`<select>` native có metric riêng** → lệch hàng so với div. Phải ép
   `height` + `margin: 0` để thẳng hàng.
5. **`.sac-panel` có `overflow: hidden`** → mọi thứ làm con trực tiếp sẽ bị CẮT
   khi panel bị kéo thấp, và nút Run bị đẩy ra ngoài khung. Phải có vùng cuộn
   trong: `flex:1 1 0; min-height:0; overflow-y:auto` (`.sac-autoScroll`).
6. **`white-space` mặc định gộp `\n`** → preview 4 dòng dồn thành 1 đoạn. Cần
   `white-space: pre-line`.
7. Cấm: `position:fixed`, `z-index`, `display:grid`. `position:absolute` thì được.
10. **`insertBefore(node, ref)` với `ref` là text/comment node NÉM LỖI.** Nhớ
    `nextSibling` lúc mượn rồi trả về bằng nó là bẫy: trong UXP `nextSibling`
    thường là text node giữa 2 thẻ. Lỗi ném ra làm đứt hàm gọi giữa chừng, panel
    kẹt trong slot đang `display:none` → **trống trơn**. Dùng placeholder.
11. **`white-space: pre-line` GỘP khoảng trắng đầu dòng** (chỉ giữ `\n`). Cần
    thụt lề thì phải `pre-wrap`.
12. **`JSON.stringify` với giá trị là ProjectItem sẽ ném lỗi.** `autoSaveState()`
    bọc `try/catch` rỗng nên state sẽ **âm thầm ngừng được lưu**. Mọi khoá tiền
    tố `_` (`_blocks`, `_srcMap`) bị lược khi serialize vì lý do này.
8. Input phải `window.claimKeyboard()` / `releaseKeyboard()` on focus/blur, nếu
   không Premiere ăn phím đơn (b, v, c…).
9. **Đường dẫn project:** `project.path` là **string đồng bộ** (xác minh trên
   Premiere 25.6.5). Không có getter nào. Thư mục `Voice Over` nằm **cùng cấp**
   file `.prproj`.

---

## 5. Dựng bản HTML/CSS trong browser để soi bố cục

Vì không thấy được UXP render, cách hiệu quả nhất là trích markup thật +
`styles.css` thật ra một trang rồi mở trong browser. **Cách này đã bắt được 3 lỗi
mà đọc code không thấy** (nút Run bị đẩy ra ngoài khung ở panel thấp, bảng co còn
2px, preview dồn dòng).

Harness: `scratchpad/preview/` (`preview.html` + bản copy `styles.css`), phục vụ
bằng `.claude/launch.json` → `python3 -m http.server 8777`. Nhớ dựng nhiều khung
(380px, 300px hẹp, panel thấp 420px) và mô phỏng cả `autoBorrowManual()`.

`.claude/launch.json` trỏ vào đường dẫn scratchpad của session cũ — sửa lại khi dùng.

---

## 6. Đã kiểm chứng gì / chưa kiểm gì

**Có test tự động** (`node bridge/test/<tên>.test.js`, không có jest/vitest):
- `autoset-names.test.js` — tên sequence/bin/voice, ca biên: dấu chấm cuối tên
  voice, số bộ có 0 đứng đầu (`031`→`31`), số rất dài (không rơi ký hiệu khoa
  học), mảng 3 tên voice khác nhau
- `notify.test.js` — escape AppleScript, **cắt chuỗi trước khi escape** (cắt sau
  làm vỡ script → osascript syntax error → không hiện thông báo nào)
- `voice-change.test.js` — có sẵn từ trước

**Kiểm bằng cách chạy thật:** endpoint bridge (curl), logic state trang Auto
(harness node + DOM giả), bố cục (browser preview).

**CHƯA kiểm:** chưa chạy end-to-end một bộ 3 video hoàn chỉnh trong Premiere
(gen voice thật → lưu file → import bin → dựng 3 timeline → chuyển bin). Người
dùng báo "đã chạy được" nhưng chưa rõ đã đi hết chặng 2–3 chưa.

---

## 7. Việc còn treo

0. ~~Xác minh `projectItem.getSequence()`~~ — **đã xác minh: KHÔNG tồn tại** trên
   Premiere 25.6.x. Không có đường tra ngược từ TÊN ra object Sequence. Luồng cut
   không vướng vì nó tự `project.createSequence()` nên luôn cầm sẵn object; trang
   Auto Sub chỉ có tên nên phải **giữ object lại từ lúc dựng** (`job._seq`, gán ở
   `autoStage3` ngay sau `sacRunAutoCut`). `autoResolveSeq()` thử 3 đường: object
   đã giữ → `project.getSequences()` → `projectItem.getSequence()`.
1. **Tách state trang Auto khỏi biến toàn cục của Manual** — xem §3.1. Đây là
   nguồn của phần lớn lỗi khó trong tính năng này; các fix hiện tại là vá quanh.
2. **Xoá thư mục rỗng `Voice Over/32x`** trên Google Drive (tôi tạo khi kiểm
   chứng `/autoset/voicedir`).
3. **Quyết định về tính năng ảnh (tab "Ảnh" cũ):** đã bỏ nút khỏi UI nhưng
   **code còn nguyên** — 5 chỗ trong JS còn gọi `$('sacPanelScreenshot').style`,
   xoá thẻ đi là ném lỗi. Muốn xoá hẳn thì phải dọn cả 5 chỗ đó.
4. **`normalize-script` bị hoãn** ở chặng 2 (endpoint cần `{provider, model,
   apiKey}` mà trang Auto không thu thập). Voice vẫn gen được, chỉ là chưa tách
   câu + gắn `[emotion]` cho ElevenLabs. Muốn bật thì phải bổ sung cấu hình AI.
5. **Voice panel của Manual ("Gen voice", "Without voice") hiện trong Auto** —
   giữ nguyên vì đã bê cả panel. Nếu dễ bấm nhầm thì ẩn như đã làm với Validate.
6. **Trang Auto Sub chưa chạy thật lần nào** — markup, tab, đổ script đã viết
   xong nhưng chưa kiểm trong Premiere.
7. **Log chẩn đoán `AUTO_DBG`** — tắt mặc định. Bật:
   `localStorage.setItem('sac_auto_dbg','1')` rồi reload. In ra mỗi lần
   `renderBlocks` (kèm stack), mỗi lần CẤT/NẠP state theo job, và mốc chuyển tab.
   Đây là cách đã tìm ra cả "mất sạch script" lẫn "tab .0 giữ blocks của .2" —
   giữ lại, đừng xoá.

---

## 8. Tham chiếu nhanh

**Tài liệu:**
- Spec: `docs/superpowers/specs/2026-08-25-autocut-auto-page-design.md`
- Plan: `docs/superpowers/plans/2026-08-25-autocut-auto-page.md` (có bản đồ scope
  IIFE + chữ ký hàm đã xác minh)

**Endpoint bridge mới:** `POST /notify` · `POST /autoset/names` ·
`POST /autoset/voicedir` (đã ghi vào `CLAUDE.md`)

**Cổng version:** plugin `REQUIRED_BRIDGE = '1.15.0'` khớp
`BRIDGE_VERSION = '1.15.0'`. Trang Auto cần 3 endpoint trên — bridge cũ hơn sẽ
404, nên cổng này phải khớp.

**Deploy:** `./reload.sh` (đồng bộ vào `com.claudeai.premiere-assistant_5.5.0` —
tên thư mục là plugin id, **không phải** version, đừng đổi). Bridge chạy từ
`Claude Bridge.app`; sửa `bridge/*.js` thì phải copy vào
`Claude Bridge.app/Contents/Resources/server/` rồi khởi động lại app.
Lưu ý: `pkill -f "Claude Bridge.app"` **không** luôn giết được node bên dưới —
kill cả `node server.js` và kiểm `lsof -i :3030` trước khi mở lại.

**Log chẩn đoán:** đã gỡ. Nếu cần dò lại luồng rows thì gắn lại `POST /sac/log`
(tag tuỳ ý), đọc ở `Claude Bridge.app/Contents/Resources/server/sac-debug.log`.
Đây là cách tìm ra gốc rễ mất script (`domRows=14` mà `read=0`).

**Khối code:** trang Auto nằm giữa `// ── AUTO PAGE ──` và `// ── /AUTO PAGE ──`
trong IIFE Autocut của `plugin/main.js`. Đừng rải `if (autoMode)` vào hàm cũ.
