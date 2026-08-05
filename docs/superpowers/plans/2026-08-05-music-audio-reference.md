# Music Audio Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho tab Music upload 1 đoạn nhạc reference (chế độ Style / Extend) qua ElevenLabs Music v2, đồng thời nâng mọi gen music lên v2 (bỏ v1).

**Architecture:** Plugin gửi `file.nativePath` cho bridge; bridge upload file lên `/v1/music/upload` (multipart) lấy `song_id`, build `composition_plan` v2 rồi gọi `/v1/music`. Gen thường không reference dùng `{prompt, music_length_ms, model_id:'music_v2'}`.

**Tech Stack:** Node.js/Express (bridge, no test harness — verify bằng curl), UXP plugin (HTML/CSS/vanilla JS, verify bằng reload trong UXP Developer Tool).

**Verification note:** Dự án không có unit test. Mỗi task verify thủ công bằng lệnh curl (bridge) hoặc reload plugin + thao tác tay (UI). Bridge phải đang chạy: `cd bridge && node server.js`.

---

## File Structure

- `bridge/server.js` — thêm helper `elevenLabsUpload()` (multipart), sửa handler `/music/generate`.
- `plugin/index.html` — thêm khối markup "Nhạc reference" trong `data-mode="music"`.
- `plugin/styles.css` — style cho khối reference.
- `plugin/main.js` — file picker, state reference, gửi field mới tới `/music/generate`, clamp độ dài, đổi tên mặc định "AI BGM v1" -> "AI BGM".
- `plugin/manifest.json` + `plugin/main.js` (PLUGIN_VERSION) + `bridge/server.js` (BRIDGE_VERSION) — bump version.

---

## Task 1: Bridge — helper multipart `elevenLabsUpload`

**Files:**
- Modify: `bridge/server.js` (thêm hàm ngay sau `elevenLabsRequest`, kết thúc dòng ~964)

- [ ] **Step 1: Thêm hàm `elevenLabsUpload`**

Chèn sau hàm `elevenLabsRequest` (sau dòng 964). Không có lib `form-data` trong deps nên build multipart thủ công bằng Buffer:

```js
// Upload 1 file audio (multipart/form-data) tới ElevenLabs, trả JSON (có song_id).
function elevenLabsUpload(apiKey, filePath, extraFields) {
  apiKey = apiKey || ELEVENLABS_DEFAULT_KEY;
  return new Promise((resolve, reject) => {
    let fileBuf;
    try { fileBuf = fs.readFileSync(filePath); }
    catch (e) { return reject(new Error('Không đọc được file reference: ' + filePath + ' — ' + e.message)); }

    const https = require('https');
    const boundary = '----ElevenBoundary' + Date.now().toString(16);
    const CRLF = '\r\n';
    const fileName = path.basename(filePath);
    const parts = [];

    // Các field text phụ (nếu có)
    Object.keys(extraFields || {}).forEach(k => {
      parts.push(Buffer.from(
        '--' + boundary + CRLF +
        'Content-Disposition: form-data; name="' + k + '"' + CRLF + CRLF +
        String(extraFields[k]) + CRLF, 'utf8'));
    });

    // Field file
    parts.push(Buffer.from(
      '--' + boundary + CRLF +
      'Content-Disposition: form-data; name="file"; filename="' + fileName + '"' + CRLF +
      'Content-Type: application/octet-stream' + CRLF + CRLF, 'utf8'));
    parts.push(fileBuf);
    parts.push(Buffer.from(CRLF + '--' + boundary + '--' + CRLF, 'utf8'));

    const payload = Buffer.concat(parts);
    const url = new URL(ELEVENLABS_BASE + '/v1/music/upload');
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Accept': 'application/json',
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': payload.length,
      },
      rejectUnauthorized: true,
    };

    const req = https.request(opts, response => {
      const chunks = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (response.statusCode >= 200 && response.statusCode < 300) {
          try { resolve(JSON.parse(buf.toString('utf8'))); }
          catch (e) { reject(new Error('Upload bad JSON: ' + buf.toString('utf8').slice(0, 200))); }
        } else {
          reject(new Error('ElevenLabs upload HTTP ' + response.statusCode + ': ' + buf.toString('utf8').slice(0, 300)));
        }
      });
    });
    req.on('error', err => reject(new Error('ElevenLabs upload network: ' + err.message)));
    req.write(payload);
    req.end();
  });
}
```

