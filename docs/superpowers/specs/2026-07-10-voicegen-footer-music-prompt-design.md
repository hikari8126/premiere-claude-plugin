# VoiceGen: footer ghim, bin theo mode, Music prompt builder

Ngày: 2026-07-10 · Trạng thái: đã duyệt thiết kế, chờ plan

## Bối cảnh

Tab Voice Gen có ba mode (`tts` / `sfx` / `music`) dùng chung một nút generate
(`vgGenerate`, đổi nhãn theo mode ở `main.js:6559`). Thanh generate hiện nằm **trong**
vùng cuộn `.vg-leftScroll`, nên khi nội dung dài nó bị cuộn khuất. Tab "Tạo Sub" đã giải
đúng bài này bằng `.st-footer` — sibling của `.st-scroll`, `flex:0 0 auto`.

UXP không hỗ trợ `position:sticky` (`styles.css:678`), nên ghim = tách khỏi vùng cuộn,
không phải CSS sticky.

## Phạm vi

Ba thay đổi độc lập, có thể làm và test riêng:

1. Ghim footer + đổi chữ xám thành trắng
2. Chuyển "Move to bin" vào Settings + bin đích theo mode
3. Music prompt builder (modal + endpoint AI)

---

## 1. Footer ghim

**Cấu trúc.** Chuyển `.vg-genBar` ra ngoài `.vg-leftScroll`, thành sibling ngay sau nó,
với `flex: 0 0 auto`. Vì cả ba mode dùng chung `vgGenerate`, ghim một lần là xong cả ba.

Footer chứa: toggle "2 variations" + nút GENERATE. Checkbox "Move to bin" rời khỏi footer
(xem mục 2).

**Mode `create`.** `main.js:6554` đã ẩn `.vg-genBar` khi `mode === 'create'` bằng
`style.display`. Logic này dùng `querySelector('.vg-genBar')` nên **vẫn chạy sau khi dời
phần tử** ra ngoài vùng cuộn — không cần sửa. Chỉ cần giữ nguyên class name.

Ghi nhận một bất nhất sẵn có: `.vg-moveVoRow` hiện **không** bị ẩn ở mode `create`, dù
Create Voice không import gì. Việc dời checkbox sang Settings xử lý luôn chuyện này, vì
`main.js:6555` đã ẩn cả `.vg-right` (panel Settings) ở mode `create`.

**Màu chữ.** Hai class khác nhau, cùng đổi sang `var(--text)`:

| Class | Hiện tại | Mới |
|---|---|---|
| `.vg-checkbox-row` | `rgba(255,255,255,0.5)` | `var(--text)` |
| `.vg-varToggle` | `var(--text-dim)` | `var(--text)` |

**Ràng buộc UXP.** Giữ nguyên `display:flex` (không dùng `grid`). Không thêm `z-index`.

---

## 2. Bin đích theo mode

`ppMoveToVOBin(item, proj)` (`main.js:~2650`) hard-code chuỗi `"Voice Over"`.

**Đổi thành** `ppMoveToBin(item, proj, binName)`, với bin đích suy ra từ `currentMode`:

| Mode | Bin |
|---|---|
| `tts` | `Voice Over` |
| `sfx` | `SFX` |
| `music` | `BGM` |

Giữ nguyên hành vi tạo bin nếu chưa tồn tại. Checkbox vẫn là **một** công tắc chung
(`vgMoveToVOBin`), chỉ tên bin đổi — không tách thành ba checkbox.

`ppShouldMoveToVOBin()` và `ppMoveToVOBinIfEnabled()` giữ nguyên tên để không phải sửa
mọi call site; chỉ phần trong ruột đọc `currentMode`.

**Vị trí checkbox.** Chuyển khỏi footer, sang panel Settings của Voice Gen (cột phải,
`.vg-right`). Label đổi thành `Chuyển vào bin sau khi import` (bỏ chữ "Voice Over" vì bin
nay đổi theo mode), kèm hint liệt kê ba bin.

`.vg-right` bị ẩn ở mode `create` (`main.js:6555`), nhưng checkbox vẫn nằm trong DOM nên
`ppShouldMoveToVOBin()` đọc `.checked` bình thường. Không cần xử lý riêng.

---

## 3. Music prompt builder

### 3.1 UI

Nút bánh răng cạnh ô `vgMusicPrompt` (chỉ hiện ở mode `music`) → mở modal.

Modal có sáu nhóm. Số lượng chọn theo nguyên tắc: **thứ gì loại trừ nhau thì chọn một,
thứ gì cộng dồn được thì chọn thoải mái.**

| Nhóm | Chọn | Lý do |
|---|---|---|
| Thể loại | tối đa 2 | "Lo-fi + Jazz" hợp lý; 4 thể loại một lúc thì mâu thuẫn |
| Cảm xúc | tối đa 2 | "Melancholic + Nostalgic" hợp lý; "Sad + Joyful" thì không |
| Nhạc cụ | không giới hạn | Nhạc cụ cộng dồn, không chọi nhau |
| Tempo | 1 | Không thể vừa chậm vừa nhanh |
| Không gian âm thanh | 1 | "Lo-fi vibe" và "Crystal clear" loại trừ nhau |
| Giọng hát | công tắc | Mặc định **tắt** → luôn append `Instrumental` |

