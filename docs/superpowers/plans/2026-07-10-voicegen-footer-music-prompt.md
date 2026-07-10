# VoiceGen Footer + Bin theo mode + Music Prompt Builder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ghim thanh Generate xuống chân panel Voice Gen, làm chữ xám sáng lên, cho SFX/Music import vào bin riêng, và thêm modal dựng prompt nhạc qua AI.

**Architecture:** Ba thay đổi độc lập trên plugin UXP + một endpoint mới trên bridge Express. Footer ghim bằng cách tách khỏi vùng cuộn (UXP không có `position:sticky`). Bin đích suy từ `currentMode` qua một cầu nối `window.*` vì hàm bin là global còn `currentMode` nằm trong IIFE. Modal prompt gộp lựa chọn thành chuỗi tag, gửi qua `callLLM` sẵn có, và dùng chính chuỗi tag đó làm fallback khi AI hỏng.

**Tech Stack:** UXP (no ES modules, no `position:sticky`/`z-index`/`display:grid`), vanilla JS trong `plugin/main.js`, Express trong `bridge/server.js`, `callLLM()` (Gemini REST / Anthropic SDK / claude CLI).

**Spec:** `docs/superpowers/specs/2026-07-10-voicegen-footer-music-prompt-design.md`

---

## Bối cảnh bắt buộc phải đọc trước

**Không có test framework trong repo này.** Không có jest/mocha/pytest. Việc xác minh plugin là chạy thật trong Adobe Premiere Pro. Đừng đi tìm `npm test` — không có.

Với bridge (Node/Express) thì **có** thể test tự động bằng `curl`, và Task 3 làm đúng vậy: viết lệnh curl thất bại trước, rồi mới viết endpoint.

**Kiểm tra cú pháp sau mọi lần sửa JS:**

```bash
node --check plugin/main.js
node --check bridge/server.js
```

**Reload plugin:** trong UXP Developer Tool bấm "Reload" (không cần restart Premiere). Kiểm tra số version hiện đúng ở chân panel.

**Restart bridge sau khi sửa `bridge/server.js`:**

```bash
lsof -ti:3030 | xargs kill 2>/dev/null; sleep 1
cd /Users/crossian/Documents/GitHub/premiere-claude-plugin/bridge && node server.js &
sleep 2 && curl -s http://localhost:3030/health
```

**Ràng buộc UXP (vi phạm là hỏng im lặng, không báo lỗi):**
- Không `position:sticky`, không `z-index`, không `display:grid`
- Vùng cuộn phải là: `flex:1 1 0; min-height:0; overflow-y:auto` trên **inner child**
- `<button>` không render phần tử con → dùng `div role="button"`
- Không dùng thuộc tính `title=""`
- Mọi API Premiere đều async → phải `await`
- `data-ic="<tên>"` chỉ nhận key có trong `PI_ICONS` (`main.js:17`). Tên sai **không báo lỗi** —
  `main.js:56` lặng lẽ rơi về icon `file`. Các key hợp lệ đang dùng: `arrow_left`, `arrow_right`,
  `audio`, `bolt`, `check`, `chevron_down`, `closed_captioning`, `download`, `file`, `floppy_disk`,
  `folder`, `folder_open`, `gear`, `image`, `layer_group`, `microphone`, `microphone_lines`,
  `palette`, `play`, `plus`, `rotate_left`, `rotate_right`, `scissors`, `trash`, `video`,
  `wand_magic_sparkles`, `wave_square`, `xmark`. Không có `sliders`.

---

## File Structure

| File | Trách nhiệm | Task |
|---|---|---|
| `plugin/index.html` | Dời `.vg-genBar` ra ngoài vùng cuộn; dời checkbox bin sang Settings; thêm nút ⚙ + modal Music | 1, 2, 4 |
| `plugin/styles.css` | Style footer ghim, màu chữ trắng, style modal + chip | 1, 4 |
| `plugin/main.js` | Bin theo mode; logic modal + preset + gọi AI + fallback | 2, 5 |
| `bridge/server.js` | Endpoint `POST /music/prompt` | 3 |

---

## Task 1: Ghim footer + đổi chữ xám thành trắng

**Files:**
- Modify: `plugin/index.html:638-651`
- Modify: `plugin/styles.css:2347-2352` (`.vg-varToggle`), `plugin/styles.css:2711-2714` (`.vg-checkbox-row`)

Hiện `.vg-genBar` và `.vg-moveVoRow` nằm **trong** `.vg-leftScroll` (đóng ở dòng 651) nên bị cuộn khuất. Task này chỉ dời `.vg-genBar` ra ngoài. Checkbox `.vg-moveVoRow` sẽ bị Task 2 dời sang Settings, nên ở task này cứ để nguyên chỗ cũ.

- [ ] **Step 1: Dời `.vg-genBar` ra ngoài vùng cuộn**

Trong `plugin/index.html`, đoạn hiện tại:

```html
        <div class="vg-genBar">
          <label class="vg-varToggle">
            <input type="checkbox" id="vg2Variations" />
            <span>2 variations</span>
          </label>
          <div id="vgGenerate" class="vg-genButton" role="button"><span data-ic="bolt" data-ic-size="14" data-ic-color="#ffffff"></span> GENERATE VOICE</div>
        </div>

      </div><!-- /vg-leftScroll -->
      </div><!-- /vg-left -->
```

Đổi thành (chỉ đổi thứ tự đóng thẻ — genBar nhảy ra sau `/vg-leftScroll`):

