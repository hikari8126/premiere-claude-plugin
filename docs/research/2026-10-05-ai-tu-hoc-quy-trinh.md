# AI tự học để dựng quy trình — nghiên cứu (2026-10-05)

Mục tiêu: plugin quan sát việc bro làm ở **mọi tab**, nhận ra chuỗi việc lặp lại theo từng bộ, rồi
**Claude tự viết quy trình** bằng đúng các khối của trình ráp chip. Bro duyệt mới lưu, không có gì tự chạy.

## 1. Hiện trạng: khối (node) đã đủ chưa?

**Chưa đủ.** Trình ráp hiện có 7 khối:

| Khối | Chạy thật được? |
|---|---|
| Dựng bin (GG) | ✓ tạo bin + sequence |
| Resize | ✓ |
| RAW | ◐ chỉ *chuẩn bị* tab RAW, chưa bấm Xuất |
| Soát bin voice | ✓ |
| Mở tab · Hỏi Claude · Chờ bro | ✓ (khối phụ trợ) |

So với một ngày làm một bộ NAV, thiếu các khối **làm việc chính**:

| Bước thật của bro | Có khối? | Hàm đã có trong code (tách ra được) |
|---|---|---|
| Gen voice + lưu + import vào bin | ✗ | `generate()`, `importVariation()` (main.js, Voice Gen) |
| Dựng timeline (Autocut / trang Auto cả bộ) | ✗ | `sacRunAutoCut()`, `autoStage1/2/3` |
| Tạo Sub (.srt) | ✗ | `stOrganize` → `stFinalize` |
| Xuất RAW thật | ◐ | `onGo` / `onGoBulk` (rawcut.js) — đang cố ý không tự bấm |
| Un-nest · Watch import · Đổi tên source | ✗ | `run()` un-nest, `wfImportPicked`, rename `run` |

→ Muốn AI dựng được "quy trình chuẩn cả bộ" thì phải tách **ít nhất 4 khối**: Gen voice, Dựng timeline,
Tạo Sub, Xuất RAW. Mỗi khối = gọi hàm có sẵn của tab qua một API (`window.XxxAPI.run(opts)`) + khối
"Chờ bro" chen vào chỗ cần mắt người (nghe voice, xem timeline).

## 2. Tự học hiện tại (mức 1) — giới hạn

`CLC.recordCmd / recordAction / suggest`: chỉ ghi việc làm **qua tab Claude**, chỉ học **cặp 2 việc liền
nhau ≤45 phút**, đếm 3 lần. Không thấy việc bro bấm trực tiếp trong tab Resize / RAW / Voice Gen… —
mà đó mới là phần lớn công việc.

## 3. Đề xuất: 3 tầng

### Tầng 1 — Nhật ký việc làm (mọi tab, tại máy)
Mỗi tab, khi một việc **xong** (thành công), ghi một sự kiện:
```
{ at, tab, act: 'resize'|'rawcut'|'voice_gen'|'autocut'|'subtext'|'bin_set'|…,
  set: '40', idx: [0,1], params: {platform:'GG', ratios:['4-5'], mode:'both', voice:'Audrey'…}, ok: true }
```
- `set` / `idx` lấy từ tên sequence (`vid40.1` → bộ 40, video 1) — đã có `CLC.vars`.
- Lưu localStorage, giữ ~500 sự kiện / 60 ngày. Chỉ ghi tham số, **không** ghi script, đường dẫn riêng tư.
- Gắn vào đúng chỗ đã báo "xong" ở mỗi tab (RAW đã có `/notify`, Resize có `onRow`, Voice Gen có lưu history…).

### Tầng 2 — Tìm pattern (thuần, không cần AI, có test)
- Gom sự kiện theo **bộ** → mỗi bộ thành một chuỗi: `bộ 38: voice_gen → autocut → subtext → bin_set GG → rawcut`.
- Tìm **chuỗi con có thứ tự** xuất hiện ở ≥3 bộ gần nhất (thuật toán kiểu PrefixSpan rút gọn, chuỗi ngắn nên rẻ).
- Tham số: giữ cái **lặp lại ổn định** (luôn GG, luôn `both`) làm giá trị cố định; cái hay đổi → để "chọn lúc chạy".
- Phạm vi video: luôn làm đủ .0/.1/.2 → "Cả bộ"; hay chỉ .0 → "vid .0".
- Kết quả: ứng viên quy trình + độ tin (bao nhiêu bộ khớp / tổng số bộ).

### Tầng 3 — Claude viết + giải thích (có duyệt)
- Gửi Claude **bản tóm tắt** (ứng viên + chuỗi từng bộ, không gửi dữ liệu thô), kèm schema các khối.
- Claude trả JSON quy trình đúng schema + tên gợi ý + 1 câu lý do ("5 bộ gần nhất bro đều…"),
  chèn khối "Chờ bro" ở chỗ thường có khoảng nghỉ dài (bro đang làm tay).
- Plugin kiểm bằng `CLC.normButton` (khối sai / thiếu tham số → loại), hiện thẻ trên bảng điều khiển:
  **Lưu · Sửa khối · Chạy thử bộ đang mở · Bỏ**.
- Claude không bịa khối mới: chỉ dùng khối có trong `CLC.SPEC`; việc chưa có khối → ghi chú
  "bước này bro làm tay" (thành khối Chờ bro).

## 4. Lộ trình đề xuất

1. **Khối thiếu** (lớn nhất): Gen voice, Dựng timeline, Tạo Sub, Xuất RAW — mỗi cái một API + test thật.
2. **Nhật ký mọi tab** + màn "Hoạt động" nhỏ trên bảng điều khiển (bro thấy plugin đang học gì, xoá được).
3. **Tìm pattern** (thuần + test) → thay `suggest()` hiện tại.
4. **Claude viết quy trình** từ ứng viên + thẻ duyệt.

Làm 2–3 trước cũng được (học từ việc thật ngay), nhưng quy trình AI viết ra sẽ toàn "Chờ bro" ở chỗ
chưa có khối — giá trị thấp. Nên ưu tiên 1.

## 5. Câu hỏi cần bro chốt
- Thứ tự công việc chuẩn của một bộ NAV là gì? (để biết khối nào làm trước)
- Gen voice trong quy trình: chạy luôn (tốn credit) hay dừng hỏi như hiện tại?
- Xuất RAW trong quy trình: cho tự bấm Xuất, hay vẫn chỉ chuẩn bị rồi chờ bro?
- Nhật ký có cần gom cả team (để học "chuẩn team") không, hay chỉ từng máy?
