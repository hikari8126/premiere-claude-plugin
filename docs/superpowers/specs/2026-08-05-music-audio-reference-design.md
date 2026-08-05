# Music Audio Reference (ElevenLabs Music v2) — Design

**Date:** 2026-08-05
**Scope:** Thêm tính năng upload một đoạn nhạc reference cho tab Music, dùng ElevenLabs Music v2. Nâng gen thường lên v2.

## Mục tiêu

- Tab Music cho phép user chọn 1 file audio local làm reference.
- 2 chế độ: **Style** (tạo nhạc mới cùng phong cách) và **Extend** (nối tiếp đoạn gốc).
- Gen thường (không reference) cũng dùng Music v2 để tăng chất lượng.
- **Bỏ hẳn v1**: mọi đường gen music luôn `model_id: 'music_v2'`, không còn fallback v1. Đổi tên mặc định "AI BGM v1" -> "AI BGM".

## Luồng dữ liệu

```
Plugin (UXP)                    Bridge                         ElevenLabs
- user chọn file  --nativePath--> đọc file, multipart --------> POST /v1/music/upload
                                  <-- song_id ------------------
- bấm Generate ---refPath+opts--> build composition_plan -----> POST /v1/music (model_id: music_v2)
                                  <-- audio.mp3 ----------------
                  <-- lưu như cũ (temp -> import)
```

Plugin chỉ gửi `file.nativePath` cho bridge (bridge chạy local, đọc file trực tiếp).
Chỉ bridge -> ElevenLabs mới dùng multipart.

## UI (plugin/index.html + main.js)

Chèn khối "Nhạc reference" dưới ô prompt trong `data-mode="music"`:

- Nút **Chọn nhạc reference** -> UXP `getFileForOpening` (mp3/wav/m4a/aac/ogg). Hiện tên file + nút xóa (✕).
- Toggle chế độ: **Style** / **Extend**.
- Slider **Mức bám style** (low/med/high) — chỉ hiện ở Style.
- 2 ô **start/end** (giây, 0–30) chọn đoạn reference. Mặc định 0–30s.
- Prompt vẫn nhập được (tùy chọn khi có reference).
- Khối config (toggle/slider/range) ẩn khi chưa chọn file.
- Khi bật reference: clamp UI độ dài nhạc về tối đa 120s (kèm ghi chú).

State lưu trong biến JS runtime (không cần persist localStorage): `refPath`, `refName`, `refMode`, `condStrength`, `refStartMs`, `refEndMs`.

## Bridge (bridge/server.js)

### Helper mới: `elevenLabsUpload(apiKey, filePath, fields)`
- multipart/form-data POST tới `/v1/music/upload`.
- Field `file` = nội dung file, `extract_composition_plan` không set (không cần).
- Trả về JSON có `song_id`.

### Sửa `/music/generate`
Nhận thêm: `refPath, refMode ('style'|'extend'), conditionStrength ('low'|'medium'|'high'), refStartMs, refEndMs`.

**Không có refPath** (đường cũ, nâng v2):
```js
body = { prompt, music_length_ms, model_id: 'music_v2' }
POST /v1/music
```

**Có refPath:**
1. `song_id = elevenLabsUpload(apiKey, refPath)`
2. Clamp `music_length_ms` <= 120000.
3. `range = { start_ms: refStartMs, end_ms: refEndMs }` (mặc định 0–30000).
4. Build plan theo mode:
   - **style**: `chunks = [{ text: prompt||'', duration_ms, conditioning_ref: { song_id, range }, condition_strength }]`
   - **extend**: `chunks = [{ song_id, range }, { text: prompt||'', duration_ms }]`
5. `body = { model_id: 'music_v2', composition_plan: { ... chunks } }`
6. POST /v1/music, lưu như cũ qua `generateAndSave`.

Reference `elevenLabsRequest` hiện chỉ gửi JSON; upload cần helper multipart riêng, `generateAndSave` giữ nguyên (vẫn nhận body JSON để compose).

## Edge cases

- Chunk EL: mỗi chunk 3–120s, plan tối đa 30 chunk -> ref-mode clamp <=120s.
- `nativePath` rỗng (file cloud) -> plugin báo "chọn file local".
- File fail copyright screening -> bridge trả lỗi rõ, hiện lên plugin status.
- File không tồn tại / đọc lỗi -> lỗi rõ ràng.
- Extend nhưng độ dài gen < range reference: vẫn hợp lệ (2 chunk riêng biệt).

## Versioning

Bump plugin + bridge versions (test pump `d`), KHÔNG tạo CCX/zip trừ khi user yêu cầu release.

## Không làm (YAGNI)

- Không chẻ nhiều chunk để vượt 120s.
- Không persist reference file qua session.
- Không expose custom finetune / nhiều reference cùng lúc.