```html
      </div><!-- /vg-leftScroll -->

        <div class="vg-genBar">
          <label class="vg-varToggle">
            <input type="checkbox" id="vg2Variations" />
            <span>2 variations</span>
          </label>
          <div id="vgGenerate" class="vg-genButton" role="button"><span data-ic="bolt" data-ic-size="14" data-ic-color="#ffffff"></span> GENERATE VOICE</div>
        </div>
      </div><!-- /vg-left -->
```

Giữ nguyên class `vg-genBar` — `main.js:6552` dùng `querySelector('.vg-genBar')` để ẩn nó ở mode `create`, và logic đó vẫn chạy đúng sau khi dời.

- [ ] **Step 2: Style footer ghim**

Trong `plugin/styles.css`, thay khối `.vg-genBar` hiện tại:

```css
.vg-genBar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  flex-shrink: 0;  /* never shrink — always visible above results */
}
```

bằng:

```css
/* Pinned footer — UXP has no position:sticky, so this must be a sibling of the
   scroll child (.vg-leftScroll) with flex:0 0 auto. Same pattern as .st-footer. */
.vg-genBar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 0 0;
  border-top: 1px solid rgba(255,255,255,0.08);
  background: var(--bg);
}
```

- [ ] **Step 3: Đổi chữ xám thành trắng**

Trong `plugin/styles.css`, `.vg-varToggle` đổi `color: var(--text-dim);` → `color: var(--text);`

```css
.vg-varToggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text);
  white-space: nowrap;
  cursor: pointer;
}
```

`.vg-checkbox-row` đổi `color: rgba(255,255,255,0.5);` → `color: var(--text);`

```css
.vg-checkbox-row {
  display: flex; align-items: center; gap: 6px;
  font-size: 10px; color: var(--text); cursor: pointer;
}
```

- [ ] **Step 4: Xác minh trong Premiere**

Reload plugin. Kiểm tra:
1. Mode Voice: nút GENERATE VOICE nằm sát đáy panel; cuộn nội dung dài → nút **không** trôi đi
2. Mode SFX: nhãn đổi thành GENERATE SFX, vẫn ghim đáy
3. Mode Music: nhãn GENERATE MUSIC, vẫn ghim đáy
4. Mode Create: footer **biến mất** hoàn toàn
5. Chữ "2 variations" sáng trắng, không còn xám mờ

Nếu footer không ghim mà vẫn cuộn: `.vg-left` chưa phải flex container dọc. Kiểm tra `.vg-left` có `display:flex; flex-direction:column;` chưa; nếu chưa thì thêm, và `.vg-leftScroll` phải có `flex:1 1 0; min-height:0; overflow-y:auto`.

- [ ] **Step 5: Commit**

```bash
node --check plugin/main.js
git add plugin/index.html plugin/styles.css
git commit -m "feat(voicegen): ghim thanh Generate xuống chân panel + chữ trắng"
```

---

## Task 2: Bin đích theo mode (Voice Over / SFX / BGM)

**Files:**
- Modify: `plugin/main.js:2620-2680` (`ppGetOrCreateVOBin`, `ppMoveToVOBin`)
- Modify: `plugin/main.js:5740` (khai báo `currentMode`) và `main.js:6544` (`switchMode`)
- Modify: `plugin/index.html:639-642` (dời checkbox), `plugin/index.html:753` (chèn vào Settings)

**Vấn đề scope phải hiểu trước khi code:** `ppMoveToVOBin()` là hàm **global** (`main.js:2645`). `currentMode` là biến **cục bộ** trong IIFE VoiceGen bắt đầu ở `main.js:5707`. Hàm global không đọc được biến trong IIFE. Phải bắc cầu qua `window`.

- [ ] **Step 1: Bắc cầu `currentMode` ra global**

Trong `plugin/main.js`, ngay sau dòng `var currentMode = 'tts'; // 'tts' | 'sfx' | 'music'` (khoảng dòng 5740), thêm:

```javascript
  // Bin đích cho import, theo mode đang chọn. ppMoveToBin() là hàm global nên không
  // đọc được `currentMode` trong IIFE này — phải phơi ra qua window.
  var VG_BIN_BY_MODE = { tts: 'Voice Over', sfx: 'SFX', music: 'BGM' };
  window.vgTargetBinName = function () {
    return VG_BIN_BY_MODE[currentMode] || 'Voice Over';
  };
```

- [ ] **Step 2: Tham số hoá hàm tìm/tạo bin**

`ppGetOrCreateVOBin(proj)` hard-code tên bin ở **ba** chỗ: regex lúc tìm, chuỗi `'voice over'` lúc tạo, và regex lần nữa lúc rà lại sau khi tạo.

Trong `plugin/main.js`, thay **toàn bộ** phần từ comment `// Search direct children of root (1 level)` tới hết hàm:

```javascript
  // Search direct children of root (1 level)
  try {
    var children = await sacGetFolderChildren(root);
    for (var i = 0; i < children.length; i++) {
      var n = await sacGetItemName(children[i]);
      if (/^(voice\s*over|vo)$/i.test(n.trim())) return children[i];
    }
  } catch(e) {}

  // Not found — create "voice over" bin at root via Action + transaction
  try {
    var createAction = root.createBinAction('voice over', false);
    var r = proj.lockedAccess(function() {
      proj.executeTransaction(function(ca) { ca.addAction(createAction); }, 'Create VO bin');
    });
    if (r && typeof r.then === 'function') await r;
    // Re-scan to find the newly created bin
    var children2 = await sacGetFolderChildren(root);
    for (var j = 0; j < children2.length; j++) {
      var n2 = await sacGetItemName(children2[j]);
      if (/^(voice\s*over|vo)$/i.test(n2.trim())) return children2[j];
    }
  } catch(e) { console.warn('[ppVO] createBin failed:', e.message); }
  return null;
}
```

