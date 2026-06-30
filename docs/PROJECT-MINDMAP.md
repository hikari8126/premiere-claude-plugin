---
title: Premiere Claude Plugin — Project Mindmap
type: context-map
plugin_version: 4.8.5
bridge_api_version: 1.5.8
bridge_app_version: 2.26
updated: 2026-06-30
tags:
  - premiere
  - uxp
  - claude
  - elevenlabs
  - autocut
  - context-map
---

# 🗺️ Premiere Claude Plugin — Project Mindmap

> **Mục đích:** Note context để Claude (và người sau) nạp nhanh bức tranh tổng thể dự án.
> **Đọc kèm:** [[CLAUDE]] (setup), [[BLUEPRINT]] (spec chi tiết), [[ROADMAP]] (việc tiếp), [[CHANGELOG]] (lịch sử fix).

---

## 1. Tổng quan 1 dòng

Plugin **3-in-1** cho Adobe Premiere Pro (UXP) → chat với Claude để edit timeline, tạo giọng đọc ElevenLabs, và tự dựng timeline từ cutsheet (Autocut/SAC). Một **Bridge Server** Node.js local (`:3030`) đứng giữa, gọi Claude CLI / Anthropic SDK + ElevenLabs + Whisper.

```mermaid
mindmap
  root((Premiere<br/>Claude Plugin))
    UXP Plugin
      manifest.json
      index.html  3 tab UI
      main.js  ~7768 dòng logic
      styles.css  ~3523 dòng dark purple
    Bridge Server
      server.js  Express :3030
      Claude  CLI / SDK
      ElevenLabs  REST
      Whisper  STT
    3 Tab tính năng
      CLAUDE  chat + actions
      VOICEGEN  TTS / SFX / Music
      AUTOCUT  cutsheet to timeline
    Hạ tầng
      pack.sh  build zip
      push.sh  build + GitHub
      bridge-app  .app macOS Swift
      update-gist.sh  auto-update channel
```

---

## 2. Kiến trúc dữ liệu

```mermaid
flowchart TD
    A[User trong Premiere Pro] -->|nhập prompt| B[UXP Plugin]
    B -->|XHR POST /chat SSE| C[Bridge Server :3030]
    C -->|CLI hoặc SDK| D[Claude AI<br/>claude-sonnet-4-6]
    D -->|SSE: text / tool_use / done| B
    B -->|parse block actions| E[ppExecuteAction dispatcher]
    E -->|lockedAccess + executeTransaction| F[ppro UXP API → Timeline]
    C -->|REST| G[ElevenLabs TTS/SFX/Music]
    C -->|CLI| H[Whisper STT]
    B -.localStorage + UXP data folder.-> I[(Settings / shortcuts)]
```

---

## 3. Ba Tab — chức năng cốt lõi

```mermaid
mindmap
  root((3 Tab))
    CLAUDE
      Bridge health check 15s + version gate
      Timeline context  event + 5s poll fingerprint
      SSE chat streaming
      Multimodal  attachedImages base64
      Actions parser
        get_timeline_info
        cutlist
        cut_clip / trim_clip / move_clip
        add_marker / add_subtitle
        set_volume
        voicegen_script / voicegen_sfx
      Custom shortcuts  localStorage
    VOICEGEN
      TTS  voice picker + model + lang
      SFX  duration + prompt_influence
      Music  length slider
      Clone Voice  3 bước progressive
      Design Voice
      2-variation toggle
      Audio player  div KHÔNG dùng audio tag
    AUTOCUT  SAC
      Cutsheet paste 3 cột
        preset thứ tự cột  6 hoán vị
        timecode parser
      AI parse cutsheet / parse image
      Bin fuzzy match  3-pass BFS
      Voiceover detect  audio dài nhất A1
      STT align  Whisper / Premiere transcript
      Pair boundary  MAX của S và V duration
      Run transaction  insert V1 + A1
      Block view + voice panel
```

---

## 4. Bridge Server — endpoints

```mermaid
mindmap
  root((Bridge :3030))
    Core
      GET /health
      POST /chat  SSE Claude
      POST /api/read-image
    VoiceGen
      POST /tts/generate
      POST /tts/voices / voice-preview
      POST /tts/duration / concat-from-sequence
      POST /tts/play / stop / move / reveal
      POST /sfx/generate
      POST /music/generate
      POST /voice/clone
      POST /voice/design/preview / save
    Autocut / SAC
      POST /transcribe  Whisper/Premiere
      POST /align
      POST /superautocut/parse-cutsheet
      POST /superautocut/parse-image
      POST /superautocut/normalize-script
      POST /superautocut/split-voice
      POST /superautocut/voice-align
      POST /superautocut/validate
      POST /superautocut/subtext
    Update system
      POST /plugin/check-update
      POST /plugin/update
```

