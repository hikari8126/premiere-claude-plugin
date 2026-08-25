# Trang Auto — dựng bộ 3 video ads từ script + voice

**Ngày:** 2026-08-25
**Trạng thái:** Design (chờ soát)

## Bối cảnh

Người dùng làm video quảng cáo theo sản phẩm. Mỗi order sinh ra một **bộ 3 video**,
đánh số `<bộ>.0`, `<bộ>.1`, `<bộ>.2` (ví dụ bộ 30 → `30.0`, `30.1`, `30.2`).
Voice over lưu trong thư mục sản phẩm, nhóm theo bộ: `…/voice over/30x/30.0`,
`30.1`, `30.2`. Cấu trúc tương tự được phản chiếu trong bin của project Premiere.

Hiện tại tab Autocut chỉ phục vụ **một video một lần**: một bảng script → Validate →
blocks → một voice → một sequence. Làm hết một bộ phải lặp tay 3 lần, mỗi lần tự
chọn thư mục lưu voice và tự đặt tên sequence.

## Mục tiêu

Một trang riêng cho phép khai báo cả bộ 3 video một lần, rồi tự chạy: dựng script,
validate, gen voice, lưu đúng vị trí, tạo sequence đúng tên/ratio, dựng timeline.
Người dùng chỉ cần có mặt ở hai điểm: khi validate lỗi, và khi duyệt voice.

## Ngoài phạm vi (YAGNI)

- Không sửa workflow Autocut hiện tại — trang mới là overlay tách biệt.
- Không tự dò số bộ (đã loại: rủi ro ghi đè / nhảy số). Người dùng nhập số bộ.
- Không hỗ trợ số lượng video khác 3 trong bản này.
- Không dùng AI để suy mẫu tên sequence (đã loại: tên deliverable cần chính xác
  tuyệt đối, mà thành phần lại cố định theo project → điền một lần là đủ).
- Không chạy song song các job (tránh rate limit ElevenLabs).
- Không điều khiển từ Claude CLI / terminal (đã loại ở bước brainstorm).

## Giao diện

Nút **Auto** trong tab Autocut mở overlay `#sacAutoPage`. Overlay ẩn
`#tab-autocut .sac-app` theo đúng thủ pháp của `sacOpenNewSeqModal`
(`plugin/main.js:4900`) để native inputs không xuyên qua lớp phủ.

**Header — khai báo một lần cho cả bộ:**

| Trường | Ghi chú |
|---|---|
| Số bộ | ví dụ `30`; suy ra toàn bộ tên |
| Voice mặc định | nguồn `VG_VOICES_DATA` (khớp theo `label`) |
| Ratio mặc định | dùng lại đúng danh sách options của `#sacNewSeqRatio`; mặc định `1080x1920` |
| ☐ Bỏ qua nghe thử | tick = chặng 3 chạy luôn, không chờ duyệt |
| Nút **Chạy cả bộ** | khởi động pipeline |

**Ba tab `.0` `.1` `.2`** — mỗi tab:

- Ô dán **TSV** (script đã gọn từ Sheets/Excel)
- Voice, Ratio: kế thừa header, sửa riêng được
- Đèn trạng thái của job

## Đầu vào: TSV, không dùng AI parse

Ô dán nhận TSV giống đường manual paste, **không** đi qua `/superautocut/parse-cutsheet`.
Luồng xử lý: `parseTSV` → remap cột theo `SAC_COL_ORDER` sang thứ tự ngữ nghĩa
`[text, time, src]` → **`expandRows`**.

`expandRows` là bắt buộc: nó tách dòng có nhiều timestamp và kế thừa source khi ô bị
merge. Lưu ý đường AI hiện tại (`sacAiFill`, `plugin/main.js:4788`) **không** chạy
`expandRows` — nếu sau này trang Auto có thêm chế độ AI thì phải bổ sung bước này,
nếu không sẽ mất tính năng tách timestamp.

Lợi ích của TSV: xác định, không tốn token, không cần bước preview để soát AI →
pipeline chạy liền mạch hơn.

## Cấu hình theo project (điền một lần)

