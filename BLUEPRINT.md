# Project Blueprint — Premiere Claude Plugin v4.0

> Generated from analysis of v3.0.10 source. Use as spec for full rebuild.

---

## 1. Core Features & Business Logic

### TAB 1 — CLAUDE
- Bridge health check (`XHR GET /health` every 15s) + version gate
- Timeline context: event-driven + 5s poll fallback via fingerprint cache  
  `(seq.name + videoTrackCount + audioTrackCount + clipCount)`
- Chat: SSE streaming via XHR, parse SSE types:  
  `text | tool_use | heartbeat | rate_limit | error | done`
- Multimodal messages: `attachedImages[]` with `{name, mediaType, base64, dataUrl}`
- Image attach: UXP file picker + drag/drop (4 fallback methods) + clipboard paste
- ` ```actions``` ` block parser → `ppExecuteAction()` dispatcher
- Premiere actions: `get_timeline_info | cutlist | cut_clip | add_marker | add_subtitle | set_volume | move_clip | trim_clip | voicegen_script | voicegen_sfx`
- Rate-limit bubble: real countdown from `resetAt` + "show raw event" fallback
- Settings: `bridgeUrl`, `claudeModel`, `anthropicKey` (API or CLI mode)  
  Persisted: `localStorage` PRIMARY + UXP data folder BACKUP
- Custom shortcuts: `localStorage` array `[{name, prompt}]`  
  Create (popup) + right-click to delete

### TAB 2 — VOICEGEN
- 3 sub-modes: `TTS | SFX | Music` (mode bar, shared right settings panel)
- TTS: voice picker (built-in list + custom voice_id + fetched voices), model select, language override, output format
- SFX: duration + prompt_influence + output format
- Music: length slider
- Shared: output folder (UXP file picker + reset) + filename
- 2-variation toggle → generate → play / import / reveal / use per variation
- Audio player: progress bar + time display (built with `div`, NOT `<audio>`)
- ElevenLabs API key: stored in Settings, previewed as `sk_5…xxxx`
- `window.VoiceGenGetVoices()` — exposed for Claude voice context injection
- `window.VoiceGenPushScript(text, voiceId, autoGenerate)` — cross-tab
- `window.VoiceGenPushSFX(text, autoGenerate)` — cross-tab
- `window.VoiceGenOnKeyChange()` — called when EL key changes

### TAB 3 — AUTOCUT
- Config: `sttBackend` (whisper|premiere), `sttLang`, `runMode`  
  `(parse_and_run | run_only | parse_only)`
- Manual Paste: 3-column textarea (text/time/source), fill-down,  
  timecode parser (`M:SS | MM:SS.s | H:MM:SS | decimal`)
- Cutlist: `rows [{source, sourceIn, sourceOut, script}]`, collapse/expand
- Run pipeline (6 steps with live status UI):
  1. `getActiveSequence` + `findVoiceoverClip` (auto=longest, or manual pick)
  2. `POST /transcribe` (whisper: audioPath | premiere: transcriptPath)
  3. `POST /align` (words[] + scriptLines[] → alignments[])
  4. `collectAllProjectItems` + `collectAllSequences` → fuzzy `scoreMatch`
  5. Compute pair boundaries (offset by `vo.timelineStart`)
  6. `executeTimelineBuild`:  
     `withTemporaryProjectItemInOut` → setIn/Out → `createInsertProjectItemAction`  
     → `runTxn(lockedAccess + executeTransaction)` → `addSubtitlesForPlacements`
- Voiceover picker: auto-populated from `scanAudioTracks`, manual override
- Sequence Audio diagnostic panel
- Missing sources panel
- Retry button (re-runs last target)
- `window.AutocutSetRows(rows)` — called by cutlist action from Claude tab

---

## 2. Data Flow & State

### Global State (shared across tabs)
| Key | Type | Notes |
|-----|------|-------|
| `BRIDGE_URL` | string | `"http://localhost:3030"` |
| `CLAUDE_MODEL` | string | `"claude-sonnet-4-6"` |
| `ANTHROPIC_KEY` | string | empty → CLI mode |
| `ELEVENLABS_KEY` | string | managed by VoiceGen tab |
| `messages[]` | array | chat history `[{role, content}]` |
| `timelineContext` | object | `{sequenceName, durationSec, clips[], ...}` |
| `attachedImages[]` | array | `[{name, mediaType, base64, dataUrl, size}]` |
| `isStreaming` | bool | blocks concurrent sends |

### Request Flow
```
User input
  → sendMessage()
  → XHR POST /chat {messages, timelineContext, model, apiKey?, voiceContext?}
  → Bridge (SSE stream)
  → text/tool_use/done events
  → renderMd() → chat bubbles
  → parseActions() → ppExecuteAction()
  → ppro UXP API (lockedAccess + executeTransaction)
```

