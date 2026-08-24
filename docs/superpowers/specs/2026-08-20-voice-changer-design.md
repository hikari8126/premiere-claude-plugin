# Voice Changer (Đổi giọng) — Design Spec

> Ngày: 2026-08-20 · Nhánh: `fix/voice-search-keyboard`
> Tính năng: thêm ElevenLabs Speech-to-Speech (voice changer) vào plugin Voice Gen.

## 1. Mục tiêu

Cho phép user lấy một đoạn audio (từ clip đang chọn trên timeline hoặc file trên máy),
đổi sang một giọng đích của ElevenLabs, rồi nghe thử / lưu / import vào Premiere —
tái dùng tối đa hạ tầng sẵn có (thu input của Clone Voice, result section, flow import).

## 2. Phạm vi

**Trong phạm vi**
- Card thứ 3 **"Voice Changer"** trong tab con **Create** (cạnh Clone Voice / Design Voice).
- Input: (a) **clip đang chọn** trên timeline (`getSelection()`) — nhiều clip / nhiều mẩu
  audio thì gộp thành 1 file; (b) **upload file** từ máy.
- Giọng đích: **voice picker riêng** trong card, dùng chung dữ liệu voice-list + tìm kiếm.
- Settings đầy đủ: chọn **model STS**, slider **Stability / Similarity / Style**,
  toggle **Khử tiếng ồn nền**.
- Kết quả: đổ vào **`#vgResultSection` dùng chung** → preview + Lưu + Import bin +
  Import timeline (đúng flow tab Voice, gồm bản vá move-to-bin v5.3.3).
- Endpoint bridge mới `POST /voice/change`.

**Ngoài phạm vi (YAGNI)**
- Ghi âm trực tiếp trong plugin (UXP hạn chế).
- Tự ghi đè clip gốc trên timeline.
- Xuất 2 variations — STS luôn 1 kết quả.

## 3. Kiến trúc & luồng dữ liệu

```
[Create tab] Voice Changer card
  Nguồn audio ──┬─ From Timeline: getSelection() → clips[{filePath,inPoint,outPoint}]
                │                    → POST /tts/concat-from-sequence → merged mp3 path
                └─ From File: vcBrowseFile (UXP file picker) → local path
                                     │
                          inputPath ─┘
  Giọng đích (picker riêng) → voiceId
  Settings → { modelId, stability, similarity, style, removeBackgroundNoise }
                                     │
        POST /voice/change ─────────┘
                                     │
   Bridge: đọc inputPath → multipart POST ElevenLabs
     /v1/speech-to-speech/{voiceId}?output_format=mp3_44100_128
       fields: audio(file), model_id, voice_settings(JSON), remove_background_noise
     → lưu output qua cùng cơ chế /tts/generate
     → { ok, variations:[{audioPath,previewUrl,sizeBytes,filename}], saveDir }
                                     │
   Plugin: lastVariations = resp.variations → renderVariations()
     → #vgResultSection: preview + Lưu + Import bin + Import timeline
```

## 4. Bridge — `POST /voice/change`

**Request (JSON):**
| field | bắt buộc | ghi chú |
|---|---|---|
| `apiKey` | ✓ | ElevenLabs key |
| `voiceId` | ✓ | giọng đích |
| `inputPath` | ✓ | đường dẫn file audio local (đã gộp nếu từ nhiều clip) |
| `modelId` | | mặc định `eleven_multilingual_sts_v2` |
| `settings` | | `{ stability, similarity, style }` (0..1) |
| `removeBackgroundNoise` | | boolean, mặc định false |
| `outputFormat` | | mặc định `mp3_44100_128` |
| `filename` | | tên gợi ý cho file output |
| `outputDir` | | thư mục lưu; rỗng → temp (Import sẽ move sau) |

**Xử lý:**
1. Validate `apiKey`, `voiceId`, `inputPath` (tồn tại trên đĩa).
2. Dựng `multipart/form-data`: `audio` = stream file; `model_id`; `voice_settings` =
   `JSON.stringify({stability, similarity_boost:similarity, style})`;
   `remove_background_noise` nếu bật.
3. `POST https://api.elevenlabs.io/v1/speech-to-speech/{voiceId}?output_format=...`
   với header `xi-api-key`.
