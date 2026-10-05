# Khối đơn cho quy trình — phân tích (2026-10-05)

User: *"các khối phải tách biệt — dựng bin thì chỉ dựng bin; các node gộp lại mới thành quy trình"*.
Hiện GG / PIN / APP là **khối gói sẵn cả quy trình** (`bin_set`, `pin_order`, `app_set`) → tách thành
khối đơn, mỗi khối một việc, có **setting thêm**; quy trình dựng sẵn viết lại thành chuỗi khối.

---

## 1. Mô hình chạy

- Phiếu chạy chọn **danh sách video** (vd 41.0, 41.1, 41.2). Quy trình chạy **từng bước cho mọi
  video** rồi mới sang bước sau (dễ xem trước, dễ dừng).
- **Biến** dùng trong tên / đường dẫn, lấy cho từng video:
  `{bộ}` 41 · `{số}` 0 · `{SP}` AeriSoft · `{CO}` c.uyen.thupham · `{ED}` hoang.vietnguyen ·
  `{ratio}` 4x5 · `{nền tảng}` GG. `{CO}` / `{ED}` lấy từ tên FB gốc (`[..] [..]`) hoặc cài đặt trang Auto.
- **Kết quả** mỗi bước = sequence / bin vừa tạo **cho từng video** → bước sau chọn nguồn
  "kết quả bước N".
- **Xem trước toàn bộ trước khi chạy** (mới): phiếu chạy hiện bảng tên / bin sẽ tạo cho từng video ở
  từng bước, đánh dấu *đã có / thiếu nguồn*. Tính thuần trên bản chụp project + "kết quả ảo" của các
  bước trước — không đụng Premiere.

## 2. Ba kiểu "nguồn", "tên", "bin" dùng chung

### Nguồn (sequence đầu vào) — cho Nhân bản, Resize, Chuyển bin, Xuất RAW
| Lựa chọn | Nghĩa |
|---|---|
| **Bản gốc theo nền tảng** | sequence `vid{bộ}.{số}` của nền tảng tham chiếu (mặc định FB = không có nhãn GG/PIN/APP, không đuôi ratio) |
| **Kết quả bước N** | sequence bước N vừa tạo cho cùng video |
| **Bản cùng loại ở bộ trước** | nhận diện bằng mẫu, vd `GG Dọc`, `AppLovin` → lấy ở bộ gần nhất có (ưu tiên cùng `{số}`) — dùng cho khung / template |
| **Template** | một sequence cố định (chọn trong project) |
| **Đang chọn / đang mở** | như hiện tại |

### Tên (cả hai kiểu, user chọn)
- **Học theo bộ trước**: chọn *sequence tham chiếu* (vd "bản gốc FB", "GG Dọc") → lấy tên của nó ở
  bộ gần nhất, thay số bộ / số video. Giữ đúng cách viết (`Dọc` hoa), tag `[CO] [ED]` của bộ mới.
- **Mẫu tay**: `{SP} GG Dọc vid{bộ}.{số} [{CO}] [{ED}]`.
- Thiếu biến (vd chưa biết `{CO}`) → bước đó báo lỗi ở bảng xem trước, không chạy.

### Bin đích
- **Mẫu tay** `Sequence / GG / {bộ}x / {bộ}.{số}` · **Như bộ trước** (bin chứa sequence tham chiếu ở bộ
  trước, thay số) · **Kết quả bước Tạo bin N** · **Cùng bin nguồn**.

### Setting chung mọi khối tạo
- **Khi đã có**: bỏ qua *(mặc định)* · tạo thêm bản "(2)".
- **Xác nhận**: hỏi trước *(mặc định)* · tự chạy (hàng đợi luôn tự chạy).
- **Lỗi một video**: bỏ qua video đó, chạy tiếp *(mặc định)* · dừng cả quy trình.

## 3. Từng khối