bằng:

```javascript
  // So khớp tên bin. Bin "Voice Over" cũ có thể đang mang tên "VO" — vẫn nhận,
  // nếu không mỗi project cũ sẽ mọc thêm một bin trùng vai.
  function binMatches(name) {
    var n = String(name || '').trim().toLowerCase();
    var want = String(binName || 'Voice Over').trim().toLowerCase();
    if (n === want) return true;
    return (want === 'voice over' && /^(voice\s*over|vo)$/.test(n));
  }

  // Search direct children of root (1 level)
  try {
    var children = await sacGetFolderChildren(root);
    for (var i = 0; i < children.length; i++) {
      if (binMatches(await sacGetItemName(children[i]))) return children[i];
    }
  } catch(e) {}

  // Not found — create the bin at root via Action + transaction
  try {
    var createAction = root.createBinAction(binName, false);
    var r = proj.lockedAccess(function() {
      proj.executeTransaction(function(ca) { ca.addAction(createAction); }, 'Create bin');
    });
    if (r && typeof r.then === 'function') await r;
    // Re-scan to find the newly created bin
    var children2 = await sacGetFolderChildren(root);
    for (var j = 0; j < children2.length; j++) {
      if (binMatches(await sacGetItemName(children2[j]))) return children2[j];
    }
  } catch(e) { console.warn('[ppVO] createBin failed:', e.message); }
  return null;
}
```

Và đổi dòng khai báo hàm (ngay trên `if (!proj) return null;`) từ:

```javascript
async function ppGetOrCreateVOBin(proj) {
```

thành:

```javascript
async function ppGetOrCreateBin(proj, binName) {
  binName = binName || 'Voice Over';
```

- [ ] **Step 3: Tham số hoá hàm move**

Đổi `ppMoveToVOBin(item, proj)` thành `ppMoveToBin(item, proj, binName)`:

```javascript
// Move a ProjectItem into a bin by name (find or create it).
async function ppMoveToBin(item, proj, binName) {
  if (!item || !proj) return;
  binName = binName || (window.vgTargetBinName ? window.vgTargetBinName() : 'Voice Over');
  try {
    var binRaw = await ppGetOrCreateBin(proj, binName);
    if (!binRaw) return;

    // Must cast to FolderItem — createMoveItemAction only exists on FolderItem, not ProjectItem
    var bin = (ppro && ppro.FolderItem) ? ppro.FolderItem.cast(binRaw) : binRaw;
    if (!bin) { console.warn('[ppVO] FolderItem.cast returned null'); return; }

    if (typeof bin.createMoveItemAction !== 'function') {
      console.warn('[ppVO] createMoveItemAction still not found after cast');
      return;
    }

    var action = bin.createMoveItemAction(item, bin);
    var rs = proj.lockedAccess(function() {
      proj.executeTransaction(function(ca) { ca.addAction(action); }, 'Move to bin');
    });
    if (rs && typeof rs.then === 'function') await rs;
    console.log('[ppVO] Moved to bin "' + binName + '"');
  } catch(e) { console.warn('[ppVO] ppMoveToBin failed:', e.message); }
}
```

- [ ] **Step 4: Cập nhật 4 call site**

Giữ nguyên tên `ppShouldMoveToVOBin` và `ppMoveToVOBinIfEnabled` để không phải sửa hết nơi gọi. Chỉ đổi ruột:

```javascript
// Single source of truth for the "move to bin" toggle. Every import path must gate
// the bin move through this so the checkbox is always honored.
function ppShouldMoveToVOBin() {
  var cb = document.getElementById('vgMoveToVOBin');
  return !!(cb && cb.checked);
}
// Move only when the toggle is on. Bin đích lấy theo mode đang chọn.
async function ppMoveToVOBinIfEnabled(item, proj) {
  if (!ppShouldMoveToVOBin()) return;
  await ppMoveToBin(item, proj, window.vgTargetBinName ? window.vgTargetBinName() : 'Voice Over');
}
```

Còn **một** call site gọi thẳng `ppMoveToVOBin` ở `main.js:6810`:

```javascript
            if (voItem2) await ppMoveToVOBin(voItem2.item, project);
```

Đổi thành:

```javascript
            if (voItem2) await ppMoveToBin(voItem2.item, project, window.vgTargetBinName());
```

Sau khi sửa, kiểm tra không còn tham chiếu nào tới tên cũ:

```bash
grep -n "ppMoveToVOBin\b\|ppGetOrCreateVOBin" plugin/main.js
```

Kết quả mong đợi: chỉ còn `ppMoveToVOBinIfEnabled` (tên khác, không trùng do có `\b`). Nếu còn `ppMoveToVOBin(` hoặc `ppGetOrCreateVOBin(` thì sửa nốt.

- [ ] **Step 5: Dời checkbox sang Settings**

Trong `plugin/index.html`, **xoá** khối này khỏi cột trái:

```html
        <label class="vg-checkbox-row vg-moveVoRow">
          <input type="checkbox" id="vgMoveToVOBin" checked>
          <span>Move to "Voice Over" bin after import/autocut</span>
        </label>
```

Rồi chèn vào panel Settings, ngay **trước** dòng `</div><!-- /vg-rightScroll -->`. Đặt ngoài mọi `.vg-modeContent` để nó hiện ở cả ba mode:

```html
        <!-- Global (ngoài mọi mode) — bin đích đổi theo mode đang chọn -->
        <div class="vg-sg">
          <label class="vg-checkbox-row vg-moveVoRow">
            <input type="checkbox" id="vgMoveToVOBin" checked>
            <span>Chuyển vào bin sau khi import</span>
          </label>
          <div class="setting-hint-inline">
            Voice → bin "Voice Over" · SFX → bin "SFX" · Music → bin "BGM". Bin tự tạo nếu chưa có.
          </div>
        </div>
```