4. Nhận audio bytes → lưu bằng **phần lưu/preview** dùng chung (temp dir hoặc
   `outputDir` + tạo `previewUrl`). Lưu ý: `generateAndSave()` hiện gắn với POST
   JSON theo `urlPath` nên KHÔNG gọi trực tiếp cho STS (multipart); tách phần
   "ghi bytes ra file + build variation object" thành helper dùng chung, hoặc
   viết inline trong `/voice/change` theo đúng shape variation của `/tts/generate`.
5. Trả `{ ok:true, variations:[{audioPath, previewUrl, sizeBytes, filename}], saveDir }`.

**Lỗi:** thiếu field / file không tồn tại / ElevenLabs trả non-2xx → `res.status(500).json({ok:false, error})`, log `[voice/change]` (giống pattern `/tts/generate`).

**Model hợp lệ:** `eleven_multilingual_sts_v2`, `eleven_english_sts_v2`
(models có `can_do_voice_conversion`).

## 5. Plugin UI (tab Create)

**Method card** — thêm `#vcChangeCard` vào `.vc-methodCards`
(icon `wand`/`shuffle`, title "Voice Changer", sub "Đổi giọng đoạn audio sang giọng khác").
Bấm card → hiện `#vcChangeSection`, ẩn Clone/Design section (theo cơ chế chọn card sẵn có).

**`#vcChangeSection`:**
- **Bước 1 — Nguồn audio:** seg tabs From Timeline / From File.
  - From Timeline: nút "Lấy clip đang chọn" → `getSelection()` → duyệt track items đang
    chọn → `vcGetTrackItemFilePath` + in/out → `clips[]` → `/tts/concat-from-sequence`
    → set `vcxInputPath`; hiện tên + số clip.
  - From File: reuse logic `vcBrowseFile` → set `vcxInputPath`.
- **Bước 2 — Giọng đích:** picker riêng (`#vcxVoicePick`) dùng chung nguồn voice-list
  (danh sách + ô tìm kiếm) như tab Voice; nhớ voice đã chọn (localStorage).
- **Bước 3 — Settings:** select Model (Multilingual / English STS) +
  slider Stability / Similarity / Style + checkbox Khử tiếng ồn nền. Nhớ localStorage.
- **Nút "Đổi giọng"** (`#vcxConvertBtn`): validate input + voice → `POST /voice/change`
  → `lastVariations = resp.variations`, `lastVariationsMode='tts'` → `renderVariations()`
  → `els.resultSection.hidden=false`.

**State (biến mới, prefix `vcx` để không đụng `vc` của Clone):**
`vcxInputPath`, `vcxVoiceId`, `vcxSettings`, `vcxSource ('sequence'|'file')`.

**Persistence:** localStorage `vg_vcx_v1 = { voiceId, modelId, stability, similarity, style, removeNoise }` (global, không theo project).

## 6. Tái dùng

| Cần | Dùng lại |
|---|---|
| Gộp nhiều clip → 1 file | `/tts/concat-from-sequence` (đã có) |
| Lấy path media của track item | `vcGetTrackItemFilePath()` (đã có) |
| Chọn file từ máy | logic `vcBrowseFile` (đã có) |
| Hiện kết quả + Lưu + Import | `#vgResultSection` + `renderVariations()` + flow import (đã có) |
| Lưu output ở bridge | helper lưu của `/tts/generate` / `generateAndSave` |
| Voice list + search | nguồn dữ liệu voice-list của tab Voice |

## 7. Error handling

- Chưa chọn input → status đỏ "Chưa có audio nguồn".
- Chưa chọn selection nào trên timeline → "Hãy chọn clip audio trên timeline".
- ffmpeg thiếu (concat) → thông báo sẵn có từ `/tts/concat-from-sequence`.
- Lỗi API STS → surface `resp.error` lên status của card.
- Import vào bin: đã có bản vá move-to-bin (báo ⚠ khi move fail).

## 8. Testing

- **Bridge:** `node --check`; test validate param (thiếu apiKey/voiceId/inputPath → 500);
  test dựng multipart với file mẫu (mock fetch tới ElevenLabs) trả về bytes → lưu file OK.
- **Plugin:** `node --check main.js`. Manual trong Premiere:
  (1) chọn 2 clip audio → Voice Changer → From Timeline → gộp OK;
  (2) chọn voice đích + settings → Đổi giọng → nghe thử;
  (3) Lưu + Import vào đúng bin + Import timeline.
- Bump `PLUGIN_VERSION` + `manifest.json` + CHANGELOG khi hoàn tất.

## 9. Câu hỏi mở

Không còn — mọi quyết định đã chốt trong brainstorming.