- [ ] **Step 2: Kiểm tra cú pháp**

Run: `cd bridge && node -e "require('./server.js')" 2>&1 | head -5 || node --check server.js && echo SYNTAX_OK`
Expected: In `SYNTAX_OK` (hoặc server khởi động không lỗi cú pháp). Nếu server tự chạy, Ctrl+C.

- [ ] **Step 3: Commit**

```bash
git add bridge/server.js
git commit -m "feat(bridge): thêm elevenLabsUpload multipart cho /v1/music/upload

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Bridge — nâng `/music/generate` lên v2 + reference

**Files:**
- Modify: `bridge/server.js:1096-1118` (handler `/music/generate`)

- [ ] **Step 1: Thay toàn bộ body handler `/music/generate`**

Thay đoạn hiện tại (dòng 1096–1118) bằng:

```js
app.post('/music/generate', async (req, res) => {
  try {
    const {
      apiKey, prompt, lengthSec, filename, variations, outputDir,
      refPath, refMode, conditionStrength, refStartMs, refEndMs,
    } = req.body;
    if (!apiKey) throw new Error('apiKey required');

    const baseFilename = (filename && typeof filename === 'string')
      ? filename.replace(/\.mp3$/i, '')
      : ('bgm-' + Date.now());
    const numVariations = (variations === 2 || variations === '2') ? 2 : 1;

    let body;
    if (refPath && typeof refPath === 'string' && refPath.trim()) {
      // ── Reference mode (Music v2 composition plan) ──
      const upload = await elevenLabsUpload(apiKey, refPath.trim());
      const songId = upload && (upload.song_id || upload.songId);
      if (!songId) throw new Error('Upload không trả song_id: ' + JSON.stringify(upload).slice(0, 200));

      // Chunk EL: 3–120s. Clamp độ dài gen về [3, 120]s.
      const durMs = Math.min(120000, Math.max(3000, Math.round(Number(lengthSec || 10) * 1000)));
      // Range reference trong 0–30s.
      const rStart = Math.max(0, Math.round(Number(refStartMs || 0)));
      const rEnd = Math.min(30000, Math.max(rStart + 1000, Math.round(Number(refEndMs || 30000))));
      const range = { start_ms: rStart, end_ms: rEnd };
      const strength = ['low', 'medium', 'high'].includes(conditionStrength) ? conditionStrength : 'medium';

      let chunks;
      if (refMode === 'extend') {
        chunks = [
          { song_id: songId, range: range },
          { text: prompt || '', duration_ms: durMs },
        ];
      } else {
        // 'style' (mặc định)
        chunks = [{
          text: prompt || '',
          duration_ms: durMs,
          conditioning_ref: { song_id: songId, range: range },
          condition_strength: strength,
        }];
      }

      body = { model_id: 'music_v2', composition_plan: { chunks: chunks } };
      console.log('[music/generate] REF', refMode || 'style', '| song', songId, '| dur', durMs + 'ms', '| range', rStart + '-' + rEnd, outputDir ? '→ ' + outputDir : '→ temp');
    } else {
      // ── Prompt mode (Music v2) ──
      if (!prompt) throw new Error('prompt required');
      body = {
        prompt: prompt,
        music_length_ms: Math.round(Number(lengthSec || 10) * 1000),
        model_id: 'music_v2',
      };
      console.log('[music/generate]', prompt, '|', lengthSec + 's', '| variations:', numVariations, outputDir ? '→ ' + outputDir : '→ temp');
    }

    const out = await generateAndSave('music', apiKey, '/v1/music', body, baseFilename, numVariations, false, outputDir);
    res.json({ ok: true, variations: out.variations, saveDir: out.saveDir });
  } catch (err) {
    console.error('[music/generate]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});
```

- [ ] **Step 2: Khởi động bridge, verify prompt-mode v2**

Run (thay `YOUR_KEY`):
```bash
cd bridge && node server.js &   # để chạy nền, hoặc terminal riêng
sleep 2
curl -s -X POST http://localhost:3030/music/generate \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"YOUR_KEY","prompt":"calm lofi piano","lengthSec":8}' | head -c 400
```
Expected: JSON `{"ok":true,"variations":[...]}` và log bridge in `[music/generate] calm lofi piano | 8s`. File mp3 xuất hiện trong `~/Documents/11Lab temp/`.

- [ ] **Step 3: Verify reference-mode (Style)**

Chuẩn bị 1 file mp3 ngắn tại `/tmp/ref.mp3` (hoặc dùng file vừa gen ở Step 2, copy sang `/tmp/ref.mp3`).
```bash
cp ~/Documents/11Lab\ temp/*.mp3 /tmp/ref.mp3 2>/dev/null; ls -la /tmp/ref.mp3
curl -s -X POST http://localhost:3030/music/generate \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"YOUR_KEY","prompt":"same vibe, add drums","lengthSec":10,"refPath":"/tmp/ref.mp3","refMode":"style","conditionStrength":"high","refStartMs":0,"refEndMs":10000}' | head -c 400
```
Expected: JSON `{"ok":true,...}`, log in `[music/generate] REF style | song <id> | dur 10000ms | range 0-10000`. Nếu lỗi copyright thì bridge trả `{"ok":false,"error":"...copyright..."}` — vẫn coi là đường đi đúng (đổi file khác).

- [ ] **Step 4: Verify reference-mode (Extend)**

```bash
curl -s -X POST http://localhost:3030/music/generate \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"YOUR_KEY","prompt":"continue the melody","lengthSec":8,"refPath":"/tmp/ref.mp3","refMode":"extend","refStartMs":0,"refEndMs":8000}' | head -c 400
```
Expected: JSON `{"ok":true,...}`, log in `[music/generate] REF extend | song <id> ...`. Dừng bridge nền: `kill %1` (nếu chạy `&`).

- [ ] **Step 5: Commit**

```bash
git add bridge/server.js
git commit -m "feat(bridge): music v2 + audio reference (style/extend) trong /music/generate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Plugin — markup khối "Nhạc reference" (index.html)

**Files:**
- Modify: `plugin/index.html:493` (ngay sau khối `st-slideRow` độ dài, trước `</div>` đóng `data-mode="music"` ở dòng 494)

- [ ] **Step 1: Chèn markup reference**

Sau dòng 493 (`</div>` đóng `st-slideRow`), trước dòng 494, chèn:

```html
          <!-- ── Nhạc reference (Music v2) ── -->
          <div class="vg-musicRef">
            <div class="vg-musicRefHead">
              <span data-ic="audio" data-ic-size="12" data-ic-color="#ec4899"></span>
              <span class="vg-musicRefTitle">Nhạc reference</span>
            </div>
            <div id="vgMusicRefPickRow" class="vg-musicRefPick">
              <div id="vgMusicRefPickBtn" class="vg-organizeBtn" role="button">
                <span data-ic="folder_open" data-ic-size="13"></span> Chọn nhạc reference
              </div>
              <span id="vgMusicRefName" class="vg-musicRefName" hidden></span>
              <div id="vgMusicRefClear" class="vg-musicRefClear" role="button" hidden>
                <span data-ic="xmark" data-ic-size="12"></span>
              </div>
            </div>
            <div id="vgMusicRefCfg" class="vg-musicRefCfg" hidden>
              <div class="vg-musicRefModeRow">
                <div class="vg-musicRefMode is-active" data-refmode="style" role="button">Style</div>
                <div class="vg-musicRefMode" data-refmode="extend" role="button">Extend</div>
              </div>
              <div id="vgMusicRefStrengthRow" class="vg-musicRefStrengthRow">
                <span class="vg-musicRefLbl">Mức bám style</span>
                <div class="vg-musicRefStrength">
                  <div class="vg-musicRefStr" data-str="low" role="button">Nhẹ</div>
                  <div class="vg-musicRefStr is-active" data-str="medium" role="button">Vừa</div>
                  <div class="vg-musicRefStr" data-str="high" role="button">Mạnh</div>
                </div>
              </div>
              <div class="vg-musicRefRangeRow">
                <span class="vg-musicRefLbl">Đoạn reference (giây)</span>
                <input type="number" id="vgMusicRefStart" class="st-num" min="0" max="29" step="1" value="0" />
                <span class="vg-musicRefDash">–</span>
                <input type="number" id="vgMusicRefEnd" class="st-num" min="1" max="30" step="1" value="30" />
              </div>
              <div class="vg-musicRefHint">Bật reference: độ dài nhạc tối đa 120s.</div>
            </div>
          </div>
```

- [ ] **Step 2: Verify markup load (reload plugin)**

Trong UXP Developer Tool bấm **Reload** plugin. Mở tab **Music**. Expected: thấy dòng "Nhạc reference" + nút "Chọn nhạc reference" dưới slider Độ dài. Khối cấu hình (Style/Extend...) chưa hiện (đang `hidden`).

- [ ] **Step 3: Commit**

```bash
git add plugin/index.html
git commit -m "feat(plugin): markup khối Nhạc reference trong tab Music

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Plugin — CSS cho khối reference (styles.css)

**Files:**
- Modify: `plugin/styles.css` (thêm cuối file)

- [ ] **Step 1: Thêm CSS**

Thêm vào cuối `plugin/styles.css`. Theme dark purple, tránh các thứ UXP không hỗ trợ (`position:fixed`, `display:grid`, `gap` trên flex — dùng margin):

```css
/* ── Music audio reference ── */
.vg-musicRef { margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.06); }
.vg-musicRefHead { display: flex; align-items: center; margin-bottom: 6px; }
.vg-musicRefHead > span[data-ic] { margin-right: 6px; }
.vg-musicRefTitle { font-size: 11px; color: #cbb8e8; text-transform: uppercase; letter-spacing: 0.5px; }
.vg-musicRefPick { display: flex; align-items: center; }
.vg-musicRefName { margin-left: 8px; font-size: 11px; color: #b7a6d6; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vg-musicRefClear { margin-left: 6px; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; border-radius: 4px; cursor: pointer; color: #d08; }
.vg-musicRefClear:hover { background: rgba(236,72,153,0.15); }
.vg-musicRefCfg { margin-top: 8px; }
.vg-musicRefModeRow { display: flex; margin-bottom: 8px; }
.vg-musicRefMode { flex: 1 1 0; text-align: center; padding: 5px 0; font-size: 11px; color: #a08cc0; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); cursor: pointer; }
.vg-musicRefMode:first-child { border-top-left-radius: 5px; border-bottom-left-radius: 5px; }
.vg-musicRefMode:last-child { border-top-right-radius: 5px; border-bottom-right-radius: 5px; margin-left: -1px; }
.vg-musicRefMode.is-active { background: rgba(168,85,247,0.22); color: #e6d8ff; border-color: rgba(168,85,247,0.5); }
.vg-musicRefStrengthRow, .vg-musicRefRangeRow { display: flex; align-items: center; margin-bottom: 8px; }
.vg-musicRefLbl { font-size: 11px; color: #a08cc0; width: 120px; flex: 0 0 auto; }
.vg-musicRefStrength { display: flex; flex: 1 1 0; }
.vg-musicRefStr { flex: 1 1 0; text-align: center; padding: 4px 0; font-size: 10px; color: #a08cc0; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); cursor: pointer; }
.vg-musicRefStr.is-active { background: rgba(236,72,153,0.2); color: #ffd6ec; border-color: rgba(236,72,153,0.45); }
.vg-musicRefDash { margin: 0 6px; color: #a08cc0; }
.vg-musicRefRangeRow .st-num { width: 52px; }
.vg-musicRefHint { font-size: 10px; color: #8878a8; font-style: italic; }
```

- [ ] **Step 2: Verify style (reload)**

Reload plugin, tab Music. (Khối cfg vẫn hidden — sẽ test đầy đủ ở Task 5.) Expected: dòng "Nhạc reference" có gạch ngăn phía trên, nút bấm canh đúng, không vỡ layout.

- [ ] **Step 3: Commit**

```bash
git add plugin/styles.css
git commit -m "feat(plugin): style khối Nhạc reference

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Plugin — logic file picker + gửi field (main.js)

**Files:**
- Modify: `plugin/main.js:6695-6707` (nhánh `else if (currentMode === 'music')` trong hàm build payload)
- Modify: `plugin/main.js:7137` (default name "AI BGM v1" -> "AI BGM")
- Modify: `plugin/main.js` (thêm state + wiring; đặt trong khối init music, cạnh dòng ~8615 `var musicPrompt`)

- [ ] **Step 1: Thêm state + wiring reference (trong init Music)**

Trong hàm init (gần dòng 8615, sau block `var musicPrompt = $('vgMusicPrompt'); if (musicPrompt) {...}`), thêm:

```js
  // ── Music audio reference state + wiring ──
  var vgMusicRef = { path: '', name: '', mode: 'style', strength: 'medium' };
  window.__vgMusicRef = vgMusicRef; // để nhánh gen đọc

  var _mrPickBtn = $('vgMusicRefPickBtn');
  var _mrName    = $('vgMusicRefName');
  var _mrClear   = $('vgMusicRefClear');
  var _mrCfg     = $('vgMusicRefCfg');
  var _mrStrRow  = $('vgMusicRefStrengthRow');
  var _mrLenInput = $('vgMusicLength');

  function vgMusicRefApplyClamp() {
    // Bật reference: clamp độ dài <= 120s.
    if (vgMusicRef.path && _mrLenInput) {
      _mrLenInput.max = '120';
      if (parseFloat(_mrLenInput.value) > 120) {
        _mrLenInput.value = '120';
        if (_mrLenInput.dispatchEvent) _mrLenInput.dispatchEvent(new Event('input'));
      }
    } else if (_mrLenInput) {
      _mrLenInput.max = '300';
    }
  }

  function vgMusicRefRender() {
    var has = !!vgMusicRef.path;
    if (_mrName) { _mrName.hidden = !has; _mrName.textContent = vgMusicRef.name || ''; }
    if (_mrClear) _mrClear.hidden = !has;
    if (_mrCfg) _mrCfg.hidden = !has;
    if (_mrStrRow) _mrStrRow.style.display = (vgMusicRef.mode === 'style') ? 'flex' : 'none';
    vgMusicRefApplyClamp();
  }

  if (_mrPickBtn) _mrPickBtn.addEventListener('click', async function() {
    try {
      var fs = require('uxp').storage.localFileSystem;
      var file = await fs.getFileForOpening({
        types: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'],
      });
      if (!file) return; // user hủy
      if (!file.nativePath) { setStatus('File phải là file local (không phải cloud)', false); return; }
      vgMusicRef.path = file.nativePath;
      vgMusicRef.name = file.name || file.nativePath.split('/').pop();
      vgMusicRefRender();
    } catch (e) {
      setStatus('Không chọn được file: ' + e.message, false);
    }
  });

  if (_mrClear) _mrClear.addEventListener('click', function() {
    vgMusicRef.path = ''; vgMusicRef.name = '';
    vgMusicRefRender();
  });

  // Toggle Style / Extend
  Array.prototype.forEach.call(document.querySelectorAll('.vg-musicRefMode'), function(el) {
    el.addEventListener('click', function() {
      vgMusicRef.mode = el.getAttribute('data-refmode') || 'style';
      Array.prototype.forEach.call(document.querySelectorAll('.vg-musicRefMode'), function(x) {
        x.classList.toggle('is-active', x === el);
      });
      vgMusicRefRender();
    });
  });

  // Slider mức bám style
  Array.prototype.forEach.call(document.querySelectorAll('.vg-musicRefStr'), function(el) {
    el.addEventListener('click', function() {
      vgMusicRef.strength = el.getAttribute('data-str') || 'medium';
      Array.prototype.forEach.call(document.querySelectorAll('.vg-musicRefStr'), function(x) {
        x.classList.toggle('is-active', x === el);
      });
    });
  });
```

- [ ] **Step 2: Gửi field reference trong nhánh gen music**

Sửa nhánh `else if (currentMode === 'music')` (dòng 6695–6707). Thay đoạn:

```js
    } else if (currentMode === 'music') {
      var prompt = safeVal($('vgMusicPrompt'));
      if (!prompt) return setStatus('Music prompt is empty', false);
```
thành (cho phép prompt rỗng khi có reference) và bổ sung field ref vào `payload`. Đoạn mới đầy đủ:

```js
    } else if (currentMode === 'music') {
      var prompt = safeVal($('vgMusicPrompt'));
      var _mref = window.__vgMusicRef || { path: '' };
      if (!prompt && !_mref.path) return setStatus('Music prompt is empty', false);

      var customName = 'music' + (userSuffix ? '_' + userSuffix : '') + '_' + genTimestamp();
      endpoint = '/music/generate';
      payload = {
        prompt: prompt,
        lengthSec: parseFloat($('vgMusicLength').value),
      };
      if (_mref.path) {
        var _s = parseInt(($('vgMusicRefStart') || {}).value || '0', 10) || 0;
        var _e = parseInt(($('vgMusicRefEnd') || {}).value || '30', 10) || 30;
        payload.refPath = _mref.path;
        payload.refMode = _mref.mode || 'style';
        payload.conditionStrength = _mref.strength || 'medium';
        payload.refStartMs = Math.max(0, _s) * 1000;
        payload.refEndMs = Math.min(30, Math.max(_s + 1, _e)) * 1000;
      }
      label = 'music';
```

> Lưu ý: giữ nguyên các dòng sau `label = 'music';` như cũ (đóng nhánh). Chỉ thay từ đầu nhánh tới `label = 'music';`. Kiểm tra lại tên biến `customName`, `endpoint`, `payload`, `label` khớp với code xung quanh trước khi lưu.

- [ ] **Step 3: Đổi tên mặc định "AI BGM v1" -> "AI BGM"**

Sửa dòng 7137:
```js
    if (mode === 'music') return part || 'AI BGM';
```
Và dòng comment 800 (nếu có nhắc "AI BGM v1") không bắt buộc sửa — chỉ đổi chuỗi chức năng ở 7137.

- [ ] **Step 4: Verify UI đầy đủ (reload + thao tác)**

Reload plugin. Bridge đang chạy. Tab Music:
1. Bấm "Chọn nhạc reference" -> chọn 1 file mp3 local. Expected: hiện tên file + nút ✕, khối cfg (Style/Extend, mức bám, range) hiện ra, ô Độ dài max về 120.
2. Bấm Extend -> hàng "Mức bám style" ẩn. Bấm lại Style -> hiện lại.
3. Bấm ✕ -> reset, khối cfg ẩn, max độ dài về 300.
4. Chọn lại file, để Style, nhập prompt, bấm **GENERATE MUSIC**. Expected: gen thành công, log bridge in `[music/generate] REF style ...`, audio xuất hiện để import.
5. Xóa reference, chỉ nhập prompt, GENERATE. Expected: log `[music/generate] <prompt> | Ns` (prompt-mode v2), gen OK.

- [ ] **Step 5: Commit**

```bash
git add plugin/main.js
git commit -m "feat(plugin): file picker + gửi field reference cho music; tên mặc định AI BGM

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Bump version (TEST PUMP — chưa release)

> Quy tắc: `a.b.c.d`. Đang test chưa approve release -> **chỉ pump segment `d`**. KHÔNG lên `5.3.0`/`1.12.0` (đó là bump release, để dành khi user duyệt release). KHÔNG tạo CCX/zip.

**Files:**
- Modify: `plugin/manifest.json:4`, `plugin/main.js:794` (PLUGIN_VERSION), `bridge/server.js:2585` (BRIDGE_VERSION)

- [ ] **Step 1: Test-pump plugin version**

`plugin/manifest.json` dòng 4: `"version": "5.2.4.1",`
`plugin/main.js` dòng 794: đổi `var PLUGIN_VERSION = 'v5.2.4.1';` và cập nhật ghi chú cuối dòng: `// (test) Music v2 + audio reference (Style/Extend): chọn file reference, mức bám style, range 0-30s; bỏ v1.`

> Nếu qua vài vòng test cần pump tiếp: 5.2.4.2, 5.2.4.3, ... Khi user duyệt release mới lên 5.3.0.

- [ ] **Step 2: Test-pump bridge version**

`bridge/server.js` dòng 2585: `const BRIDGE_VERSION = '1.11.6.1';` + cập nhật comment ngắn: `// (test) /music/generate: Music v2 mặc định + audio reference (upload -> composition_plan style/extend). Prior 1.11.6: ...`

- [ ] **Step 3: Verify version hiển thị**

Reload plugin. Expected: footer plugin hiện `v5.2.4.1`. Restart bridge rồi `curl -s http://localhost:3030/health` — endpoint version trả `1.11.6.1`.

- [ ] **Step 4: Commit**

```bash
git add plugin/manifest.json plugin/main.js bridge/server.js
git commit -m "chore(test): pump plugin 5.2.4.1 / bridge 1.11.6.1 (music v2 + audio reference)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage: upload helper (T1), v2 prompt-mode + style + extend + clamp (T2), UI markup (T3), CSS (T4), picker/state/gửi field/tên mặc định (T5), version (T6). Đủ.
- KHÔNG tạo CCX/zip (theo quy tắc versioning) — chỉ bump + commit. Release để user quyết.
- Không có test tự động; verify bằng curl + reload thủ công (đã ghi rõ mỗi task).
