# Spec: Nút "Thêm CSV" cho Autocut

> Ngày: 2026-09-24 · Branch: `feat/autocut-csv-import`
> Chỉ sửa **plugin** (index.html + main.js + styles.css). **Không đụng bridge.**
> **Giữ nguyên** logic paste từ Google Sheet — không thay đổi gì.

## Mục tiêu

Cho phép nạp script vào Autocut từ file **CSV** có cấu trúc như
`nav-script-98-v31-0-v85-20260924-1137.csv`, ngoài cách paste từ Google Sheet hiện có.

## Cấu trúc CSV nguồn

Header (dòng 1): `scene, content, text_overlay, effects, voice_over, visual, notes, shot_name, footage_name, shot_start, shot_end, footage_s3_uri`

- Cell có thể chứa **xuống dòng** và **dấu phẩy** khi được bọc trong ngoặc kép (`"`), theo chuẩn CSV; `""` là dấu `"` literal.
- Chỉ dùng 4 cột: `text_overlay`, `footage_name`, `shot_start`, `shot_end`. Các cột còn lại bỏ qua.

## Map cột (CSV → bảng Autocut)

Bảng Autocut lưu mỗi dòng dạng `{text, time, src}` (script / in→out / source).

| CSV | → Autocut | Ghi chú |
|-----|-----------|---------|
| `text_overlay` | `text` | Nhiều dòng → `expandRows` tự gộp thành 1 dòng (như paste hiện tại) |
| `shot_start` + `shot_end` | `time` | Ghép `shot_start + "-" + shot_end`, vd `0:00-0:04` |
| `footage_name` | `src` | Giữ **nguyên** cả đuôi + id, vd `K18-1 [mudsnhw5].mp4` |

**Quy tắc ghép time:**
- Có cả `shot_start` và `shot_end` → `"{shot_start}-{shot_end}"`.
- Chỉ có `shot_start` → `"{shot_start}"`.
- Không có `shot_start` → `""` (time rỗng).
- Giá trị lấy nguyên văn (đã là dạng `m:ss`), chỉ `.trim()`, không tự định dạng lại.

**Map theo TÊN header** (không phân biệt hoa/thường), không theo vị trí cột → bền khi CSV đổi thứ tự cột.

## Luồng

1. Người dùng bấm nút **"＋ CSV"** trong header `#sacScriptToggle` (panel Manual, Autocut).
2. `sacImportCsv()`:
   a. Mở `require('uxp').storage.localFileSystem.getFile()` (lọc `.csv`). Người dùng huỷ → dừng im lặng.
   b. Đọc nội dung file: `entry.read()` (UTF-8).
   c. `csvParse(text)` → mảng các dòng (mỗi dòng là mảng ô).
   d. Dòng đầu = header. Xác định index của `text_overlay`, `footage_name`, `shot_start`, `shot_end` (so khớp tên đã `.trim().toLowerCase()`).
   e. **Thiếu 1 trong 3 cột bắt buộc** (`text_overlay`, `footage_name`, `shot_start`) → gọi `sacStatusMsg` báo lỗi rõ ("CSV thiếu cột: …"), KHÔNG nạp. (`shot_end` không bắt buộc.)
   f. Với mỗi data row: build `{ text: text_overlay, time: combineTime(shot_start, shot_end), src: footage_name }`, đều `.trim()`.
      - Bỏ qua dòng mà **cả** `text` lẫn `src` đều rỗng (dòng trắng cuối file).
   g. Gọi `window.AutocutPushRows(rows)` — hàm sẵn có: chuyển sang tab Autocut + panel Manual, `$('sacBody').innerHTML=''`, chạy `expandRows`, dựng lại bảng.