| Khối | Chip chính | Setting thêm (⚙) |
|---|---|---|
| **Tạo bin** | đường dẫn | mẫu tay / như bộ trước (tham chiếu nền tảng) · theo bộ (`{bộ}x`) hay theo từng video (`{bộ}.{số}`) — suy từ mẫu |
| **Tạo sequence** (rỗng) | tên · khung | tên học / mẫu · khung 9:16 / 4:5 / 1:1 / 16:9 / 2:3 / *như bộ trước* · bin · số video khi bộ **chưa có** sequence nào (mặc định .0 .1 .2) |
| **Nhân bản** | nguồn · tên | bin · khi đã có · mở lên timeline sau khi tạo (tắt) |
| **Resize** | nguồn · ratio | ratio: cụ thể / *ratio còn lại* (9:16⇄4:5) / mọi ratio của nền tảng · nhãn nền tảng trong tên (GG/FB/PIN) · tên: kiểu Resize `<nguồn> 4x5 FB` / học / mẫu · bin: cùng nguồn / mẫu / kết quả bước · canh text theo guide (bật) |
| **Chuyển vào bin** | nguồn · bin | — |
| **Xuất RAW** | nguồn · chế độ | tự xuất / chỉ chuẩn bị · thư mục: tự nhận / chọn |
| Soát voice · Chờ bro · Hỏi Claude · Mở tab | như hiện tại | — |

Đổi tên: không làm khối riêng — Nhân bản / Resize / Tạo sequence đã có setting tên. (Thêm sau nếu cần.)

## 4. Quy trình dựng sẵn viết lại

**NAV (bộ mới)**
1. Tạo bin `Sequence / FB / {bộ}x` (như bộ trước)
2. Tạo sequence · tên học theo bộ trước (tham chiếu FB) · khung như bộ trước · bin = bước 1

**GG**
1. Tạo bin `Sequence / GG / {bộ}x / {bộ}.{số}`
2. Nhân bản · nguồn bản gốc FB · tên `{bộ}.{số}` · bin = bước 1
3. Resize · nguồn bước 2 · ratio còn lại · nhãn như bộ trước (FB / GG) · cùng bin
4–6. Nhân bản · nguồn "GG Dọc" / "GG Ngang" / "GG Vuông" bộ trước · tên học theo bộ trước · bin = bước 1

**PIN**: Tạo bin `Sequence / PIN / Order {ngày}` → Resize · nguồn bản gốc FB · ratio 2:3 · nhãn PIN · bin = bước 1
**APP**: Tạo bin như bộ trước (APP) → Nhân bản · nguồn "AppLovin" bộ trước · tên học · bin = bước 1
**RAW**: Xuất RAW · nguồn bản gốc FB · Both · tự xuất

Biến mới cho PIN: `{ngày}` = `Oct 05 26`.

## 5. Phiếu chạy cho bộ CHƯA có sequence (NAV)

Hiện phiếu chạy chỉ liệt kê video FB gốc đã có → bộ mới không có gì để tick. Thêm: "Bộ mới" — gõ số
bộ + số video (mặc định 3 → .0 .1 .2). Video "ảo" này đủ để Tạo bin / Tạo sequence chạy.

## 6. Kỹ thuật

- `plugin/flow-engine.js` (thuần, test): `planFlow(items, steps, targets, ctx)` → bảng
  `[{step, video, action, name, bin, source, exists, error}]`, thêm kết quả ảo vào items sau mỗi bước
  để bước sau tìm được. Gộp `binset-core.js` (học tên / bin bộ trước, ratio còn lại) vào đây.
- `plugin/flow-run.js`: chạy bảng đã duyệt bằng API có sẵn — `ppGetOrCreateBin`, `ResizeAPI.cloneInto`,
  `ResizeAPI.plan/run`, `project.createSequence` (đoạn tạo sequence rỗng của `sacRunAutoCut`),
  `ppMoveToBin`, `RawcutAPI.exportSeqs`.
- Dữ liệu quy trình cũ (`bin_set`, `pin_order`, `app_set`) đổi sang chuỗi mới một lần; khối gộp bỏ khỏi
  danh sách khối (Claude vẫn gọi được action cũ một thời gian).
- UI: chip chính như hiện tại + chip **⚙** mở bảng setting của khối (dropdown + ô mẫu, có hiện thử
  tên cho video đầu: "→ AeriSoft vid41.0 [c.uyen] [hoang]").

## 7. Còn cần user chốt
- `{CO}` / `{ED}` cho bộ mới lấy từ đâu khi bộ trước khác người làm: tag của bộ trước, hay cài đặt
  trang Auto (CO + Editor đang chọn)?
- Tạo sequence rỗng: fps / audio lấy theo project mặc định là đủ, hay phải "giống bộ trước"?
  (Premiere UXP tạo sequence rỗng theo preset mặc định; khung đổi được sau khi tạo — đã làm ở trang Auto.)
