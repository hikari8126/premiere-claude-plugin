# Voice Gen — History theo lần gen (thiết kế)

Ngày: 2026-09-17 · Trạng thái: đã duyệt

## Vấn đề

Gen một lần nữa là output cũ biến mất khỏi plugin. File mp3 vẫn nằm trên đĩa
(thư mục output đã chọn, hoặc thư mục tạm) — chỉ là `lastVariations` bị ghi đè
nên không còn đường vào.

Section "Gần đây" hiện có lưu theo **cặp voice+script**, gộp trùng, và không giữ
output. Đổi nó thành lưu theo **lần gen**.

## Mô hình dữ liệu

`localStorage['vg_voice_history']`, mỗi phần tử là một lần gen:

```jsonc
{
  "id": "g_l8xk2",
  "voiceId": "...", "voiceLabel": "Adam",
  "script": "…200 ký tự đầu…",
  "ts": 1758000000000, "profileId": "p1",
  "mode": "tts",              // tts | sfx | music
  "take": 2,                  // lượt thứ mấy của cùng voice+script
  "multi": false,             // true = multi-speaker
  "outputs": [{ "audioPath": "...", "previewUrl": "...",
                "sizeBytes": 128400, "filename": "abc.mp3" }]
}
```

**Bỏ gộp trùng.** Trùng cả voice lẫn script thì đếm số mục đã có rồi gán `take`,
hiển thị `Adam · lần 3`. Mục cũ (không có `outputs`) vẫn đọc được, chỉ thiếu nút
Play/Import — không cần migration.

Giữ nguyên cap 20 mục **mỗi profile** và cách lọc theo voice dùng được.

## Sidebar

Mỗi mục thành 2 dòng:

- Dòng trên: tên voice + nhãn lượt + đoạn script (như hiện tại)
- Dòng dưới: ▶ nghe · **Import** · **Mở lại** · **Nạp script**

`.vg-right` nới 232px → 260px (chế độ hẹp 168 → 184px).

Nút Play gọi thẳng `vgPlayPath()`. Hàm này vốn đã huỷ lượt phát trước, nên
không cần thêm gì để tránh phát chồng — nghe ở sidebar tự dừng player ở khu
kết quả.

## Khu kết quả

Thanh điều hướng phía trên khối variation: `◀  Lần gen 3/12  ▶`. Bấm là nạp lại
`lastVariations` của lần đó, đủ Import / Timeline / Autocut. Gen mới nhảy về vị
trí 1. Ẩn khi chỉ có ≤1 lần gen của mode đang mở.

Danh sách điều hướng = history đã lọc theo `mode === currentMode` và có `outputs`.

## Quyết định

- **"Mở lại" một lần gen SFX/Music tự chuyển mode** nếu đang ở mode khác. Không
  chuyển thì khu kết quả hiện nội dung của mode khác, rất dễ nhầm.
- **Không kiểm tra file còn tồn tại lúc render.** Mỗi mục một lệnh đọc đĩa,
  nhân 20 mục mỗi lần vẽ là quá đắt cho thứ hiếm khi xảy ra. Bấm Play mà file
  mất thì báo lỗi ngay trên mục đó.
- **Multi-speaker**: vẫn lưu history, nhưng "Mở lại" chỉ khôi phục danh sách
  file phẳng — cấu trúc theo speaker không nằm trong `lastVariations`.

## Không làm

Xoá từng mục history, ghim mục, đổi tên lần gen, so sánh hai lần gen cạnh nhau.