- [ ] **Step 6: Xác minh trong Premiere**

`node --check plugin/main.js`, reload plugin. Với mỗi mode, gen một file ngắn rồi import:

1. Mode Voice + tick checkbox → clip vào bin `Voice Over`
2. Mode SFX + tick → clip vào bin `SFX` (bin được tạo mới nếu chưa có)
3. Mode Music + tick → clip vào bin `BGM`
4. Bỏ tick → clip nằm ở gốc Project panel, **không** vào bin nào
5. Project đã có sẵn bin tên `VO` → mode Voice vẫn dùng lại bin đó, không tạo thêm

Xem Console của UXP Developer Tool, phải thấy `[ppVO] Moved to bin "SFX"` v.v.

- [ ] **Step 7: Commit**

```bash
node --check plugin/main.js
git add plugin/index.html plugin/main.js
git commit -m "feat(voicegen): bin đích theo mode (Voice Over/SFX/BGM) + dời checkbox sang Settings"
```

---

## Task 3: Bridge endpoint `POST /music/prompt`

**Files:**
- Modify: `bridge/server.js` (thêm endpoint trước `// ── GET /health`, cạnh `/sac/log`)
- Modify: `bridge/server.js:2327` (`BRIDGE_VERSION`)

Endpoint này test được tự động bằng `curl`, nên làm theo lối test-trước.

- [ ] **Step 1: Viết lệnh test, chạy để thấy nó FAIL**

```bash
curl -s -X POST http://localhost:3030/music/prompt \
  -H 'Content-Type: application/json' \
  -d '{"tags":"Lo-fi, Chillhop, Nostalgic, Rhodes piano, Mid-tempo, 90-110 BPM, Vinyl crackle, Instrumental"}'
```

Kết quả mong đợi lúc này: HTML lỗi 404 của Express (`Cannot POST /music/prompt`). Đó là FAIL đúng như dự kiến.

- [ ] **Step 2: Viết endpoint**

Trong `bridge/server.js`, chèn ngay **trước** dòng `// ── GET /health`:

```javascript
// ── POST /music/prompt ─────────────────────────────────────────────────────
// Dựng prompt nhạc từ các tag người dùng chọn trong modal. Trả về văn xuôi ngắn
// cho Suno/Udio. Plugin tự fallback về chính chuỗi `tags` nếu endpoint này lỗi.
app.post('/music/prompt', async (req, res) => {
  try {
    const { tags, freeText, provider, model, apiKey } = req.body || {};
    if (!tags || !String(tags).trim()) throw new Error('Cần ít nhất một lựa chọn');

    const sys = [
      'You write prompts for AI music generators (Suno, Udio).',
      'Turn the tag list below into ONE vivid English prompt, max 2 sentences, under 300 characters.',
      'Keep every musical attribute from the tags. Do not add vocals unless the tags say so.',
      'Do not name real artists, bands, or songs.',
      'Output the prompt text only — no quotes, no preamble, no explanation.',
      '',
      'Tags: ' + String(tags).trim(),
    ];
    if (freeText && String(freeText).trim()) {
      sys.push('Extra direction from the user: ' + String(freeText).trim());
    }

    const prompt = await callLLM(sys.join('\n'), { provider, model, apiKey, maxTokens: 300 });
    if (!prompt || !prompt.trim()) throw new Error('AI trả về rỗng');
    console.log('[music/prompt] ' + prompt.slice(0, 80));
    res.json({ ok: true, prompt: prompt.trim() });
  } catch (e) {
    console.error('[music/prompt]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
```

- [ ] **Step 3: Bump `BRIDGE_VERSION`**

Endpoint mới = đổi API. Trong `bridge/server.js` sửa dòng `const BRIDGE_VERSION = '1.10.0';` thành:

```javascript
const BRIDGE_VERSION = '1.11.0';  // + POST /music/prompt (AI dựng prompt nhạc từ tag). Prior 1.10.0: POST /sac/log
```

- [ ] **Step 4: Restart bridge, chạy lại test — phải PASS**

```bash
node --check bridge/server.js
lsof -ti:3030 | xargs kill 2>/dev/null; sleep 1
cd /Users/crossian/Documents/GitHub/premiere-claude-plugin/bridge && node server.js > /tmp/bridge-out.log 2>&1 &
sleep 2
curl -s http://localhost:3030/health | head -c 60   # phải thấy "version":"1.11.0"
curl -s -X POST http://localhost:3030/music/prompt \
  -H 'Content-Type: application/json' \
  -d '{"tags":"Lo-fi, Chillhop, Nostalgic, Rhodes piano, Mid-tempo, 90-110 BPM, Vinyl crackle, Instrumental"}'
```

Kết quả mong đợi: `{"ok":true,"prompt":"..."}` với một câu tiếng Anh mô tả nhạc lo-fi.

- [ ] **Step 5: Test nhánh lỗi (tags rỗng)**

```bash
curl -s -X POST http://localhost:3030/music/prompt \
  -H 'Content-Type: application/json' -d '{"tags":""}'
```

Kết quả mong đợi: `{"ok":false,"error":"Cần ít nhất một lựa chọn"}` kèm HTTP 500.

- [ ] **Step 6: Commit**

```bash
git add bridge/server.js
git commit -m "feat(bridge): POST /music/prompt — AI dựng prompt nhạc từ tag (API 1.11.0)"
```

---

## Task 4: Modal Music prompt builder — HTML + CSS

