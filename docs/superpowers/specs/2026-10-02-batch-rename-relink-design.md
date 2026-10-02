# Đổi tên source hàng loạt + relink (Premiere + After Effects)

Ngày: 2026-10-02 · Nhánh: `feat/batch-rename` · Đích: plugin v5.14.0, bridge server 1.22.0

## Mục tiêu

Một lượt cho nhiều clip: **đổi tên file thật trên đĩa → relink clip trong project
Premiere đang mở → đổi tên hiển thị trong Project panel → relink các `.aep` trong
thư mục sản phẩm đang tham chiếu file đó.** Có hoàn tác lượt gần nhất.

Ngoài phạm vi: copy file thay vì rename; relink `.prproj` khác (user thường chỉ
có 1 project); đánh số theo timeline; tìm & thay / sửa tay từng dòng; token
ngoài `{bin}` `{n}` `{name}`.

## Giao diện (tab WATCH)

Mục gập/mở **"Đổi tên source hàng loạt"** dưới nút "Thêm thư mục theo dõi".
Nút **Lấy clip đang chọn** mở modal `#rnModal` (nằm ngoài mọi `.tab-panel`, cùng
lý do với `#wfCmpModal`: UXP không có z-index):

- **Mẫu tên** — mặc định `{bin}_{n}`. Token:
  - `{bin}` — tên bin trực tiếp chứa clip
  - `{n}` — số thứ tự, tự đệm 0 theo số lớn nhất của lượt (≥2 chữ số: 01…09, 001…120)
  - `{name}` — tên file cũ bỏ đuôi
  - `{num}` — giữ số gốc nếu tên gốc (bỏ đuôi) là số hoặc `<bin>[ _-]số`; còn lại lấy số
    mới nối tiếp sau số lớn nhất được giữ của cùng bin (không có → từ "Bắt đầu từ", và
    không thấp hơn ô đó); cả bin đệm 0 theo độ dài lớn nhất (≥2, giữ độ dài số gốc như `033`)
- **Bắt đầu từ** — mặc định 1.
- **Bảng xem trước** tên cũ → tên mới, mặc định A→Z theo tên cũ (so sánh số tự
  nhiên: `IMG_2` trước `IMG_10`), nút ↑↓ mỗi dòng để đổi thứ tự. Dòng lỗi tô đỏ
  kèm lý do; dòng bị bỏ qua tô xám kèm lý do.
- **Phần "After Effects bị ảnh hưởng"** — mỗi `.aep` một dòng: tên, số footage
  khớp, checkbox (mặc định tick). AE đang chạy → cảnh báo đỏ, khoá phần này
  (bỏ tick hết, không tick lại được) cho tới khi bấm **Quét lại** sau khi tắt AE.
- Dòng cảnh báo cố định: project khác dùng chung file sẽ bị offline.
- Nút **Đổi tên N clip**. Xong → modal báo kết quả; mục trong tab hiện
  **Hoàn tác lượt vừa rồi** (kèm mô tả "N file · HH:MM").

Đuôi file luôn giữ nguyên (giữ đúng hoa/thường). Tên hiển thị Premiere = tên file
mới có đuôi (như Premiere đặt khi import).

## Lấy danh sách clip (plugin)

`ProjectUtils.getSelection(project)` (đã dùng ở RESIZE/RAW). Mỗi item:
- Bin (`FolderItem`) → lấy đệ quy mọi clip bên trong, `{bin}` = bin trực tiếp chứa clip.
- `ClipProjectItem` có `getMediaFilePath()` không rỗng → nhận.
- Bỏ qua kèm lý do: sequence, MOGRT/title/synthetic (không có đường dẫn), clip
  offline (`isOffline()`), `canChangeMediaPath()` = false.
- Nhiều project item trỏ cùng một file → gộp thành 1 dòng, file đổi tên 1 lần,
  relink + đổi tên tất cả item đó. `{bin}` lấy theo item đầu tiên.

Lưu ý API: các hàm Premiere viết phòng thủ (kiểm tra tồn tại method, `un()` cho
kết quả có thể là Promise), log rõ khi thiếu method — giống `resize.js`.

## Luồng xử lý

1. **Plan** — plugin gửi `{projectPath, rows:[{oldPath, newName}]}` lên
   `POST /rename/plan`. Bridge kiểm tra:
   - file cũ tồn tại; tên mới không rỗng, không có `/` `:` hay ký tự điều khiển,
     không bắt đầu bằng `.`, ≤255 byte
   - không trùng nhau trong lượt (so không phân biệt hoa/thường — APFS/HFS+ mặc
     định không phân biệt); không trùng file đã có trong thư mục đích (trừ khi
     file đó cũng đổi tên đi trong cùng lượt — xử lý bằng đổi tên 2 pha)
   - quét `.aep` (xem dưới), trả danh sách `.aep` + số footage khớp, cờ `aeRunning`
   Lỗi bất kỳ dòng nào → nút Đổi tên khoá, chưa đụng file nào.
2. **Apply** — `POST /rename/apply` (cùng rows + danh sách `.aep` được tick):
   bridge đổi tên **2 pha** (cũ → `.<tên>.rn-tmp-<id>` → mới) để hoán đổi tên
   giữa các file trong lượt không đè nhau. Trả `{batchId, results:[{oldPath,newPath,ok,error}]}`.
   Pha nào lỗi → bridge tự đổi các file đã đổi trong lượt về như cũ, trả lỗi.
3. **Relink Premiere** — với mỗi dòng ok: `changeMediaFilePath(newPath)` cho mọi
   item của dòng, rồi `createSetNameAction(newBaseName)` trong một transaction
   cho cả lượt. Dòng nào relink lỗi → gọi `POST /rename/revert {batchId, oldPaths}`
   để đổi riêng các file đó về.