---

## 5. State toàn cục & cross-tab

| Key | Type | Ghi chú |
|-----|------|---------|
| `BRIDGE_URL` | string | `http://localhost:3030` |
| `CLAUDE_MODEL` | string | `claude-sonnet-4-6` |
| `ANTHROPIC_KEY` | string | rỗng → CLI mode |
| `ELEVENLABS_KEY` | string | quản lý ở tab VoiceGen |
| `messages[]` | array | lịch sử chat |
| `timelineContext` | object | snapshot sequence |
| `attachedImages[]` | array | ảnh đính kèm base64 |
| `isStreaming` | bool | chặn gửi đồng thời |

**Cross-tab bridge (window globals):**
- Claude → Autocut: `window.AutocutSetRows(rows[])`, `window.AutocutPushRows()`
- Claude → VoiceGen: `window.VoiceGenPushScript(text, voiceId, auto)`, `window.VoiceGenPushSFX(text, auto)`
- VoiceGen → Claude: `window.VoiceGenGetVoices()`
- Settings → VoiceGen: `window.VoiceGenOnKeyChange()`

---

## 6. ⚠️ UXP Gotchas (luôn nhớ khi sửa UI)

- ❌ KHÔNG dùng `position:fixed`, `z-index`, `grid`, `new Audio()`.
- ✅ Scroll cần `flex:1` + `min-height:0` + `overflow` trên **INNER child**.
- ⚠️ Native `<input>`/`<select>` luôn vẽ đè → ẩn nền khi mở modal.
- ⚠️ Mọi Premiere API là **async**.
- ⚠️ UXP defer paint của CSS `order` (reflow ≠ repaint) → di chuyển DOM thật bằng `appendChild`, đừng đổi `style.order`.
- Media player: dùng UXP `uxp.storage` path + `HTMLMediaElement`, KHÔNG `new Audio()`.
- Bin traversal: `ppro.FolderItem.cast(item)` trả `null` cho clip/sequence → tránh loop; BFS guard `< 10000`.

> Chi tiết: memory `uxp-known-issues`.

---

## 7. Quy ước release / versioning

```mermaid
flowchart LR
    Edit[Sửa code] --> Bump[Bump plugin + bridge version]
    Bump --> Pack[pack.sh → zip + .ccx]
    Pack --> App[build-app.sh → .app]
    App --> Push[push.sh → GitHub release]
    Push --> Gist[update-gist.sh → auto-update channel]
```

- **Luôn bump** version plugin + bridge sau MỖI thay đổi (xem [[feedback_versioning]]).
- Compat gate: plugin hard-code `REQUIRED_BRIDGE` (hiện 1.5.2). TODO: đẩy từ Gist thay vì hard-code.
- ⚠️ Public release zip lộ key → nếu muốn shared ElevenLabs key phải chuyển repo **private**.

---

## 8. Bản đồ memory liên quan (đọc để đầy đủ)

- `project_sac_state` — versions + key API facts + lịch sử fix 4.2.x→4.4.x (memory chính).
- `uxp-known-issues` — toàn bộ gotcha UXP.
- `feedback_bridge_versioning` — quy trình release.
- `feedback_question_vs_implement` — user HỎI thì trả lời, đừng tự implement.
- `project_4b_multispeaker_gen` — multi-speaker voice (deferred).

---

## 9. Hướng phát triển tiếp (từ ROADMAP)

- **SAC:** re-time clip theo voice; chọn FPS sequence mới; dry-run preview + undo batch; bảng tổng hợp source lỗi + "bind tất cả".
- **VoiceGen:** usage/cost meter (token + chi phí); thêm provider/model.
- **Xuất:** SRT/phụ đề từ word-timestamp (đã có hạ tầng whisper align).
- **Update:** compat check 2 chiều plugin↔bridge từ Gist.

---

_Cập nhật note này khi kiến trúc đổi đáng kể. Mermaid `mindmap` + `flowchart` render trong Obsidian (bật Mermaid mặc định)._
