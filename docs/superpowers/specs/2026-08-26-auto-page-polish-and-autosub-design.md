# Spec — Gọn trang Auto + trang Auto Sub

**Ngày:** 2026-08-26 · **Nhánh:** `feat/autocut-auto-page`
**Bối cảnh trước đó:** `docs/superpowers/HANDOFF-autocut-auto-page.md`

Bốn thay đổi cho trang Auto trong tab Autocut. Ba cái đầu độc lập nhau; cái thứ
tư (Auto Sub) là phần lớn nhất.

---

## 1 · Popup confirm thay khối preview inline

### Hiện trạng
`.sac-autoPreview` hiển thị thường trực giữa trang Auto: 3 dòng tên sequence +
1 dòng voice. Nó chiếm chỗ trong lúc soạn, mà lúc cần đọc kỹ nhất — ngay trước
khi chạy — thì lại không ai nhìn.

Ngoài ra dòng voice **chỉ hiện của video đang active**, dù `autoVoiceLabels()`
(`main.js:5287`) vốn đã trả về đủ **3 label**. Đây là thiếu sót ở chỗ render,
không phải thiếu logic.

### Thay đổi
- Bỏ `.sac-autoPreview` khỏi trang Auto (markup + CSS) và mọi lời gọi
  `autoRenderPreview()` ở `autoOpen()` / khi đổi tab.
- **Giữ lại phần dựng chuỗi tên** trong `autoRenderPreview()` (`main.js:5344`) —
  đổi tên thành `autoBuildConfirmLines()`, trả về mảng dòng thay vì ghi thẳng vào
  DOM. Modal dùng hàm này. Không viết lại logic tên: nó gọi `/autoset/names` ở
  bridge, nơi duy nhất đã có test.
- Bấm **Chạy cả bộ** → mở modal confirm. Chạy thật chỉ bắt đầu khi bấm "Chạy cả bộ"
  trong modal.

Nội dung modal — **đủ cả 3 video**, mỗi video 3 dòng:

```
Bộ 33 · SonaShape · c.ha.ttdo · hoang.vietnguyen

.0  SonaShape vid33.0 [c.ha.ttdo] [hoang.vietnguyen]
    Sequence / FB / 33x
    Voice Over/33x/33.0 - Rachel · female · narrator.mp3
.1  …
.2  …

[ Huỷ ]                              [ Chạy cả bộ ]
```

### Vì sao đặt ở đây
Tên là deliverable giao cho CO — sai một ký tự là giao sai file. Điểm dừng bắt
buộc ngay trước khi chạy là chỗ duy nhất chắc chắn người dùng có đọc.

### Ràng buộc UXP (đã trả giá để biết, xem handoff §4)
- Dùng khuôn `.sac-newseq-modal` có sẵn (`styles.css:1090`), **bắt buộc** kèm
  rule `.sac-newseq-modal[hidden] { display: none; }` — thiếu là modal hiện vĩnh viễn.
- `<select>` native vẽ ĐÈ lên overlay bất kể thứ tự lớp. Khi modal mở phải
  `display:none` phần nội dung phía sau (`.sac-autoScroll` + `#sacAutoRun`),
  y như modal Settings đang làm.
- `white-space: pre-line` cho khối tên; `word-break` để tên sản phẩm dài không tràn.

---

## 2 · Dùng token màu thay hex cứng

### Hiện trạng — đây là lỗi thật, không chỉ thẩm mỹ
`piApplyAccent()` (`main.js:152`) ghi lại `--accent`, `--accent-light`,
`--accent-fg`, `--accent-dark`… **lúc chạy** khi người dùng đổi màu chủ đề.
Khối `/* ── AUTO PAGE ── */` trong `styles.css` hardcode hex:

| Hex | Chỗ dùng | Token thay thế |
|---|---|---|
| `#7c3aed` | `.sac-autoRun`, `.sac-autoTab.is-active` | `var(--accent)` |
| `#a78bfa` | viền tab active | `var(--accent-light)` |
| `#e9d5ff` | `.sac-autoTitle` | `var(--accent-lighter)` |
| `#1e1b2e` | nền tab, `.sac-autoSetInput` | `var(--surface2)` |
| `#94a3b8` | nhãn tab, `.sac-autoStatus` | `var(--text-dim)` |
| `#fff` | chữ trên nền accent | `var(--accent-fg)` |

Đổi accent sang màu khác thì cả trang Auto đứng im màu tím cũ.

### Thay đổi
Thay toàn bộ hex trên bằng token. Nút **Chạy cả bộ** và tab `.0/.1/.2` theo đúng
công thức `.sac-previewBtn` (`styles.css:3082`) — nút primary chuẩn của Autocut.

Thuần CSS. Không đụng JS.

`--accent-fg` tự đổi giữa `#fff` và `#1a1a1a` theo độ sáng accent, nên chữ trên
nút vẫn đọc được khi người dùng chọn accent màu sáng — hex cứng `#fff` thì không.

---

## 3 · Chặn trang success trong luồng Auto

### Hiện trạng — xung đột có sẵn
`sacRunAutoCut()` kết thúc bằng (`main.js:6479`):
```js
$('sacPanelManual').style.display = 'none';
$('sacSuccessPanel').style.display = 'flex';
```
Trang Auto gọi `sacRunAutoCut('new')` **3 lần** trong `autoStage3()`
(`main.js:5635`). Nghĩa là giữa lúc chạy bộ 3 video, panel Manual đang được mượn
bị ẩn và trang success chen vào — 3 lần.

### Thay đổi
- **Luồng Manual giữ nguyên** trang success (✓ + New AutoCut + Về block).
- Chặn tại **một chỗ duy nhất**: bọc 2 dòng trên bằng `if (!autoRunning)`.
  Cờ `autoRunning` đã có sẵn (`main.js:4982`).