**Files:**
- Modify: `plugin/index.html:479-497` (thêm nút ⚙ vào mode music)
- Modify: `plugin/index.html` (thêm modal cuối file, cạnh `sacBindModal`)
- Modify: `plugin/styles.css` (thêm style modal + chip)

- [ ] **Step 1: Thêm nút mở modal vào mode Music**

Trong `plugin/index.html`, khối `data-mode="music"` hiện có `.vg-editorFoot` chỉ chứa char count:

```html
            <div class="vg-editorFoot">
              <span class="vg-charCount" id="vgMusicCharCount">0 / 1000</span>
            </div>
```

Đổi thành (thêm nút bên phải; UXP không render con trong `<button>` nên dùng `div role="button"`):

```html
            <div class="vg-editorFoot">
              <span class="vg-charCount" id="vgMusicCharCount">0 / 1000</span>
              <div id="vgMusicBuilderBtn" class="vg-organizeBtn" role="button"><span data-ic="gear" data-ic-size="13"></span> Chi tiết đoạn nhạc</div>
            </div>
```

- [ ] **Step 2: Thêm modal**

Chèn vào `plugin/index.html` ngay trước thẻ đóng `</body>`, cạnh các modal khác:

```html
  <!-- ── Music prompt builder ── -->
  <div id="vgMusicModal" class="sac-bind-modal" hidden>
    <div class="sac-bind-box">
      <div class="sac-bind-head">
        <span class="sac-bind-title">Chi tiết đoạn nhạc</span>
        <div id="vgMusicClose" class="sac-bind-close" role="button"><span data-ic="xmark" data-ic-size="14"></span></div>
      </div>

      <div class="vgm-scroll">
        <div class="vgm-group" data-group="genres">
          <div class="vgm-groupHead">Thể loại <span class="vgm-limit">chọn tối đa 2</span></div>
          <div class="vgm-chips" id="vgmGenres"></div>
        </div>
        <div class="vgm-group" data-group="moods">
          <div class="vgm-groupHead">Cảm xúc <span class="vgm-limit">chọn tối đa 2</span></div>
          <div class="vgm-chips" id="vgmMoods"></div>
        </div>
        <div class="vgm-group" data-group="instruments">
          <div class="vgm-groupHead">Nhạc cụ <span class="vgm-limit">chọn thoải mái</span></div>
          <div class="vgm-chips" id="vgmInstruments"></div>
        </div>
        <div class="vgm-group" data-group="tempo">
          <div class="vgm-groupHead">Nhịp độ <span class="vgm-limit">chọn 1</span></div>
          <div class="vgm-chips" id="vgmTempo"></div>
        </div>
        <div class="vgm-group" data-group="vibe">
          <div class="vgm-groupHead">Không gian âm thanh <span class="vgm-limit">chọn 1</span></div>
          <div class="vgm-chips" id="vgmVibe"></div>
        </div>
        <div class="vgm-group">
          <label class="vg-checkbox-row">
            <input type="checkbox" id="vgmVocals">
            <span>Có giọng hát (mặc định tắt = nhạc không lời)</span>
          </label>
        </div>
        <div class="vgm-group">
          <div class="vgm-groupHead">Mô tả thêm <span class="vgm-limit">tuỳ chọn</span></div>
          <textarea id="vgmFreeText" class="vgm-free" spellcheck="false"
            placeholder="vd: nhạc nền cho cảnh mở hộp sản phẩm, xây dựng cao trào ở giây thứ 8"></textarea>
        </div>
      </div>

      <div class="vgm-preview" id="vgmPreview"></div>
      <div class="vgm-status" id="vgmStatus" hidden></div>

      <div class="vgm-foot">
        <select id="vgmPresetSel" class="sac-nsf2-select"><option value="">— Preset —</option></select>
        <div id="vgmPresetSave" class="sac-nsf2-iconBtn" role="button"><span data-ic="floppy_disk" data-ic-size="14"></span></div>
        <div id="vgmPresetDel" class="sac-nsf2-iconBtn" role="button"><span data-ic="trash" data-ic-size="14"></span></div>
        <div id="vgmReset" class="btn-secondary" role="button">Xoá chọn</div>
        <div id="vgmBuild" class="btn-primary" role="button"><span data-ic="wand_magic_sparkles" data-ic-size="13" data-ic-color="#ffffff"></span> Tạo prompt</div>
      </div>
    </div>
  </div>
```

- [ ] **Step 3: Style modal**

Thêm vào cuối `plugin/styles.css`. Dùng `flex-wrap`, **không** `display:grid` (UXP không hỗ trợ):

```css
/* ── Music prompt builder ─────────────────────────────────────────────────── */
.vgm-scroll {
  flex: 1 1 0; min-height: 0; overflow-y: auto;
  padding: 4px 2px;
}
.vgm-group { margin-bottom: 16px; }
.vgm-groupHead {
  font-size: 11px; font-weight: 700; color: var(--text);
  margin-bottom: 7px;
}
.vgm-limit {
  font-size: 10px; font-weight: 400; color: var(--text-dim);
  margin-left: 6px;
}
.vgm-chips { display: flex; flex-wrap: wrap; }
.vgm-chip {
  font-size: 10px; color: var(--text);
  background: rgba(255,255,255,0.05);
  border: 1px solid var(--border);
  border-radius: 11px;
  padding: 3px 9px;
  margin: 0 5px 5px 0;
  cursor: pointer;
}
.vgm-chip.is-on {
  background: var(--accent);
  color: var(--accent-fg);
  border-color: var(--accent);
}
.vgm-chip.is-blocked { opacity: 0.35; cursor: default; }
.vgm-free {
  width: 100%; height: 48px; resize: none;
  background: rgba(0,0,0,0.3);
  border: 1px solid var(--border);
  border-radius: 5px;
  color: var(--text); font-size: 11px; padding: 6px 8px;
}
.vgm-preview {
  flex: 0 0 auto;
  font-size: 10px; color: var(--text-dim);
  border-top: 1px solid rgba(255,255,255,0.08);
  padding: 8px 2px 0;
  margin-top: 4px;
  word-break: break-word;
}
.vgm-status { flex: 0 0 auto; font-size: 10px; padding: 6px 2px 0; }
.vgm-status.is-warn { color: #fbbf24; }
.vgm-status.is-err  { color: #f87171; }
.vgm-foot {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 6px;
  padding-top: 10px;
}
.vgm-foot .btn-primary { margin-left: auto; }
```

