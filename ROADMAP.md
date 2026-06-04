# ROADMAP — Premiere Claude Plugin

> Đóng gói các hướng phát triển tiếp theo + việc cần verify, để session/người sau tiếp nối.
> Trạng thái khi viết: **Plugin v4.4.1.1 · Bridge API v1.5.8 · Bridge app v2.26** (đã push `main`).
> Quy ước release/versioning: xem `feedback_bridge_versioning` (bump plugin + bridge mỗi thay đổi; build-app.sh; gh release; update-gist.sh).

---

## A. Cần VERIFY (đang chờ test thực tế trong Premiere)
Các fix gần đây chưa được xác nhận 100% trên máy thật:
- [ ] **New seq không crash + không chèn "clip mẫu"** (v4.3.6 — bỏ `createSequenceFromMedia`, tạo sequence rỗng bằng `createSequence`). Đánh đổi: fps = mặc định project, không theo source.
- [ ] **Tên sequence đầy đủ** qua `createSetNameAction` (v4.3.4) — CHƯA chắc API rename có trong bản Premiere đang dùng; xem log `[SAC] No rename API` nếu lỗi.
- [ ] **parseBlocks tách block mới** (v4.4.1.1: text + source HOẶC timecode thật → block mới; source trống + timecode → kế thừa source = xử lý merged cell). Rủi ro: ảnh hưởng các format cutsheet cũ → cần test nhiều format.
- [ ] **AI parse cutsheet** (v4.4.0) trên các cutsheet "ối dồi ôi" thật.
- [ ] **Bridge auto-update + no-confirm** (2.23/2.24) chỉ hiệu lực khi đã update LÊN bản đó (bootstrap).

---

## B. Tính năng có thể phát triển thêm

### B1. Super Auto Cut (SAC)
- **Re-time theo voice**: tự co/giãn độ dài clip video cho khớp độ dài đoạn voice của block (thay vì cắt cứng theo timecode cutsheet).
- **FPS cho sequence mới**: hiện `createSequence` lấy fps mặc định project (đã bỏ createSequenceFromMedia để tránh crash). Thêm: ô chọn FPS trong popup New seq, hoặc tạo sequence theo **preset** khớp fps mong muốn (cần khảo sát API preset của UXP).
- **Dry-run / preview timeline** trước khi dựng thật + **Undo AutoCut** (hoàn tác cả mẻ cắt).
- **Multi-speaker voice (Phase 4b)** — deferred; xem memory `project_4b_multispeaker_gen` (pull git mới trước khi làm).
- **Bảng tổng hợp source ✗/⚠** một chỗ trước khi Run + nút "bind tất cả" / "skip tất cả".
- **AI parse nâng cao**: lưu **preset prompt theo từng format** (profile); hoàn thiện logic cho **Parse with image** (hiện thiếu logic, chỉ nên dùng khi chỉ có ảnh — text vẫn chính xác hơn vì ảnh cắt cụt tên).

### B2. VoiceGen / AI
- **Usage / cost meter**: đếm token + ước tính chi phí mỗi lần gọi Claude/GPT (Organize, parse, normalize).
- **Thêm provider/model** khi cần (hiện: Claude qua API/CLI; OpenAI qua REST).

### B3. Xuất
- **Xuất SRT / phụ đề** từ script + word-timestamp (đã có hạ tầng whisper align) — tiện cho social.

### B4. Update system / hạ tầng
- **Compat check 2 chiều plugin↔bridge**: hiện chỉ cảnh báo "bridge quá cũ" (REQUIRED_BRIDGE hard-code = 1.5.2). Nên đẩy `requiredBridge`/`requiredPlugin` từ Gist để không hard-code; và kiểm chiều bridge-cần-plugin-tối-thiểu.
- **ElevenLabs shared key**: hiện model A (mỗi người tự nhập key ở Settings; bridge .env `ELEVENLABS_API_KEY` là fallback). Nếu muốn "1 key dùng chung" → bundle vào .app + chuyển repo/release sang **private** (vì public release zip vẫn lộ key). **Nhắc: key cũ `03dcac...` đã lộ trên git history — đã yêu cầu user rotate.**

---

## C. Bối cảnh kỹ thuật quan trọng (đọc memory để đầy đủ)
- Memory chính: `project_sac_state` (versions + key API facts + toàn bộ lịch sử fix 4.2.x→4.4.x).
- UXP gotchas: `uxp-known-issues` (no position:fixed/z-index/grid; scroll cần flex:1+min-height:0+overflow trên INNER child; native input/select luôn vẽ đè → ẩn nền khi mở modal; mọi Premiere API async).
- Quy trình release: `feedback_bridge_versioning`.
- Khi user HỎI → trả lời, không tự implement: `feedback_question_vs_implement`.

## D. Trạng thái git
- `main` đã push tới commit block-split (`c7fda92`).
- Bridge KHÔNG đổi từ 4.4.0 (vẫn 1.5.8/2.26); loạt 4.4.0.x chỉ đổi plugin trừ 4.4.0 (thêm endpoint parse-cutsheet).