Tên sequence là **tên deliverable giao cho CO**, nên phải chính xác tuyệt đối. Các
thành phần của nó cố định theo project — chỉ `{bộ}.{idx}` đổi mỗi lần chạy, mà số đó
đã nhập ở header. Vì vậy **không dùng AI** để đặt tên: điền một lần rồi nhớ theo
project (localStorage khoá theo tên/GUID project).

Ví dụ tên thật: `SonaShape vid31.0 [c.ha.ttdo] [hoang.vietnguyen]`

```
SonaShape vid31.0 [c.ha.ttdo] [hoang.vietnguyen]
└ sản phẩm ┘ └vid{bộ}.{idx}┘ └c.{CO}─┘ └─{Editor}─┘
```

Ngoặc vuông là ký tự thật; có dấu cách giữa các nhóm; `c.` là tiền tố cố định trước
tên CO.

| Trường cấu hình | Ví dụ |
|---|---|
| Sản phẩm | `SonaShape` |
| CO | `ha.ttdo` |
| Editor | `hoang.vietnguyen` |
| Mẫu tên sequence | `{sp} vid{bộ}.{idx} [c.{CO}] [{Editor}]` |
| Bin sequence | `Sequence / FB / {bộ}x` |
| Bin voice | `voice over / {bộ}x` |

`FB` nằm trong mẫu sửa được, **không hard-code** — chạy nền tảng khác chỉ cần sửa
cấu hình, không sửa code.

## Suy ra tên và đường dẫn

Từ số bộ `31` với cấu hình ví dụ trên:

| Thứ | Giá trị |
|---|---|
| Sequence | `SonaShape vid31.0 [c.ha.ttdo] [hoang.vietnguyen]` (và `.1`, `.2`) |
| Bin sequence | `Sequence / FB / 31x` |
| File voice | `<gốc sản phẩm>/…/voice over/31x/31.0.mp3` |
| Bin voice | `voice over / 31x` |

**Đặt sequence vào bin:** dùng `ppGetOrCreateBin` (`plugin/main.js:2673`) — hàm này
**đã** hỗ trợ đường dẫn lồng nhiều cấp với dấu phân cách `' / '` và tự tạo cấp thiếu.
Luồng: tạo sequence → lấy `projectItem` → `ppMoveToBin` vào `Sequence / FB / 31x`.
Không cần code mới cho phần lồng bin.

**Gốc sản phẩm (trên đĩa):** suy ra từ vị trí file `.prproj` của project đang mở.
Xem phần Rủi ro — cần dự phòng.

**Thư mục "voice over":** dò theo biến thể `voice over` / `voiceover` / `vo`
(cùng quy tắc với logic bin sẵn có ở `plugin/main.js:2671`); không thấy thì tạo mới.
Thư mục `31x` không có thì tạo.

## Thực thi: ba chặng, gom điểm dừng

Mỗi chặng lặp qua 3 job **tuần tự**. Mô hình này (thay vì chạy trọn từng video) để
dồn thời gian chờ vào lúc người dùng rời máy, và gom việc cần người vào 2 lần.

**Chặng 1 — Dựng & validate**
Với từng job: nạp rows vào bảng → chạy validate hiện có (`/superautocut/validate`,
`plugin/main.js:4730`) → lưu kết quả blocks vào job. Cuối chặng: nếu có job thiếu
media thì báo gộp một lần. Job lỗi bị đánh dấu, **không chặn** job khác.

**Chặng 2 — Gen voice**
Với từng job: `normalize-script` (`plugin/main.js:4401`) → gen voice ElevenLabs →
`/tts/move` đưa file về đúng path suy ra (bỏ qua modal chọn thư mục của
`vgEnsureSaved`) → nạp vào bin `30x`. Cuối chặng: thông báo "Voice 3/3 xong, chờ duyệt".

**Chặng 3 — Align & dựng timeline**
Nếu không tick bỏ qua: hiện player ngay trên trang Auto — mỗi tab một player cho
voice của job đó — duyệt từng cái, gen lại cái nào chưa vừa ý. Không chuyển sang tab
Voice Gen (giữ người dùng ở một chỗ). Sau khi duyệt (hoặc bỏ qua): với từng job → align voice (`sacAlignVoice`) →
`sacRunAutoCut('new')` với tên + ratio đã suy ra (`plugin/main.js:5445`) → chuyển
sequence vừa tạo vào bin `Sequence / FB / {bộ}x`.
Cuối chặng: thông báo "Bộ 30 xong".

