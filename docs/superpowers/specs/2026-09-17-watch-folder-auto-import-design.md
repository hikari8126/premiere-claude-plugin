# Watch Folder — Tự động import (thiết kế)

Ngày: 2026-09-17 · Trạng thái: đã duyệt, chờ lập kế hoạch triển khai

## Mục tiêu

Theo dõi nhiều thư mục trên đĩa và tự động import file mới vào đúng bin trong project
Premiere đang mở. Mỗi thư mục có bin đích và luật lọc riêng.

Ngoài phạm vi (YAGNI): tự chèn vào timeline, đặt label màu, đổi tên khi import,
watch URL/cloud, tạo proxy.

## Quyết định nền

| Câu hỏi | Chốt |
|---|---|
| Phạm vi | Nhiều thư mục, mỗi cái có bin đích + rule lọc riêng |
| Hành động | Chỉ import vào bin, không đụng timeline |
| File có sẵn lúc bật watch | Bỏ qua khi quét tự động; nút **Đối chiếu** kéo lại được khi cần |
| Khi panel đóng | Ngừng quét hoàn toàn; mở lại thì quét bù so với snapshot → không bỏ lỡ file |
| Lưu config | Theo từng project `.prproj` |
| Chọn bin | Cây bin phân cấp + nhập path để tạo mới + mirror subfolder thành bin con |
| Cơ chế phát hiện | Bridge quét định kỳ (`readdir` + `stat`), không dùng `fs.watch` |

Vì sao quét định kỳ thay vì `fs.watch`/chokidar: chạy tin cậy trên SMB/NAS (nơi
sự kiện native hay câm), và vốn dĩ vẫn phải tự viết logic chờ file render xong —
tức là phần khó nhất không tiết kiệm được gì.

Vì sao không quét nền 24/7: Premiere đóng thì không import được, nên quét lúc đó
vô nghĩa. Một lượt quét bù lúc mở panel cho kết quả tương đương với 0% CPU khi nghỉ.

## Kiến trúc

| Thành phần | Trách nhiệm |
|---|---|
| `bridge/watchfolder.js` (mới) | Config, snapshot, quét, lọc, hàng đợi |
| `bridge/server.js` | 6 endpoint mỏng, uỷ quyền toàn bộ cho module trên |
| `plugin/main.js` — tab **Watch** | UI, poll hàng đợi, tạo bin, `project.importFiles()` |

Bridge không biết gì về Premiere; plugin không biết gì về filesystem. Ranh giới
giữa hai bên là hàng đợi đường dẫn file. Nhờ vậy `watchfolder.js` test được độc lập.

### Luồng

```
Mở panel
  → POST /watch/session/start { projectPath }
      nạp config, quét bù so snapshot, đẩy file mới vào queue, bật timer

Mỗi 2s: GET /watch/poll
  ← { items: [{ id, filePath, binPath, watchId }], stats }
  → plugin tạo cây bin theo binPath → importFiles()
  → POST /watch/ack { done, failed }

Đóng panel / đổi project
  → POST /watch/session/stop → quét lượt cuối, ghi snapshot, dừng timer
```

Plugin ack chứ không để bridge tự đánh dấu: file chỉ coi là xong khi `importFiles()`
thành công thật. Premiere từ chối codec, panel reload giữa chừng → file quay lại queue.

### File trạng thái

Trong `~/Library/Application Support/ClaudeBridge/` — cùng chỗ `hotkeys.json`, không
nằm trong repo nên không bị mất khi cập nhật bridge:

- `watchfolder-config.json` — `{ projectPath → [watch, ...] }`
- `watchfolder-state.json` — snapshot mỗi watch + queue tồn + số lần retry

Snapshot: `{ relPath: [size, mtimeMs] }`. Ghi mỗi 30s và sau mỗi lần phát hiện file
mới, nên bridge bị kill đột ngột thì xấu nhất mất một chu kỳ.

## Mô hình dữ liệu