- Xong `autoStage3()` → mở trang Auto Sub (mục 4).

Không rải `if (autoMode)` vào các hàm cũ — handoff §3 đã ghi đó là hướng sai.

---

## 4 · Trang Auto Sub

### Mục tiêu
Dựng xong 3 timeline thì đi thẳng sang làm phụ đề, không phải tự tìm tab, không
phải paste lại script — script đã nằm sẵn trong bảng từ đầu.

### Nguyên tắc: MƯỢN, ĐỪNG NHÂN BẢN
Plugin đã có tab **TẠO SUB** (`#tab-subtext`) làm đúng việc này: chọn track audio
→ script tuỳ chọn → độ dài dòng → nút "AI ngắt câu → Tạo SRT".

Trang Auto Sub **mượn node `.st-app`** vào slot trong trang Auto, đúng cơ chế
`autoBorrowManual()`. Có `autoReturnSub()` trả về đúng chỗ cũ.

### Cấu trúc
```
┌─ Auto Sub — bộ 33 ─────────────────── [← Về cut] ─┐
│  Video  [ .0 ][ .1 ][ .2 ]                        │
│  ┌─ #sacAutoSubSlot ────────────────────────────┐ │
│  │  (node .st-app mượn từ tab TẠO SUB)          │ │
│  └──────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────┘
```

### Bấm tab `.0/.1/.2` làm gì
1. `project.openSequence(seq)` + `project.setActiveSequence(seq)` — cơ chế đã
   dùng và đã chạy ở `main.js:6285`. Premiere nhảy timeline sang sequence đó.
2. Tab Sub đọc lại track audio của sequence mới (`stRenderTracks()`, `main.js:10692`).
3. Đổ script của video đó vào `#stScript` bằng `stSetScript(lines)`
   (`main.js:10919`) — hàm này đã lo cả reflow textarea.
   Nguồn: cột Script của `autoSet.jobs[i].rows`.

**Tra sequence theo TÊN, không giữ object.** Object của sequence vừa tạo có thể
stale sau khi Premiere xử lý xong. Tên là duy nhất vì tên chính là deliverable.

### Đổ script KHÔNG kích hoạt chạy
Đã xác minh: `stStartCountdown()` chỉ được gọi từ **một chỗ** (`main.js:11071`),
nằm ở cuối bước transcribe, tức là sau khi người dùng đã bấm nút. Điền
`#stScript` bằng code không kích hoạt gì. Không cần cơ chế chặn nào.

### Điểm cộng sẵn có
`stDiag` ghim dòng script đầu tiên đang dùng vào phần chẩn đoán (`main.js:11060`)
để phát hiện "đang xài nhầm script của video khác". Tab tự đổ đúng script khớp
với cơ chế này; cảnh báo "Timing có thể LỆCH" vẫn hoạt động nguyên vẹn cho từng
video.

### Nút ← Về cut
Trả `.st-app` về tab TẠO SUB, ẩn trang Auto Sub, hiện lại trang Auto.

### Rủi ro đã biết
Đổi sequence active làm Premiere nhảy timeline trước mắt người dùng. Không tránh
được nếu muốn sub từng video — đây là đánh đổi đã chấp nhận.

---

## 5 · Dọn dẹp kèm theo

`autoBorrowVoiceDrop()` / `autoReturnVoiceDrop()` bị định nghĩa **hai lần**
(`main.js:5045` và `main.js:5061`), kèm `var autoVoiceDropHome` khai báo hai lần.
Bản sau đè bản trước do hoisting, nên hiện không sai — nhưng là bẫy chờ người
sửa nhầm bản chết.

Xoá bản trùng, và chuyển bản còn lại sang **cơ chế placeholder** giống
`autoBorrowManual()` (commit `fee1cdd`): cả hai bản đang dùng
`insertBefore(node, nextSibling)`, đúng kiểu vừa làm panel Manual biến mất trong
UXP. Đây là cùng một lỗi tiềm ẩn, chưa nổ vì dropdown voice ít bị chuyển qua lại hơn.

---

## Kiểm chứng

**Không có test tự động cho `plugin/main.js`** (phụ thuộc DOM + Premiere API).
Kiểm bằng:

1. **Browser preview harness** (handoff §5) — dựng lại markup thật + `styles.css`
   thật, mở trong browser. Kiểm: modal confirm ở panel 380px / 300px hẹp / 420px
   thấp; token màu đổi theo khi đổi `--accent`; trang Auto Sub không bị cắt.
2. **Chạy thật trong Premiere** — đây là cách duy nhất kiểm được phần
   `setActiveSequence` và việc đổ script. Dùng số bộ nháp (99) để không đụng dữ
   liệu thật.

**Tiêu chí xong:**
- Bấm Chạy cả bộ → modal hiện đủ 3 tên sequence + 3 bin + 3 đường dẫn voice.
- Đổi accent trong Settings → nút và tab trang Auto đổi màu theo.
- Chạy bộ 3 video → không thấy trang success chen vào; xong thì ra trang Auto Sub.
- Trang Auto Sub: bấm `.1` → Premiere nhảy sang sequence `vid33.1`, ô script đổi
  sang script của video `.1`, chưa chạy gì cả.
- Bấm ← Về cut → về trang Auto, tab TẠO SUB vẫn dùng được bình thường.

## Ngoài phạm vi

- Song song hoá 3 job (đã phân tích: chặn bởi bảng dùng chung, rate limit
  ElevenLabs, và Premiere chỉ có 1 sequence active).
- Nút "Tạo SRT cả bộ" — làm tab thủ công trước, tính sau nếu thấy cần.
- Tab "Ảnh" cũ (handoff §7 mục 3), `normalize-script` (mục 4).