Thêm hai thứ ngoài spec gốc:

- **Ô mô tả tự do** (textarea ngắn, tuỳ chọn) — đẩy kèm cho AI, để diễn đạt thứ mà taxonomy
  không phủ được ("nhạc nền cho cảnh mở hộp sản phẩm").
- **Lưu preset** — lưu bộ chọn hiện tại vào `localStorage` key `vg_music_presets`, đặt tên,
  chọn lại từ dropdown. Cùng cơ chế với preset tên sequence của Autocut (`sacSeqNamePreset`).

**Cố ý loại khỏi phạm vi:** trường "nghe giống nghệ sĩ X". Suno/Udio từ chối prompt kiểu
này, và nó kéo theo rắc rối bản quyền.

### 3.2 Taxonomy

Lấy từ JSON tham khảo, có chỉnh:

**Tempo — gom lại.** JSON gốc trộn từ đồng nghĩa với khoảng BPM vào một mảng phẳng
(`"Slow tempo", "60-80 BPM", "Laid-back", "Plodding"`). Thực chất đó là **4 dải**, mỗi dải
có mấy từ đồng nghĩa. Gom thành 4 lựa chọn, mỗi lựa chọn tự đóng góp cả tên dải lẫn BPM:

| Nút | Đóng góp vào prompt |
|---|---|
| Chậm | `Slow tempo, 60-80 BPM` |
| Vừa | `Mid-tempo, 90-110 BPM` |
| Nhanh | `Fast tempo, 120-140 BPM` |
| Rất nhanh | `Very fast, 150+ BPM` |

Các nhóm còn lại (genres, moods, instruments, production_vibe) dùng nguyên danh sách trong
JSON tham khảo.

### 3.3 Luồng dữ liệu

```
Modal (lựa chọn)
  → gộp thành chuỗi tag:  genres, moods, instruments, tempo, vibe, [Instrumental]
  → POST /music/prompt { tags, freeText, provider, model, apiKey }
       bridge: callLLM(systemPrompt + tags + freeText)   ← server.js:2158, dùng lại
  → text trả về  → ghi đè vgMusicPrompt
```

Chuỗi tag nối bằng dấu phẩy chính là công thức trong `developer_notes` của JSON gốc. Nó
đóng **hai** vai: đầu vào cho AI, và **phương án dự phòng**.

### 3.4 Xử lý lỗi

Nếu `callLLM` ném (mất key, lỗi mạng, quota), plugin **không** để ô prompt trống. Nó đổ
thẳng chuỗi tag đã nối vào `vgMusicPrompt` và hiện cảnh báo rõ ràng:

> ⚠ AI không phản hồi — đã dùng prompt ghép thẳng từ lựa chọn.

Suno/Udio vốn ăn prompt dạng tag liệt kê rất tốt, nên fallback này dùng được ngay chứ
không phải kết quả rác.

**Nguyên tắc:** không thất bại âm thầm. Lỗi "bỏ audio source" vừa rồi sống sót qua bốn
phiên bản đúng vì nó nuốt lỗi vào `console.warn`. Mọi nhánh hỏng ở đây phải hiện lên UI.

### 3.5 Endpoint

`POST /music/prompt`

```
body: { tags: string, freeText?: string, provider?, model?, apiKey? }
200:  { ok: true, prompt: string }
500:  { ok: false, error: string }
```

Bump `BRIDGE_VERSION` (thêm endpoint = đổi API).

---

## Ràng buộc UXP cần nhớ

- Không `position:sticky`, không `z-index`, không `display:grid`
- Vùng cuộn: `flex:1 1 0; min-height:0; overflow-y:auto` trên **inner child**
- `<button>` không render con → dùng `div role="button"`
- Modal: theo pattern `sacBindModal` / `sacNewSeqModal` đã chạy được
- Chip nhiều dòng: `display:flex; flex-wrap:wrap` (không `grid`)

## Kiểm thử

Không có test framework trong repo; xác minh bằng cách chạy thật trong Premiere.

1. Footer hiện ở đáy panel ở cả `tts`/`sfx`/`music`, kể cả khi nội dung dài; **ẩn** ở `create`
2. Chữ "2 variations" và checkbox bin hiển thị trắng
3. Gen ở mỗi mode → clip vào đúng bin (`Voice Over` / `SFX` / `BGM`); bỏ tick → không vào bin
4. Modal: chọn quá hạn mức (thể loại thứ 3) bị chặn; tempo/vibe là chọn-một
5. Bấm "Tạo prompt" → ô prompt được ghi đè bằng văn xuôi
6. Tắt mạng / xoá key → hiện cảnh báo + prompt ghép thẳng, **không** để trống
7. Lưu preset → reload plugin → preset còn

## Version

Ba thay đổi gộp một release. Bump `plugin/manifest.json` + `PLUGIN_VERSION`, và
`BRIDGE_VERSION` (endpoint mới). Không build/release cho tới khi user duyệt.