```jsonc
{
  "id": "w_8f3a",
  "enabled": true,
  "label": "Drone Day1",
  "folder": "/Volumes/RAID/Drone/Day1",
  "binPath": "Footage/Drone",
  "recursive": true,
  "maxDepth": 3,
  "mirrorSubfolders": true,
  "include": ["video"],
  "includeRegex": "",
  "excludeRegex": "_proxy$",
  "intervalMs": 3000,
  "stableChecks": 2
}
```

## Luật lọc

Chạy theo thứ tự, dừng ở lần loại đầu tiên:

1. **Bỏ qua cứng** (không tắt được): dotfile, `.tmp` `.part` `.crdownload` `.download`,
   `._*`, `.DS_Store`, `Adobe Premiere Pro Auto-Save`, `Adobe Premiere Pro Preview Files`,
   `.proxy`.
2. **Preset đuôi file**, chọn nhiều: `video` (mp4 mov mxf mkv avi r3d braw),
   `audio` (wav mp3 aac aiff flac), `image` (jpg png tif psd exr dng), `all`.
3. **includeRegex** — khớp trên tên file **không kèm đuôi**, không phải full path.
   (`_proxy$` khớp `a_proxy.mp4`; nếu soi cả đuôi thì luật quen thuộc này lại trượt.)
4. **excludeRegex** — loại.
5. **Kiểm tra ổn định** — `size` và `mtime` không đổi qua `stableChecks` lượt quét
   liên tiếp. File 0 byte luôn bị hoãn.

Regex sai cú pháp: watch báo lỗi đỏ trong UI và **không chạy** — không im lặng
import tất.

## Quy tắc bin

`mirrorSubfolders: true`, `folder` = `/RAID/Drone/Day1`, `binPath` = `Footage/Drone`:

| File | Bin |
|---|---|
| `Day1/a.mp4` | `Footage/Drone` |
| `Day1/B-roll/b.mp4` | `Footage/Drone/B-roll` |
| `Day1/B-roll/sunset/c.mp4` | `Footage/Drone/B-roll/sunset` |

Tên bin lấy nguyên tên thư mục. Bin trùng tên ở đúng cấp thì dùng lại (so khớp
không phân biệt hoa thường), không tạo trùng. Tắt `mirrorSubfolders` thì mọi file
đổ phẳng vào `binPath`.

**Chống trùng:** trước khi `importFiles()`, plugin duyệt project item tìm clip có
`mediaPath` trùng; có rồi thì bỏ qua và vẫn ack. File bị xoá khỏi thư mục rồi copy
lại được coi là file mới — hành vi có chủ đích.

## UI — tab Watch

Tab thứ 4 cạnh Claude / Voice Gen / Autocut, cùng theme tím tối.

Ràng buộc UXP (theo `CLAUDE.md`): không `position:fixed`, không `z-index`, không
`display:grid`. Vùng cuộn là inner child với `flex:1 1 0; min-height:0; overflow-y:auto`.
Mọi input gọi `window.claimKeyboard()` khi focus và `window.releaseKeyboard()` khi blur.

**Ba khối dọc:**

1. **Thanh trạng thái** — chấm xanh (đang quét) / vàng (tạm dừng) / đỏ (bridge offline
   hoặc project chưa lưu), số watch, tên project, lần quét cuối, số file đã import
   phiên này, nút *Tạm dừng tất cả*. Project chưa lưu (`.prproj` chưa có path) thì
   **không cho tạo watch**, vì config gắn theo project path.

2. **Danh sách watch** (vùng cuộn) — mỗi watch là card gập được. Gập lại chỉ thấy
   tên, số file đã import, `folder → binPath`. Mở ra hiện form đầy đủ. Menu `⋯`:
   Quét ngay / Nhân bản / Sửa / Xoá.

3. **Nhật ký** (đáy, mặc định gập) — `14:32:07  ✓ DJI_0041.MP4 → Footage/Drone/B-roll`.
   Dòng lỗi đỏ kèm lý do và nút *Thử lại*. Giữ 200 dòng gần nhất.