**Xác nhận ghi đè (arm 2 bước trên nút, TRƯỚC khi mở file picker):** theo đúng pattern
`elvDeleteBtn`/`elvOnDeleteClick` sẵn có trong plugin (UXP không dùng `window.confirm`).
- Bảng đang **trống** (chỉ có dòng rỗng) → bấm 1 lần chạy luôn bước 2.
- Bảng đang **có dữ liệu thật** (≥1 dòng có text/time/src) → **bấm lần 1**: nút chuyển sang trạng thái "armed", đổi nhãn `Ghi đè? bấm lại`, hẹn 4s tự huỷ arm. **Bấm lần 2** (trong 4s): mới mở file picker và nạp. Kiểm tra "có dữ liệu thật" bằng cách duyệt `.sac-row` trong `#sacBody`, có ô nào khác rỗng.

## Đơn vị code (main.js)

- **`csvParse(text)` → `string[][]`**
  Parser thuần giống `parseTSV` nhưng **phân tách bằng dấu phẩy** thay tab.
  Xử lý: quoted field (`"`), `""` → `"`, xuống dòng trong ô khi đang trong ngoặc, `\r\n`/`\r`/`\n` là hết dòng khi ngoài ngoặc, bỏ dòng toàn ô rỗng. Không phụ thuộc DOM → test được độc lập.
- **`sacImportCsv()`** — orchestrate: (arm 2 bước nếu bảng có dữ liệu) → pick → read → parse → map → push. Trạng thái arm giữ bằng biến module (vd `sacCsvArmed` + `sacCsvArmTimer`), disarm sau 4s hoặc sau khi nạp xong.
- **`combineTime(a, b)`** — hàm nhỏ ghép time theo quy tắc trên (có thể inline trong sacImportCsv).
- Wiring: gắn `click` cho nút CSV, có `e.stopPropagation()` (vì nút nằm trong `#sacScriptToggle` là vùng toggle collapse — click nút không được làm gập section, giống `sacColPreset`/`sacScriptClear`).

## UI (index.html + styles.css)

- Thêm trong `#sacScriptToggle` (index.html ~dòng 998), cạnh `#sacScriptClear`:
  ```html
  <div id="sacCsvImport" class="sac-csvBtn" role="button" title="Nạp script từ file CSV"><span data-ic="file" data-ic-size="12"></span> CSV</div>
  ```
- CSS `.sac-csvBtn`: dùng lại phong cách nút nhỏ trong header (tham chiếu `.sac-scriptClearBtn`). Không dùng `position:fixed`/`z-index`/`grid` (ràng buộc UXP).

## Không làm (YAGNI)

- Không đổi logic paste Google Sheet.
- Không map các cột `content/effects/voice_over/visual/notes/shot_name/footage_s3_uri`.
- Không tự chuyển đổi/đoán định dạng time ngoài việc ghép chuỗi.
- Không hỗ trợ append (đã chốt: replace + confirm).

## Kiểm thử

**Tự động (node, thuần):** `csvParse` tách biệt DOM → viết test nhỏ chạy bằng `node`:
- Parse cell có dấu phẩy trong ngoặc kép (scene 2: "…68% off... But they're not for me").
- Parse cell có xuống dòng trong ngoặc (scene 1, 4, 5).
- Parse `""` → `"` (scene 4: `""instant-snatch""`).
- Số dòng data = 5 với CSV mẫu; map ra đúng `{text,time,src}` kỳ vọng cho scene 1 và 5.

**Thủ công (Premiere, UXP không test headless):**
- Bấm ＋CSV → chọn file mẫu → bảng nạp đúng 5 dòng, time `0:00-0:04`…`0:00-0:47`, source giữ nguyên tên file.
- Bảng đang có dòng → hiện confirm ghi đè.
- CSV thiếu cột `footage_name` → báo lỗi, không nạp.
- Paste từ Google Sheet vẫn hoạt động y như cũ.

## Version

- Bump `PLUGIN_VERSION` (main.js) + `manifest.json` + entry `CHANGELOG.md`. Không cần bridge mới.