- [ ] **Step 4: Xác minh hiển thị**

Reload plugin. Sang mode Music, bấm "Chi tiết đoạn nhạc". Modal phải mở, các nhóm hiện tiêu đề (chip còn trống vì Task 5 mới đổ dữ liệu). Bấm ✕ đóng được.

Nếu modal không hiện: kiểm tra `.sac-bind-modal` có dùng `position:fixed` không — UXP không hỗ trợ. Copy đúng cách định vị mà `sacBindModal` đang dùng.

- [ ] **Step 5: Commit**

```bash
git add plugin/index.html plugin/styles.css
git commit -m "feat(voicegen): khung modal Music prompt builder"
```

---

## Task 5: Logic modal — taxonomy, chọn, preset, gọi AI, fallback

**Files:**
- Modify: `plugin/main.js` (thêm module vào trong IIFE VoiceGen, trước dòng đóng `})();` ở khoảng `main.js:6970`)

- [ ] **Step 1: Thêm taxonomy + hàm dựng chuỗi tag**

Chèn vào trong IIFE VoiceGen (nơi `currentMode` nhìn thấy được):

```javascript
  // ── Music prompt builder ──────────────────────────────────────────────────
  // Nhóm nào loại trừ nhau thì max 1; nhóm nào cộng dồn được thì không giới hạn.
  // Tempo gom thành 4 dải: JSON gốc trộn từ đồng nghĩa với khoảng BPM vào một mảng
  // phẳng, cho phép chọn "Slow tempo" + "150+ BPM" cùng lúc.
  var VGM_TAX = {
    genres: { max: 2, items: [
      'Synthpop','Electropop','K-pop','J-pop','Indie Pop','Bubblegum pop',
      'Alternative Rock','Hard Rock','Classic Rock','Heavy Metal','Punk Rock','Grunge',
      'House','Deep House','Future Bass','Techno','Dubstep','Trance','Slap House',
      'Hip-hop','Boom Bap','Trap','R&B','Neo-Soul','Contemporary R&B',
      'Cinematic','Orchestral','Neo-classical','Symphonic','Ambient',
      'Lo-fi','Chillhop','Jazz','Bossa Nova','Blues','Folk','Acoustic',
      'Synthwave','Cyberpunk','City Pop','80s pop','90s grunge',
    ] },
    moods: { max: 2, items: [
      'Uplifting','Energetic','Happy','Bright','Cheerful','Joyful','Optimistic',
      'Euphoric','Hype','Aggressive','Anthemic','Powerful','Explosive',
      'Melancholic','Sad','Nostalgic','Somber','Heartbroken','Bittersweet',
      'Chill','Relaxed','Dreamy','Atmospheric','Calm','Peaceful','Mellow',
      'Dark','Eerie','Suspenseful','Mysterious','Gothic','Haunting','Epic',
    ] },
    instruments: { max: 0, items: [
      'Acoustic guitar','Classical guitar','Ukulele','Harp',
      'Electric guitar','Distorted guitar','Synthesizer','Keytar',
      'Grand piano','Rhodes piano','Violin','Cello','String quartet',
      'Saxophone','Trumpet','Flute','Brass section',
      'Heavy drums','Acoustic drums','808 bass','Sub-bass','Slap bass','Percussion',
    ] },
    tempo: { max: 1, items: [
      { label: 'Chậm',      tag: 'Slow tempo, 60-80 BPM' },
      { label: 'Vừa',       tag: 'Mid-tempo, 90-110 BPM' },
      { label: 'Nhanh',     tag: 'Fast tempo, 120-140 BPM' },
      { label: 'Rất nhanh', tag: 'Very fast, 150+ BPM' },
    ] },
    vibe: { max: 1, items: [
      'Heavy reverb','Echoing','Spacious','Arena sound',
      'Studio production','Live recording','Concert vibe',
      'Lo-fi vibe','Vinyl crackle','Cassette tape warmth',
      'Crystal clear','High fidelity','Polished','Modern production',
    ] },
  };
  var VGM_ORDER = ['genres', 'moods', 'instruments', 'tempo', 'vibe'];
  var VGM_DOM = { genres: 'vgmGenres', moods: 'vgmMoods', instruments: 'vgmInstruments',
                  tempo: 'vgmTempo', vibe: 'vgmVibe' };
  var vgmSel = { genres: [], moods: [], instruments: [], tempo: [], vibe: [] };

  function vgmItemTag(group, item) {
    return (typeof item === 'string') ? item : item.tag;
  }
  function vgmItemLabel(group, item) {
    return (typeof item === 'string') ? item : item.label;
  }
  // Chuỗi tag nối bằng dấu phẩy — vừa là đầu vào cho AI, vừa là fallback khi AI hỏng.
  function vgmBuildTags() {
    var parts = [];
    VGM_ORDER.forEach(function (g) { parts = parts.concat(vgmSel[g]); });
    var vocals = document.getElementById('vgmVocals');
    parts.push(vocals && vocals.checked ? 'With vocals' : 'Instrumental');
    return parts.join(', ');
  }
```

