# Slack → lên lịch xuất RAW (beat cut) — nghiên cứu (2026-10-05)

## 1. Nguồn việc: kênh #act-creative-beat-cut-requests (C0C344R68BD, private)

Bot **SamX** (app, user U0B5K9H21A6) đăng mỗi tối (~19:00) một tin cho từng member:

```
*Beat cuts to export — 3 NAVs released on 5 Oct 2026*
CC @<member>            (hoặc một nhóm <!subteam^…>)
All NAVs are listed in the table below.
  └─ reply ngay sau đó (1s): BẢNG — Product code | Released | Content Owner | R… (cột cuối bị khuất)
       AeriSoft | 3 Oct 2026, 10:35 (GMT+7) | trang.vhnguyen@crossian.com | 3,…
```

- Mỗi member một tin (CC đúng người), 3–9 NAV/tin. Có tin CC cả nhóm (`subteam`).
- Reaction ✅ trên tin cha — có vẻ là dấu "đã xử lý".
- Người ta có trả lời trong thread (vd báo CO sai tên) → bot không phải kênh một chiều.

**Hạn chế đã thấy:** Slack MCP chỉ đọc được text — **bảng (table block) ra rỗng**. Muốn đọc bảng phải dùng
Slack Web API (`conversations.replies` trả `blocks`) bằng token của một Slack app, hoặc lấy thẳng dữ liệu từ
SamX (bot này của hệ thống SamX — cùng nhà với SAMX_WORKSPACE).

## 2. Plugin đã có gì để làm RAW tự động

- Hàng đợi nhiều project (`cl-queue.js` + `cl-dash.js runQueue`): mỗi việc = {project path, quy trình, bộ, video};
  chạy thì `Project.open(path)` rồi chạy quy trình, xong về project ban đầu.
- Quy trình RAW (`raw_export`, tự xuất) → tab RAW → `SAMX/<SP>/Output/ACT/v<N>/raw|edited`.
- Danh sách project đã biết (`cl_projects_v1`, theo đường dẫn) → map **Product code → .prproj**.
- Claude tự sửa khối theo project (cl-fix.js) — hàng đợi cũng qua bước này.

Còn thiếu: (a) nhận tin, (b) đọc bảng, (c) map NAV → sequence, (d) chạy theo giờ, (e) báo lại Slack.

## 3. Luồng đề xuất

```
SamX đăng tin (19:00) ──► Bridge (Slack app, Socket Mode) nhận event message trong kênh
   │  lọc: CC đúng member của máy này (Slack user id lưu trong Settings) hoặc nhóm member thuộc
   ▼
Đọc bảng (blocks) → [{product, released, owner, nav…}]
   ▼
Map: product → project (.prproj đã biết; trùng tên sản phẩm SAMX / thư mục), NAV → bộ/video (cột R… ?)
   ▼
Thẻ "Việc từ Slack" trên bảng điều khiển tab Claude: N NAV · AeriSoft · bộ 40 (3 video) · RAW Both
   [Chạy ngay] [Xếp lịch tối nay 22:00] [Bỏ qua]      ← mặc định member duyệt; có thể bật "tự xếp lịch"
   ▼
Hàng đợi (đã có) + giờ chạy (mới: job.runAt) → bridge nhắc plugin tới giờ; Premiere phải đang mở
   ▼
Xong → reply trong thread "✓ Đã xuất RAW 3 NAV · Output/ACT/v40.x" + reaction ✅ (lỗi thì reply lỗi, không ✅)
```

### Nhận tin — chọn cách
| Cách | Trễ | Cần | Ghi chú |
|---|---|---|---|
| **Socket Mode trong bridge** (đề xuất) | <1s | Slack app + admin duyệt, token `xapp` + `xoxb` | đọc được bảng (blocks), reply/react bằng bot; không mở port |
| Bridge poll `conversations.history` | 1–5 phút | như trên (chỉ `xoxb`) | đơn giản hơn, vẫn cần app |
| Scheduled task Claude Code + Slack MCP | ≥1 phút | không cần admin | **không đọc được bảng** → không dùng được |
| Lấy thẳng từ SamX (API/webhook) | tuỳ | hỏi team SamX | sạch nhất nếu SamX có API NAV released |

Token cài một lần qua `install.sh` / Settings; mỗi member lưu Slack user id của mình để lọc tin CC.

### An toàn
- Không tự chạy khi chưa bật; RAW chỉ đọc timeline + ghi file vào Output/ACT (không sửa project).
- Timeline đã sửa sau khi NAV released → RAW vẫn xuất bản hiện tại (ghi rõ trong reply).
- Máy tắt / Premiere đóng tới giờ chạy → giữ trong hàng đợi, chạy khi mở lại, báo trễ.

## 4. Câu hỏi cần user trả lời
1. Cột cuối bảng (bị khuất "R…") là gì — có mã NAV / số bộ-video không? Nếu không, NAV ↔ sequence map bằng gì?
2. ✅ trên tin là ai thả, nghĩa "đã xuất xong"?
3. Hạn xuất RAW sau khi nhận tin? Chạy ban đêm có ổn (Premiere để mở)?
4. Có thể xin admin tạo Slack app (Socket Mode) cho workspace Crossian không, hay hỏi team SamX có API?