**Cây bin:** nút `Chọn bin…` mở panel cây ngay trong card (không dùng modal — UXP
không hỗ trợ tốt), đọc từ `project.rootItem` một lần khi mở, có nút refresh. Dòng
`＋ Tạo bin mới…` mở ô nhập path kiểu `Footage/Drone/Day1`. Bin đích hiện dạng
breadcrumb. Path chưa tồn tại hiện nhãn xám *"sẽ được tạo khi import"* — không tạo
bin rỗng ngay.

**Thông báo:** import xong một mẻ thì gọi `POST /notify` sẵn có để bật notification
macOS. Bật/tắt trong thanh trạng thái.

## Endpoint

| Endpoint | Việc |
|---|---|
| `POST /watch/session/start` `{projectPath}` | Nạp config, quét bù, bật timer. Trả config + số file chờ |
| `POST /watch/session/stop` | Quét lượt cuối, ghi snapshot, dừng timer |
| `GET /watch/poll` | Tối đa 20 item sẵn sàng + `stats` |
| `POST /watch/ack` `{done, failed}` | Item lỗi quay lại queue; quá 3 lần → `dead` |
| `GET/POST /watch/config` | Đọc/ghi config project hiện tại; validate regex khi ghi |
| `POST /watch/scan-now` `{watchId}` | **Đối chiếu**: đẩy vào hàng đợi mọi file đã có trong snapshot để plugin so với project và import cái còn thiếu |

## Xử lý lỗi

- **Thư mục biến mất** (rút ổ, mất NAS): watch sang `unavailable`, ngừng quét riêng
  nó, cảnh báo vàng trên card. Thử lại mỗi 30s. Quay lại thì chạy tiếp và không coi
  file cũ là mới — snapshot vẫn còn.
- **Premiere từ chối import**: ack `failed`, retry 2 lần cách nhau một chu kỳ, rồi
  `dead` + dòng đỏ. Không chặn các file còn lại.
- **Đổi project khi panel mở**: `session/stop` project cũ, `session/start` project
  mới. Queue project cũ giữ nguyên trên đĩa.
- **Import chậm hơn quét**: queue trần 500 item; vượt thì watch ngừng nạp thêm và
  cảnh báo.
- **Thư mục quá lớn**: quá 20.000 file trong phạm vi watch thì cảnh báo và tự nâng
  `intervalMs` lên 15000.

## Hiệu năng

Chi phí quét phụ thuộc số lượng file, không phụ thuộc dung lượng. Dưới 2.000 file:
5–20ms CPU mỗi lượt, tức dưới 0,5% một core ở interval 3s. Ổ mạng chậm hơn 10–50 lần
vì `stat` đi qua SMB — mặc định gợi ý 10s cho watch trên NAS.

**Quét thích ứng:** không phát hiện gì trong 2 phút → tự giãn interval lên 10s; có
file mới → về lại `intervalMs` ngay.

## Kiểm thử

`watchfolder.js` không đụng Premiere nên test được bằng Node trên thư mục tạm.
Viết test trước phần này — đây là nơi bug thực sự nằm:

- file mới được phát hiện
- file đang ghi dở bị hoãn cho tới khi ổn định (`stableChecks`)
- preset đuôi file, includeRegex, excludeRegex, regex sai cú pháp
- mirror subfolder ra đúng bin path, đúng `maxDepth`
- thư mục biến mất rồi quay lại không gây import lại hàng loạt
- khôi phục snapshot sau khi bridge tắt → chỉ file mới vào queue
- queue trần 500, retry 3 lần rồi `dead`

Phần plugin kiểm thử thủ công trong Premiere: tạo watch → copy file vào → vào đúng
bin; đóng/mở panel → import bù; file trùng bị bỏ qua; regex sai hiện lỗi đỏ; project
chưa lưu thì chặn tạo watch.