- [ ] **Step 2: Render chip + xử lý chọn có giới hạn**

```javascript
  function vgmRender() {
    VGM_ORDER.forEach(function (g) {
      var host = document.getElementById(VGM_DOM[g]);
      if (!host) return;
      host.textContent = '';
      var max = VGM_TAX[g].max;
      VGM_TAX[g].items.forEach(function (item) {
        var tag = vgmItemTag(g, item);
        var on  = vgmSel[g].indexOf(tag) >= 0;
        var full = (max > 0 && vgmSel[g].length >= max && !on);
        var chip = document.createElement('div');
        chip.className = 'vgm-chip' + (on ? ' is-on' : '') + (full ? ' is-blocked' : '');
        chip.setAttribute('role', 'button');
        chip.textContent = vgmItemLabel(g, item);
        chip.addEventListener('click', function () { vgmToggle(g, tag); });
        host.appendChild(chip);
      });
    });
    var prev = document.getElementById('vgmPreview');
    if (prev) prev.textContent = vgmBuildTags();
  }

  function vgmToggle(group, tag) {
    var arr = vgmSel[group];
    var i = arr.indexOf(tag);
    var max = VGM_TAX[group].max;
    if (i >= 0) { arr.splice(i, 1); }
    else if (max === 1) { vgmSel[group] = [tag]; }        // radio
    else if (max === 0 || arr.length < max) { arr.push(tag); }
    else { return; }                                       // đã đầy → bỏ qua
    vgmRender();
  }
```

- [ ] **Step 3: Preset (localStorage)**

```javascript
  var VGM_PRESET_KEY = 'vg_music_presets';
  function vgmLoadPresets() {
    try { return JSON.parse(localStorage.getItem(VGM_PRESET_KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function vgmRefreshPresetSel() {
    var sel = document.getElementById('vgmPresetSel');
    if (!sel) return;
    var presets = vgmLoadPresets();
    sel.textContent = '';
    var opt0 = document.createElement('option');
    opt0.value = ''; opt0.textContent = '— Preset —';
    sel.appendChild(opt0);
    Object.keys(presets).forEach(function (name) {
      var o = document.createElement('option');
      o.value = name; o.textContent = name;
      sel.appendChild(o);
    });
  }
  function vgmApplyPreset(name) {
    var p = vgmLoadPresets()[name];
    if (!p) return;
    VGM_ORDER.forEach(function (g) { vgmSel[g] = (p.sel && p.sel[g]) ? p.sel[g].slice() : []; });
    var v = document.getElementById('vgmVocals');
    if (v) v.checked = !!p.vocals;
    var f = document.getElementById('vgmFreeText');
    if (f) f.value = p.freeText || '';
    vgmRender();
  }
```

- [ ] **Step 4: Gọi AI + fallback không im lặng**

```javascript
  function vgmStatus(msg, cls) {
    var el = document.getElementById('vgmStatus');
    if (!el) return;
    el.hidden = !msg;
    el.textContent = msg || '';
    el.className = 'vgm-status' + (cls ? ' ' + cls : '');
  }

  async function vgmBuildPrompt() {
    var tags = vgmBuildTags();
    // Chỉ có "Instrumental" nghĩa là chưa chọn gì.
    if (VGM_ORDER.every(function (g) { return vgmSel[g].length === 0; })) {
      vgmStatus('Chọn ít nhất một mục trước khi tạo prompt.', 'is-err');
      return;
    }
    var freeEl = document.getElementById('vgmFreeText');
    var freeText = freeEl ? freeEl.value.trim() : '';
    var target = document.getElementById('vgMusicPrompt');
    var cfg = (window.sacOrganizeConfig ? window.sacOrganizeConfig() : {}) || {};

    vgmStatus('⏳ AI đang viết prompt...', '');
    try {
      var r = await fetch(BRIDGE_URL + '/music/prompt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: tags, freeText: freeText,
          provider: cfg.provider, model: cfg.model, apiKey: cfg.apiKey }),
      });
      var d = await r.json();
      if (!d || !d.ok) throw new Error((d && d.error) || 'Bridge lỗi');
      if (target) { target.value = d.prompt; target.dispatchEvent(new Event('input')); }
      vgmClose();
    } catch (e) {
      // KHÔNG thất bại im lặng: đổ chuỗi tag vào ô prompt và nói rõ vì sao.
      if (target) { target.value = tags; target.dispatchEvent(new Event('input')); }
      vgmStatus('⚠ AI không phản hồi (' + e.message + ') — đã dùng prompt ghép thẳng từ lựa chọn.', 'is-warn');
      console.warn('[vgm] AI prompt failed → fallback tags:', e.message);
    }
  }
```

- [ ] **Step 5: Mở/đóng modal + nối sự kiện**