## Thông báo

Endpoint mới `POST /notify {title, body}` trong bridge, gọi
`osascript -e 'display notification …'` theo khuôn `execFile` đã dùng ở
`bridge/server.js:3100`.

Bắn thông báo tại: validate có lỗi · voice xong chờ duyệt · cả bộ xong · lỗi bất kỳ.

## Mô hình dữ liệu

```
projectConfig = {        // lưu theo project, điền một lần
  product,               // 'SonaShape'
  co,                    // 'ha.ttdo'
  editor,                // 'hoang.vietnguyen'
  seqNameTpl,            // '{sp} vid{bộ}.{idx} [c.{CO}] [{Editor}]'
  seqBinTpl,             // 'Sequence / FB / {bộ}x'
  voiceBinTpl,           // 'voice over / {bộ}x'
}

autoSet = {
  setNumber,            // 30
  defaultVoiceId,
  defaultRatio,
  skipAudition,
  jobs: [ {
    idx,                // 0 | 1 | 2
    tsvRaw,
    rows,               // sau expandRows
    voiceId, ratio,     // kế thừa hoặc override
    state,              // idle | validated | voiced | built | error
    error,
    voicePath,
    seqName,            // 'SonaShape vid31.0 [c.ha.ttdo] [hoang.vietnguyen]'
  } × 3 ]
}
```

Lưu localStorage để đóng panel không mất việc đang làm.

## Chuyển ngữ cảnh giữa các job — phần khó nhất

Bảng script (DOM `#sacBody`), `parsedBlocks`, và state voice hiện là **biến toàn cục
dùng chung một bảng**. Chạy theo chặng nghĩa là ở chặng 1 và chặng 3 phải nạp/lưu lại
state cho từng job.

Giải pháp: tách một lớp riêng `sacJobContext` với hai hàm `save(job)` / `load(job)`
gom toàn bộ state dùng chung vào một chỗ. **Không** rải điều kiện `if (autoMode)`
khắp code cũ — đó là cách nhanh nhất làm hỏng workflow hiện tại.

Chặng 2 không cần bảng (chỉ cần script đã normalize, đã lưu trong job) nên không
phải chuyển ngữ cảnh.

## Xử lý lỗi

- Một job lỗi bị đánh dấu và bỏ qua ở các chặng sau; job còn lại chạy tiếp.
- Cuối mỗi chặng: báo cáo tổng (bao nhiêu job ok / lỗi, lỗi gì).
- Lỗi gen voice: cho gen lại riêng job đó, không chạy lại cả bộ.

## Rủi ro & dự phòng

1. **Đường dẫn `.prproj` chưa xác minh.** Không có chỗ nào trong code hiện tại dùng
   đường dẫn file project, nên chưa biết UXP có trả về hay không — phải thử trong
   Premiere thật ở bước đầu triển khai.
   *Dự phòng:* nếu API không cho, chuyển sang "chọn thư mục sản phẩm một lần rồi nhớ"
   (localStorage per project).
2. **Rate limit ElevenLabs** khi gen 3 voice liên tiếp → chạy tuần tự, không song song.
3. **Hỏng workflow cũ** do state toàn cục → xem phần `sacJobContext`.

## Kiểm thử

- TSV có dòng nhiều timestamp → `expandRows` tách đúng, khớp kết quả của manual paste.
- TSV có ô source merge → kế thừa source đúng.
- Một job thiếu media → 2 job kia vẫn chạy hết, báo cáo đúng job lỗi.
- Số bộ `31` + cấu hình project → sinh đúng `SonaShape vid31.0 [c.ha.ttdo]
  [hoang.vietnguyen]` (giữ nguyên ngoặc vuông, dấu cách, tiền tố `c.`).
- Sequence mới nằm đúng trong bin `Sequence / FB / 31x`; bin thiếu cấp → tự tạo.
- File voice vào đúng `voice over/31x/31.0.mp3`.
- Thư mục "voice over" viết hoa/biến thể → dò được; không có → tạo.
- Tick bỏ qua nghe thử → chạy một mạch, không chờ.
- Mở/đóng trang Auto → workflow Autocut cũ vẫn nguyên vẹn.