4. **Relink AE** — `POST /rename/aep {batchId}`: bridge sửa các `.aep` đã tick theo
   ánh xạ của những dòng relink Premiere thành công. Kết quả từng `.aep` hiện trong modal.
5. **Nhật ký** — bridge lưu `~/Library/Application Support/ClaudeBridge/rename/<hash projectPath>.json`:
   lượt gần nhất `{batchId, time, rows:[{oldPath,newPath}], aep:[{path, count}]}`.
   Bản gốc `.aep` lưu `.../rename/aep-backup/<batchId>/`, dọn bản > 7 ngày.

**Hoàn tác** — `GET /rename/journal?projectPath=` lấy lượt gần nhất →
`POST /rename/undo {batchId}`: đổi tên file mới → cũ (2 pha), sửa `.aep` theo ánh
xạ ngược (không chép đè backup, giữ thay đổi làm sau đó trong AE) → plugin relink
về đường dẫn cũ + đổi tên hiển thị về tên file cũ. File mới không còn ở chỗ cũ
(bị xoá/di chuyển) → bỏ dòng đó, báo rõ. Undo xong xoá lượt khỏi nhật ký.

## Relink `.aep` (bridge, Node)

Module `bridge/aep-relink.js`, không cần Python.

- **Quét**: đệ quy thư mục sản phẩm (cấp cha thư mục chứa `.prproj`, cùng logic
  `watchfolder-browse.js`), lấy `*.aep`, bỏ thư mục tên chứa `Auto-Save`, bỏ thư
  mục ẩn, sâu tối đa 6 cấp, hạn 30s, bất đồng bộ (bài học find-sources trên
  Google Drive). Đọc mỗi `.aep`, đếm `fullpath` khớp.
- **Cấu trúc**: RIFX big-endian. Chunk = 4 byte id + 4 byte size + data (đệm
  chẵn). `LIST` = id `LIST` + size + 4 byte form + các chunk con. Đường dẫn ở
  chunk `alas` (JSON, trường `fullpath`); tên hiển thị ở chunk `Utf8` là con trực
  tiếp của `LIST` form `Item` chứa footage đó.
- **Ghi lại**: một lượt đệ quy duy nhất dựng lại cây, tính lại mọi size; thay
  `fullpath` khớp chính xác (so sau khi chuẩn hoá NFC); với `Item` có `fullpath`
  được thay, đổi `Utf8` sang tên mới chỉ khi nó đang bằng tên file cũ. Giữ
  nguyên phần dữ liệu sau chunk RIFX gốc (XMP trailer).
- **Kiểm tra trước khi ghi**: `len(mới) == len(cũ) + Σ delta` (tính cả đệm chẵn);
  parse lại file mới đếm đủ số `fullpath` mới, không còn `fullpath` cũ đã thay.
  Sai → không ghi, báo lỗi dòng `.aep` đó.
- **Ghi an toàn**: backup → ghi `<file>.rn-tmp` → `rename` đè.
- **AE đang chạy**: có tiến trình `…app/Contents/MacOS/After Effects` → `aeRunning:true`;
  `/rename/aep` từ chối khi AE đang chạy. KHÔNG tính `aerendercore -livelink` (Dynamic
  Link Premiere tự bật — chỉ đọc .aep). LIST không chứa chunk con (vd `btdk`) coi là khối kín.

Không đụng `ascendcount_*` vì đổi tên trong cùng thư mục không đổi độ sâu.

## Endpoints mới (bridge 1.22.0)

| Endpoint | Method | Mô tả |
|---|---|---|
| `/rename/plan` | POST | Kiểm tra rows, quét `.aep`, cờ `aeRunning` |
| `/rename/apply` | POST | Đổi tên 2 pha, ghi nhật ký, trả `batchId` |
| `/rename/revert` | POST | Đổi riêng một số file của lượt về tên cũ |
| `/rename/aep` | POST | Sửa `.aep` theo ánh xạ của lượt |
| `/rename/journal` | GET | Lượt gần nhất của project |
| `/rename/undo` | POST | Hoàn tác lượt gần nhất (file + `.aep`) |

## Code

- `plugin/rename-core.js` — thuần, không Premiere: render mẫu, đệm số, sắp tự
  nhiên, gộp theo đường dẫn, kiểm tra trùng phía client. Có test node.
- `plugin/rename.js` — UI + gọi Premiere (selection, relink, setName).
- `bridge/rename-ops.js` — kiểm tra tên, đổi tên 2 pha, nhật ký.
- `bridge/aep-relink.js` — parse/ghi RIFX, quét `.aep`.
- Route mới trong `bridge/server.js`; `index.html` + `styles.css` cho mục + modal.

## Kiểm thử

- `bridge/test/rename-core.test.js`, `rename-ops.test.js` (thư mục tạm: hoán đổi
  tên, trùng hoa/thường, lỗi giữa chừng tự đổi về), `aep-relink.test.js` (dựng
  `.aep` giả có folder lồng 3 cấp + XMP trailer; nếu tìm được `.aep` thật trên
  máy thì thêm fixture copy), `rename-endpoints.test.js`.
- Live: bản DEV (`dev.sh`) trên một project test tạo riêng, không dùng project thật.

## Phát hành

Beta: `PLUGIN_VERSION 'v5.14.0-beta.1'`, `BRIDGE_VERSION '1.22.0-beta.1'`,
`manifest.json` giữ `5.14.0`. Cần Bridge app mới khi ship.