```javascript
  function vgmOpen() {
    vgmStatus('', '');
    vgmRefreshPresetSel();
    vgmRender();
    var m = document.getElementById('vgMusicModal');
    if (m) m.hidden = false;
  }
  function vgmClose() {
    var m = document.getElementById('vgMusicModal');
    if (m) m.hidden = true;
  }

  (function vgmWire() {
    var btn = document.getElementById('vgMusicBuilderBtn');
    if (btn) btn.addEventListener('click', vgmOpen);
    var close = document.getElementById('vgMusicClose');
    if (close) close.addEventListener('click', vgmClose);
    var build = document.getElementById('vgmBuild');
    if (build) build.addEventListener('click', vgmBuildPrompt);

    var reset = document.getElementById('vgmReset');
    if (reset) reset.addEventListener('click', function () {
      VGM_ORDER.forEach(function (g) { vgmSel[g] = []; });
      var v = document.getElementById('vgmVocals'); if (v) v.checked = false;
      var f = document.getElementById('vgmFreeText'); if (f) f.value = '';
      vgmStatus('', ''); vgmRender();
    });

    var vocals = document.getElementById('vgmVocals');
    if (vocals) vocals.addEventListener('change', vgmRender);

    var sel = document.getElementById('vgmPresetSel');
    if (sel) sel.addEventListener('change', function () { if (sel.value) vgmApplyPreset(sel.value); });

    var save = document.getElementById('vgmPresetSave');
    if (save) save.addEventListener('click', function () {
      var name = String(window.prompt('Tên preset:') || '').trim();
      if (!name) return;
      var presets = vgmLoadPresets();
      var f = document.getElementById('vgmFreeText');
      var v = document.getElementById('vgmVocals');
      presets[name] = { sel: JSON.parse(JSON.stringify(vgmSel)),
                        vocals: !!(v && v.checked), freeText: f ? f.value : '' };
      localStorage.setItem(VGM_PRESET_KEY, JSON.stringify(presets));
      vgmRefreshPresetSel();
      document.getElementById('vgmPresetSel').value = name;
    });

    var del = document.getElementById('vgmPresetDel');
    if (del) del.addEventListener('click', function () {
      var s = document.getElementById('vgmPresetSel');
      if (!s || !s.value) return;
      var presets = vgmLoadPresets();
      delete presets[s.value];
      localStorage.setItem(VGM_PRESET_KEY, JSON.stringify(presets));
      vgmRefreshPresetSel();
    });
  })();
```

Lưu ý: `window.prompt()` có thể bị UXP chặn. Nếu Step 7 cho thấy nó không mở hộp nhập, thay bằng một `<input>` inline trong `.vgm-foot` (thêm `<input id="vgmPresetName" class="sac-nsf2-input" placeholder="tên preset">` rồi đọc `.value`).

- [ ] **Step 6: Kiểm tra cú pháp**

```bash
node --check plugin/main.js
```

Kết quả mong đợi: không in gì (thành công).

- [ ] **Step 7: Xác minh trong Premiere**

Reload plugin, sang mode Music, bấm "Chi tiết đoạn nhạc":

1. Chip hiện đủ 5 nhóm
2. Thể loại: chọn 2 → chip thứ 3 mờ đi, bấm không ăn. Bỏ 1 → chip sáng lại
3. Nhịp độ: chọn "Chậm" rồi bấm "Nhanh" → chỉ "Nhanh" sáng (radio)
4. Nhạc cụ: chọn 5 cái, không bị chặn
5. Dòng preview dưới đáy cập nhật theo mỗi lần bấm, luôn kết thúc bằng `Instrumental`
6. Tick "Có giọng hát" → preview đổi thành `With vocals`
7. Bấm "Tạo prompt" → modal đóng, ô prompt Music có văn xuôi tiếng Anh
8. **Test fallback:** tắt bridge (`lsof -ti:3030 | xargs kill`), bấm "Tạo prompt" → modal **không** đóng, hiện cảnh báo vàng, ô prompt Music chứa chuỗi tag. Bật bridge lại.
9. Lưu preset tên "lofi", bấm "Xoá chọn", chọn lại preset "lofi" từ dropdown → các chip sáng lại đúng
10. Reload plugin → preset "lofi" vẫn còn trong dropdown

- [ ] **Step 8: Commit**

```bash
node --check plugin/main.js
git add plugin/main.js
git commit -m "feat(voicegen): logic Music prompt builder — chip, preset, AI + fallback"
```

---

## Task 6: Bump version

**Files:**
- Modify: `plugin/manifest.json:4`
- Modify: `plugin/main.js:794`

Bridge đã bump ở Task 3 (`1.11.0`).

- [ ] **Step 1: Bump**

```bash
sed -i '' 's/"version": "4.10.1"/"version": "4.11.0"/' plugin/manifest.json
sed -i '' "s|var PLUGIN_VERSION = 'v4.10.1';.*|var PLUGIN_VERSION = 'v4.11.0';  // VoiceGen: ghim footer Generate + chữ trắng; bin theo mode (Voice Over/SFX/BGM); Music prompt builder (chip + preset + AI, fallback chuỗi tag). Bridge API 1.11.0|" plugin/main.js
node --check plugin/main.js
grep -n "PLUGIN_VERSION = " plugin/main.js | head -1
grep -n '"version"' plugin/manifest.json | head -1
```

Kết quả mong đợi: cả hai in ra `4.11.0`.

- [ ] **Step 2: Xác minh version hiện đúng**

Reload plugin. Chân panel phải hiện `v4.11.0 · Bridge 1.11.0`.

- [ ] **Step 3: Commit**

```bash
git add plugin/manifest.json plugin/main.js
git commit -m "chore: bump plugin v4.11.0 (bridge API 1.11.0)"
```

---

## Sau khi xong

**Không build, không release** cho tới khi user duyệt. Người dùng đã nói rõ điều này. Khi được duyệt thì theo checklist trong `CLAUDE.md`: `bridge-app/build-app.sh` → `gh release create` → `update-gist.sh`.

Instrumentation SAC (`sacLog`, `sacDumpTracks`, endpoint `/sac/log`) vẫn còn trong code từ đợt debug trước. Chưa quyết gỡ hay giữ sau cờ debug — hỏi user, đừng tự xoá.