### Cross-Tab Communication
| Caller | Target | Method |
|--------|--------|--------|
| Claude | Autocut | `window.AutocutSetRows(rows[])` |
| Claude | VoiceGen | `window.VoiceGenPushScript(text, voiceId, auto)` |
| Claude | VoiceGen | `window.VoiceGenPushSFX(text, auto)` |
| VoiceGen | Claude | `window.VoiceGenGetVoices()` |
| Settings | VoiceGen | `window.VoiceGenOnKeyChange()` |

### Settings Persistence
- Write: `localStorage.setItem` + `uxp.storage.localFileSystem` (data folder)
- Read: `localStorage` first (sync) → UXP file (async hydration, fills missing keys only)

---

## 3. Spectrum Replacement Mapping

| Raw HTML | Spectrum Component |
|----------|-------------------|
| Tab bar `.tab-btn ×3` | `<sp-tab-list>` + `<sp-tab>` + `<sp-tab-panel>` |
| `<button>` primary | `<sp-button variant="accent">` |
| `<button>` secondary | `<sp-button variant="secondary">` |
| `<button>` ghost/text | `<sp-action-button quiet>` |
| `.icon-btn` (⚙ ⟳ ✕) | `<sp-action-button quiet>` with icon |
| `<textarea id="message-input">` | `<sp-textarea>` (fixed height, **NO** `grows`) |
| `<textarea class="vg-script">` | `<sp-textarea>` (fixed height, **NO** `grows`) |
| `<textarea class="ac-manualColInput">` | `<sp-textarea>` (fixed height, **NO** `grows`) |
| `<textarea class="sp-prompt">` | `<sp-textarea>` (in shortcut popup) |
| `<input type="text">` | `<sp-textfield>` |
| `<input type="password">` | `<sp-textfield type="password">` |
| `<input type="number">` | `<sp-number-field min max step>` |
| `<select>` (model, stt, mode…) | `<sp-picker>` + `<sp-menu>` + `<sp-menu-item>` |
| `<input type="checkbox">` | `<sp-checkbox>` |
| `.vg-switch` (custom toggle) | `<sp-switch>` |
| `#settings-box` (floating panel) | keep as `position:absolute` div (or `<sp-popover>`) |
| `.vg-progressWrap` (audio scrubber) | keep custom div (JS scrubbing needed) |
| `#status-dot` | keep custom (no Spectrum equivalent) |
| `.vg-voiceDrop` (voice dropdown) | keep custom (needs per-row preview buttons) |

---

## 4. Key Fixes — Implement from Day 1

### UXP Layout
- **NO** `position:fixed` — use `position:absolute` inside nearest `position:relative` ancestor
- **NO** `z-index` — DOM order = paint order; place floats **after** their siblings in HTML
- **NO** `display:grid` — use flexbox everywhere
- **NO** `window.innerWidth` — use `element.offsetWidth`
- **NO** `title="tooltip"` — UXP renders at wrong position, causes visual overlap
- Tab panels: `display:none` / `display:flex` (never `visibility:hidden`)
- `overflow:hidden` on non-scrolling panels; `overflow-y:auto` + `overscroll-behavior:contain` on scrolling ones

### sp-textarea
- **NEVER** use `grows` attribute → causes UXP scroll hijack (parent panel scrolls instead)
- Set explicit `height` or `min-height`/`max-height` via host CSS only
- Shadow DOM: `background` / `color` / `border` / `font-*` **cannot** be set externally  
  Only `width`, `height`, `min-height`, `max-height`, `flex` apply to the host
- Add `wheel` event `stopPropagation` on every `sp-textarea` as safety net

### Keyboard Intercept
```js
// Apply to ALL textareas and inputs
el.addEventListener('focus', () => uxp.host.setKeyboardFocus(true));
el.addEventListener('blur',  () => uxp.host.setKeyboardFocus(false));
```
Without this: Premiere shortcuts (B/V/C/etc.) fire while typing in the plugin.

### Premiere API
- All ppro calls must be `async/await` (`getStart()`/`getEnd()` return Promises in 25.x)
- Normalize TickTime with helper:  
  `try .seconds → try .ticks/254016000000 → try getSeconds()`
- Track access: try `seq.trackGroup(MEDIATYPE_VIDEO)` first; fall back to `seq.getVideoTrack(i)`
- All timeline **writes**: `project.lockedAccess()` + `project.executeTransaction()`
- Clip insert: `SequenceEditor.createInsertProjectItemAction(item, tick, vTrack, aTrack, limitShift=true)`
- Always use `withTemporaryProjectItemInOut` pattern: save → set in/out → insert → restore
- `getActiveSequence()`: **never** fall back to `seqs[0]` — always `project.getActiveSequence()`

### Autocut Runtime
- All placement times must be `+= vo.timelineStart` (offset from timeline origin to VO start)
- Missing sources: show list and **stop** before execute — never partial-insert
- Subtitle insertion: `try/catch` gracefully if no caption track (log + skip, don't throw)

### Settings Persistence
- Always write to **both** `localStorage` AND `uxp.storage` (localFileSystem data folder)
- On load: `localStorage` first (sync), then UXP file (async — fills only missing keys)
