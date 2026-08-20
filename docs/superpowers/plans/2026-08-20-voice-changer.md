# Voice Changer (ElevenLabs STS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm tính năng đổi giọng (ElevenLabs Speech-to-Speech) làm card thứ 3 trong tab Create của plugin Voice Gen.

**Architecture:** Plugin (UXP) thu audio nguồn (clip đang chọn → gộp qua bridge, hoặc upload file) + giọng đích + settings → gọi endpoint bridge mới `POST /voice/change`. Bridge đọc file, dựng multipart POST tới ElevenLabs STS, lưu output rồi trả về `variations` đúng shape của `/tts/generate` để plugin tái dùng `renderVariations()` + flow Lưu/Import sẵn có.

**Tech Stack:** Node.js + Express (bridge, không thêm dependency — dùng `https`/`fs` core); UXP plugin JS non-module (`plugin/main.js`), HTML (`plugin/index.html`), CSS (`plugin/styles.css`). Spec: `docs/superpowers/specs/2026-08-20-voice-changer-design.md`.

## Global Constraints

- **Không thêm npm dependency** — bridge dùng `https`, `fs`, `path` core (như `elevenLabsMultipart` hiện có).
- **Plugin không dùng ES modules** — `main.js` là script thường, khai báo `var`/`function`, không `import`/`export`.
- **UXP cấm:** `position:fixed`, `z-index`, `display:grid`, `window.innerWidth`, thuộc tính `title=""`, `new Audio()`. Scroll phải đặt `flex:1 1 0; min-height:0; overflow-y:auto` trên inner child.
- **Mọi Premiere API là async** — `getSelection()`, `getTrackItems()`, `getInPoint()`, `getMediaFilePath()`… đều phải `await` (nhiều cái trả Promise, dùng helper `un()`/`awaitArray()` sẵn có).
- **Prefix biến/ID mới = `vcx`** để không đụng `vc` (Clone Voice) hoặc `vg` (Voice tab).
- **ElevenLabs STS:** `POST /v1/speech-to-speech/{voiceId}?output_format=mp3_44100_128`, multipart fields `audio`(file), `model_id`, `voice_settings`(JSON string), `remove_background_noise`(bool). Models hợp lệ: `eleven_multilingual_sts_v2`, `eleven_english_sts_v2`.
- **Endpoint mới trả:** `{ ok:true, variations:[{audioPath, previewUrl, sizeBytes, filename}], saveDir }` — trùng shape `/tts/generate`.
- **Header commit:** kết thúc message bằng `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

- **Modify** `bridge/server.js` — thêm helper `buildMultipartBody()` (tách từ logic trong `elevenLabsMultipart`), thêm `elevenLabsMultipart` cờ `expectBinary`, thêm endpoint `POST /voice/change`.
- **Create** `bridge/test/voice-change.test.js` — test thuần (node assert) cho `buildMultipartBody` + validate param (không mạng).
- **Modify** `plugin/index.html` — thêm card `#vcChangeCard` + section `#vcChangeSection` trong `.vg-modeContent[data-mode="create"]`.
- **Modify** `plugin/main.js` — mở rộng `vcSelectMethod`, thêm state `vcx*`, input capture, voice picker, convert handler, persistence.
- **Modify** `plugin/styles.css` — style tối thiểu cho picker/sliders card (nếu cần).
- **Modify** `plugin/manifest.json` + version comment trong `plugin/main.js` + `CHANGELOG.md` — bump version.

Reuse đã xác nhận (KHÔNG viết lại):
- Bridge: `elevenLabsMultipart` (server.js:833), `getTempDir()`, `ensureDir()`, `ELEVENLABS_DEFAULT_KEY`, `/tts/concat-from-sequence` (server.js:1632), route `/tts/audio/:filename` (server.js:1406).
- Plugin: `postJsonVG(endpoint, body)` (main.js:6569), `renderVariations()` (main.js:6791), biến `lastVariations`/`lastVariationsMode`, `els.resultSection`, `VG_VOICES_DATA`, `loadVoices()`, `vcGetTrackItemFilePath()` (main.js:429), `getClipItems()`, `getTimeSec()`, `un()`, `awaitArray()`, `getActiveSequence()`, `vcSelectMethod()` (main.js:7789).

---

### Task 1: Bridge — helper multipart binary + endpoint `/voice/change`

**Files:**
- Modify: `bridge/server.js` (thêm sau `elevenLabsMultipart`, ~server.js:889; endpoint đặt cạnh các route `/voice/*`, ~server.js:1315)
- Test: `bridge/test/voice-change.test.js` (create)

**Interfaces:**
- Consumes: `getTempDir()`, `ensureDir()`, `ELEVENLABS_DEFAULT_KEY`, `ELEVENLABS_BASE`.
- Produces:
  - `buildMultipartBody(boundary, fields, files) -> Buffer` (pure)
  - `elevenLabsMultipart(apiKey, urlPath, fields, files, expectBinary=false) -> Promise<object|{buffer,contentType}>`
  - route `POST /voice/change` trả `{ ok, variations:[{audioPath,previewUrl,sizeBytes,filename}], saveDir }`

- [ ] **Step 1: Viết test thất bại cho `buildMultipartBody`**

Create `bridge/test/voice-change.test.js`:

```js
const assert = require('assert');
const { buildMultipartBody } = require('../server.js');

// buildMultipartBody phải là pure function export được từ server.js
const boundary = '----TESTB';
const body = buildMultipartBody(
  boundary,
  { model_id: 'eleven_multilingual_sts_v2', remove_background_noise: 'true' },
  [{ fieldName: 'audio', buffer: Buffer.from('RIFFDATA'), filename: 'in.wav', contentType: 'audio/wav' }]
);
const s = body.toString('binary');

assert.ok(body instanceof Buffer, 'trả về Buffer');
assert.ok(s.includes('name="model_id"'), 'có field model_id');
assert.ok(s.includes('eleven_multilingual_sts_v2'), 'có giá trị model');
assert.ok(s.includes('name="remove_background_noise"'), 'có field denoise');
assert.ok(s.includes('name="audio"; filename="in.wav"'), 'có file audio');
assert.ok(s.includes('RIFFDATA'), 'có nội dung file');
assert.ok(s.trim().endsWith('--' + boundary + '--'), 'đóng boundary đúng');
assert.ok(!s.includes('undefined'), 'không rò field null/undefined');

// field null bị bỏ qua
const body2 = buildMultipartBody(boundary, { a: null, b: 'x' }, []);
assert.ok(!body2.toString('binary').includes('name="a"'), 'field null bị bỏ');

console.log('OK buildMultipartBody');
```

- [ ] **Step 2: Chạy test — xác nhận FAIL**

Run: `node bridge/test/voice-change.test.js`
Expected: FAIL — `TypeError: buildMultipartBody is not a function` (chưa export).

- [ ] **Step 3: Tách `buildMultipartBody` (pure) + thêm cờ `expectBinary`**

Trong `bridge/server.js`, thay thân `elevenLabsMultipart` (server.js:833-889) bằng phiên bản dùng helper tách rời và hỗ trợ nhị phân. Chèn hàm `buildMultipartBody` ngay TRƯỚC `elevenLabsMultipart`:

```js
// Dựng body multipart/form-data (pure — test được, không mạng).
function buildMultipartBody(boundary, fields, files) {
  const parts = [];
  for (const [name, value] of Object.entries(fields || {})) {
    if (value == null) continue;
    parts.push(Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="' + name + '"\r\n\r\n' +
      String(value) + '\r\n'
    ));
  }
  for (const { fieldName, buffer, filename, contentType } of (files || [])) {
    parts.push(Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="' + fieldName + '"; filename="' + filename + '"\r\n' +
      'Content-Type: ' + (contentType || 'audio/mpeg') + '\r\n\r\n'
    ));
    parts.push(buffer);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from('--' + boundary + '--\r\n'));
  return Buffer.concat(parts);
}

// Multipart POST. expectBinary=true → resolve { buffer, contentType }; ngược lại parse JSON.
function elevenLabsMultipart(apiKey, urlPath, fields, files, expectBinary) {
  apiKey = apiKey || ELEVENLABS_DEFAULT_KEY;
  return new Promise((resolve, reject) => {
    const boundary = '----ELBoundary' + Date.now().toString(16);
    const body     = buildMultipartBody(boundary, fields, files);
    const url      = new URL(ELEVENLABS_BASE + urlPath);
    const opts     = {
      hostname: url.hostname, port: 443,
      path: url.pathname + url.search, method: 'POST',
      headers: {
        'xi-api-key':     apiKey,
        'Content-Type':   'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length,
        'Accept':         expectBinary ? 'audio/mpeg' : 'application/json',
      },
    };
    const req = require('https').request(opts, response => {
      const chunks = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (response.statusCode >= 200 && response.statusCode < 300) {
          if (expectBinary) return resolve({ buffer: buf, contentType: response.headers['content-type'] });
          try   { resolve(JSON.parse(buf.toString('utf8'))); }
          catch (e) { reject(new Error('Bad JSON: ' + buf.toString('utf8').slice(0, 200))); }
        } else {
          reject(new Error('ElevenLabs HTTP ' + response.statusCode + ': ' + buf.toString('utf8').slice(0, 300)));
        }
      });
    });
    req.on('error', err => reject(new Error('ElevenLabs network: ' + err.message)));
    req.write(body);
    req.end();
  });
}
```

Ở cuối `bridge/server.js`, nếu có `module.exports` thì thêm; nếu chưa có, thêm mới (đặt cuối file, chỉ để test import — Express app vẫn chạy bình thường vì `require` chỉ nạp, `app.listen` đã gọi khi chạy trực tiếp):

```js
module.exports = Object.assign(module.exports || {}, { buildMultipartBody });
```

> LƯU Ý: kiểm tra cuối file có `app.listen(...)` chạy vô điều kiện. Nếu có, `require('../server.js')` trong test sẽ khởi động server (chiếm port 3030). Để tránh: bọc listen bằng `if (require.main === module) { app.listen(...) }`. Sửa dòng `app.listen` hiện tại thành dạng này.

- [ ] **Step 4: Chạy test — xác nhận PASS**

Run: `node bridge/test/voice-change.test.js`
Expected: `OK buildMultipartBody`

- [ ] **Step 5: Thêm endpoint `POST /voice/change`**

Chèn cạnh nhóm route `/voice/*` (sau `/voice/design/save`, ~server.js:1315):

```js
// Voice Changer — ElevenLabs Speech-to-Speech. Đọc file audio local → đổi sang voiceId.
app.post('/voice/change', async (req, res) => {
  try {
    const {
      apiKey, voiceId, inputPath, modelId, settings,
      removeBackgroundNoise, outputFormat, filename, outputDir,
    } = req.body;
    if (!apiKey)    throw new Error('apiKey required');
    if (!voiceId)   throw new Error('voiceId required');
    if (!inputPath) throw new Error('inputPath required');
    if (!fs.existsSync(inputPath)) throw new Error('inputPath not found: ' + inputPath);

    const model = modelId || 'eleven_multilingual_sts_v2';
    const fmt   = outputFormat || 'mp3_44100_128';
    const vs = {
      stability:        Number(settings && settings.stability  != null ? settings.stability  : 0.5),
      similarity_boost: Number(settings && settings.similarity != null ? settings.similarity : 0.75),
      style:            Number(settings && settings.style      != null ? settings.style      : 0),
    };
    const fields = { model_id: model, voice_settings: JSON.stringify(vs) };
    if (removeBackgroundNoise) fields.remove_background_noise = 'true';

    const inBuf = fs.readFileSync(inputPath);
    const inName = path.basename(inputPath);
    const inType = inName.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';

    console.log('[voice/change]', inName, inBuf.length, 'bytes → voice', voiceId, 'model', model);
    const urlPath = '/v1/speech-to-speech/' + encodeURIComponent(voiceId) +
                    '?output_format=' + encodeURIComponent(fmt);
    const out = await elevenLabsMultipart(
      apiKey, urlPath, fields,
      [{ fieldName: 'audio', buffer: inBuf, filename: inName, contentType: inType }],
      true
    );

    const saveDir = (outputDir && typeof outputDir === 'string' && outputDir.trim())
      ? outputDir.trim() : getTempDir();
    ensureDir(saveDir);
    const base  = (filename && typeof filename === 'string')
      ? filename.replace(/\.mp3$/i, '') : ('voicechange-' + Date.now());
    const fname = base + '.mp3';
    const fpath = path.join(saveDir, fname);
    fs.writeFileSync(fpath, out.buffer);
    console.log('[voice/change] saved', out.buffer.length, 'bytes →', fpath);

    res.json({
      ok: true,
      variations: [{
        audioPath:  fpath,
        previewUrl: '/tts/audio/' + encodeURIComponent(fname),
        sizeBytes:  out.buffer.length,
        filename:   fname,
      }],
      saveDir,
    });
  } catch (err) {
    console.error('[voice/change]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});
```

- [ ] **Step 6: `node --check` + test validate qua server chạy thật**

Run:
```bash
node --check bridge/server.js
```
Expected: không lỗi.

Rồi chạy server và test lỗi thiếu param (không cần key thật):
```bash
node bridge/server.js &  sleep 1
curl -s -X POST http://localhost:3030/voice/change -H 'Content-Type: application/json' -d '{}'
kill %1
```
Expected: `{"ok":false,"error":"apiKey required"}`

- [ ] **Step 7: Commit**

```bash
git add bridge/server.js bridge/test/voice-change.test.js
git commit -m "feat(bridge): POST /voice/change — ElevenLabs speech-to-speech

Tách buildMultipartBody (pure, test được) + cờ expectBinary cho
elevenLabsMultipart; endpoint đọc file local → STS → lưu output trả
variations đúng shape /tts/generate.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Plugin HTML — card + section Voice Changer

**Files:**
- Modify: `plugin/index.html` (`.vc-methodCards` ~index.html:531-546; section chèn sau `#vcCloneSection`/`#vcDesignSection`, trước khi đóng `.vc-scroll`)

**Interfaces:**
- Produces (ID cho Task 3-6): `#vcChangeCard`, `#vcChangeSection`, `#vcxSrcSeq`/`#vcxSrcFile` (radio `name="vcxSource"`), `#vcxGetSel`, `#vcxSelInfo`, `#vcxBrowse`, `#vcxFileInfo`, `#vcxVoiceHost`, `#vcxVoiceSearch`, `#vcxVoiceList`, `#vcxVoiceLabel`, `#vcxModel`, `#vcxStability`, `#vcxSimilarity`, `#vcxStyle`, `#vcxDenoise`, `#vcxConvert`, `#vcxStatus`.

- [ ] **Step 1: Thêm card vào `.vc-methodCards`**

Trong `plugin/index.html`, sau `#vcDesignCard` (index.html:545), thêm:

```html
              <div id="vcChangeCard" class="vc-choiceCard" role="button">
                <span class="vc-ccIcon" data-ic="shuffle" data-ic-size="18" data-ic-color="#22d3ee"></span>
                <div class="vc-ccText">
                  <div class="vc-ccTitle">Voice Changer</div>
                  <div class="vc-ccSub">Đổi giọng đoạn audio sang giọng khác</div>
                </div>
              </div>
```

- [ ] **Step 2: Thêm `#vcChangeSection`**

Sau khi đóng `#vcDesignSection` (tìm thẻ đóng của design section trong `.vc-scroll`), chèn:

```html
            <!-- ── VOICE CHANGER SECTION ── -->
            <div id="vcChangeSection" hidden>
              <div class="vc-step">
                <div class="vc-stepHd"><span class="vc-stepNo">1</span> Nguồn audio</div>
                <div class="vc-segTabs">
                  <label class="vc-seg"><input type="radio" name="vcxSource" id="vcxSrcSeq" value="sequence" checked /><span>Clip đang chọn</span></label>
                  <label class="vc-seg"><input type="radio" name="vcxSource" id="vcxSrcFile" value="file" /><span>From File</span></label>
                </div>
                <div id="vcxFromSeq">
                  <div id="vcxGetSel" class="vc-bigBtn vc-bigPrimary" role="button"><span data-ic="download" data-ic-size="13" data-ic-color="#ffffff"></span> Lấy clip đang chọn</div>
                  <div class="vc-clipInfo" id="vcxSelInfo">Chọn 1 hay nhiều clip audio trên timeline — plugin gộp lại thành 1 file.</div>
                </div>
                <div id="vcxFromFile" hidden>
                  <div id="vcxBrowse" class="vc-bigBtn vc-bigPrimary" role="button"><span data-ic="folder_open" data-ic-size="13" data-ic-color="#ffffff"></span> Chọn file audio</div>
                  <div class="vc-clipInfo" id="vcxFileInfo">Chọn file MP3/WAV/M4A cần đổi giọng.</div>
                </div>
              </div>

              <div class="vc-step">
                <div class="vc-stepHd"><span class="vc-stepNo">2</span> Giọng đích</div>
                <div id="vcxVoiceHost" class="vcx-voiceHost">
                  <div id="vcxVoiceLabel" class="vcx-voiceLabel" role="button">Chọn giọng… <span class="vg-caret">▾</span></div>
                  <div id="vcxVoicePanel" class="vcx-voicePanel" hidden>
                    <input type="text" id="vcxVoiceSearch" class="vg-dropSearchInput" placeholder="Search voices…" />
                    <div id="vcxVoiceList" class="vg-dropList"></div>
                  </div>
                </div>
              </div>

              <div class="vc-step">
                <div class="vc-stepHd"><span class="vc-stepNo">3</span> Thiết lập</div>
                <div class="vc-field">
                  <label class="vc-label">Model</label>
                  <select id="vcxModel" class="vg-settingInput">
                    <option value="eleven_multilingual_sts_v2">Multilingual STS v2</option>
                    <option value="eleven_english_sts_v2">English STS v2</option>
                  </select>
                </div>
                <div class="vc-field">
                  <label class="vc-label">Stability <span class="vg-sm" id="vcxStabilityVal">0.50</span></label>
                  <input type="range" id="vcxStability" min="0" max="1" step="0.05" value="0.5" class="vcx-range" />
                </div>
                <div class="vc-field">
                  <label class="vc-label">Similarity <span class="vg-sm" id="vcxSimilarityVal">0.75</span></label>
                  <input type="range" id="vcxSimilarity" min="0" max="1" step="0.05" value="0.75" class="vcx-range" />
                </div>
                <div class="vc-field">
                  <label class="vc-label">Style <span class="vg-sm" id="vcxStyleVal">0.00</span></label>
                  <input type="range" id="vcxStyle" min="0" max="1" step="0.05" value="0" class="vcx-range" />
                </div>
                <label class="vg-checkRow">
                  <input type="checkbox" id="vcxDenoise" />
                  <span>Khử tiếng ồn nền</span>
                </label>
              </div>

              <div id="vcxConvert" class="vg-genButton" role="button" style="margin-top:10px;width:100%;"><span data-ic="shuffle" data-ic-size="14" data-ic-color="#ffffff"></span> ĐỔI GIỌNG</div>
              <div class="ac-manualStatus" id="vcxStatus" style="margin-top:6px;"></div>
            </div>
```

- [ ] **Step 3: Xác nhận ID có mặt**

Run:
```bash
grep -c 'id="vcxConvert"\|id="vcChangeCard"\|id="vcxGetSel"\|id="vcxVoiceList"\|id="vcxModel"\|id="vcxStability"' plugin/index.html
```
Expected: `6`

- [ ] **Step 4: Commit**

```bash
git add plugin/index.html
git commit -m "feat(vg): markup card + section Voice Changer trong tab Create

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Plugin JS — chuyển card + state + persistence

**Files:**
- Modify: `plugin/main.js` (`vcSelectMethod` ~main.js:7789; wiring cạnh `vcCloneCard`/`vcDesignCard` ~main.js:7795; khối biến IIFE Voice Gen)

**Interfaces:**
- Consumes: `vcSelectMethod(m)` hiện có (main.js:7789).
- Produces: state `vcxInputPath`, `vcxVoiceId`, `vcxVoiceLabel` (biến JS), `vcxLoadSettings()`, `vcxSaveSettings()`, hằng `VG_VCX_LS='vg_vcx_v1'`; card `'change'` hoạt động.

- [ ] **Step 1: Mở rộng `vcSelectMethod` cho `'change'`**

Trong `plugin/main.js`, sửa khối `vcSelectMethod` (main.js:7789-7792). Sau các dòng toggle clone/design, thêm:

```js
      var vcChangeCard    = document.getElementById('vcChangeCard');
      var vcChangeSection = document.getElementById('vcChangeSection');
      if (vcChangeCard)    vcChangeCard.classList.toggle('is-active', m === 'change');
      if (vcChangeSection) vcChangeSection.hidden = (m !== 'change');
```

- [ ] **Step 2: Wire click card**

Sau dòng wire `vcDesignCard` (main.js:7796), thêm:

```js
    var vcChangeCard = document.getElementById('vcChangeCard');
    if (vcChangeCard) vcChangeCard.addEventListener('click', function() { vcSelectMethod('change'); });
```

- [ ] **Step 3: Thêm state + persistence**

Trong IIFE Voice Gen (gần khai báo `lastVariations`, ~main.js:5863), thêm:

```js
  // ── Voice Changer (STS) state ──
  var vcxInputPath  = '';
  var vcxVoiceId    = '';
  var vcxVoiceLabel = '';
  var VG_VCX_LS     = 'vg_vcx_v1';
  function vcxLoadSettings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(VG_VCX_LS) || '{}') || {}; } catch (e) {}
    var byId = function(id, v) { var el = document.getElementById(id); if (el != null && v != null) el.value = v; };
    if (s.voiceId)  { vcxVoiceId = s.voiceId; vcxVoiceLabel = s.voiceLabel || ''; }
    byId('vcxModel',      s.modelId    || 'eleven_multilingual_sts_v2');
    byId('vcxStability',  s.stability  != null ? s.stability  : 0.5);
    byId('vcxSimilarity', s.similarity != null ? s.similarity : 0.75);
    byId('vcxStyle',      s.style      != null ? s.style      : 0);
    var dn = document.getElementById('vcxDenoise'); if (dn) dn.checked = !!s.removeNoise;
    var lbl = document.getElementById('vcxVoiceLabel');
    if (lbl && vcxVoiceLabel) lbl.textContent = vcxVoiceLabel + ' ▾';
    vcxSyncSliderLabels();
  }
  function vcxSaveSettings() {
    var num = function(id, d) { var el = document.getElementById(id); return el ? Number(el.value) : d; };
    var dn = document.getElementById('vcxDenoise');
    var s = {
      voiceId: vcxVoiceId, voiceLabel: vcxVoiceLabel,
      modelId: (document.getElementById('vcxModel') || {}).value || 'eleven_multilingual_sts_v2',
      stability: num('vcxStability', 0.5), similarity: num('vcxSimilarity', 0.75),
      style: num('vcxStyle', 0), removeNoise: !!(dn && dn.checked),
    };
    try { localStorage.setItem(VG_VCX_LS, JSON.stringify(s)); } catch (e) {}
  }
  function vcxSyncSliderLabels() {
    [['vcxStability','vcxStabilityVal'],['vcxSimilarity','vcxSimilarityVal'],['vcxStyle','vcxStyleVal']]
      .forEach(function(p) {
        var el = document.getElementById(p[0]), out = document.getElementById(p[1]);
        if (el && out) out.textContent = Number(el.value).toFixed(2);
      });
  }
```

- [ ] **Step 4: Wire slider labels + save khi đổi**

Trong khối wiring của Voice Gen (nơi các `addEventListener` khác được đăng ký, ví dụ cuối IIFE gần main.js:7617), thêm:

```js
  ['vcxStability','vcxSimilarity','vcxStyle'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('input', function() { vcxSyncSliderLabels(); vcxSaveSettings(); });
  });
  ['vcxModel','vcxDenoise'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', vcxSaveSettings);
  });
  var vcxSeqR = document.getElementById('vcxSrcSeq'), vcxFileR = document.getElementById('vcxSrcFile');
  function vcxSyncSource() {
    var isFile = !!(vcxFileR && vcxFileR.checked);
    var fs = document.getElementById('vcxFromFile'), sq = document.getElementById('vcxFromSeq');
    if (fs) fs.hidden = !isFile; if (sq) sq.hidden = isFile;
  }
  if (vcxSeqR)  vcxSeqR.addEventListener('change', vcxSyncSource);
  if (vcxFileR) vcxFileR.addEventListener('change', vcxSyncSource);
  vcxLoadSettings();
```

- [ ] **Step 5: `node --check`**

Run: `node --check plugin/main.js`
Expected: không lỗi.

- [ ] **Step 6: Commit**

```bash
git add plugin/main.js
git commit -m "feat(vg): Voice Changer — chuyển card + state + persistence settings

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Plugin JS — thu input (selection concat + browse file)

**Files:**
- Modify: `plugin/main.js` (thêm hàm trong IIFE Voice Gen; wiring nút)

**Interfaces:**
- Consumes: `getActiveSequence()`, `un()`, `awaitArray()`, `vcGetTrackItemFilePath()` (main.js:429), `getTimeSec()`, `postJsonVG()` (main.js:6569).
- Produces: `vcxGetSelectionAudio()`, `vcxBrowseInput()`; set `vcxInputPath` + cập nhật `#vcxSelInfo`/`#vcxFileInfo`.

- [ ] **Step 1: Hàm gộp clip đang chọn**

Thêm trong IIFE Voice Gen:

```js
  async function vcxGetSelectionAudio() {
    var info = document.getElementById('vcxSelInfo');
    var btn  = document.getElementById('vcxGetSel');
    if (btn) btn.disabled = true;
    try {
      if (!ppro) throw new Error('Premiere API không khả dụng');
      var seq = await getActiveSequence();
      if (!seq) throw new Error('Chưa mở sequence');
      var sel = await un(seq.getSelection());
      if (!sel) throw new Error('Không lấy được vùng chọn');
      var items = await awaitArray(sel.getTrackItems());
      if (!items || !items.length) throw new Error('Hãy chọn clip audio trên timeline');

      if (info) info.textContent = 'Đang đọc ' + items.length + ' clip…';
      var clips = [];
      for (var i = 0; i < items.length; i++) {
        var ti = items[i];
        var inSec = 0, outSec = 0;
        try { var ip = ti.getInPoint && ti.getInPoint(); if (ip && ip.then) ip = await ip; if (ip) inSec = getTimeSec(ip); } catch (e) {}
        try { var op = ti.getOutPoint && ti.getOutPoint(); if (op && op.then) op = await op; if (op) outSec = getTimeSec(op); } catch (e) {}
        if (!outSec || outSec <= inSec) {
          try {
            var gs = ti.getStart && ti.getStart(); if (gs && gs.then) gs = await gs;
            var ge = ti.getEnd && ti.getEnd();     if (ge && ge.then) ge = await ge;
            inSec = 0; outSec = getTimeSec(ge) - getTimeSec(gs);
          } catch (e) {}
        }
        var fp = await vcGetTrackItemFilePath(ti);
        if (!fp) throw new Error('Clip ' + (i + 1) + ': không lấy được đường dẫn — dùng "From File"');
        clips.push({ filePath: fp, inPoint: inSec, outPoint: outSec });
      }

      if (info) info.textContent = 'Đang gộp ' + clips.length + ' clip…';
      var resp = await postJsonVG('/tts/concat-from-sequence', { clips: clips, outputDir: '' });
      if (!resp.ok) throw new Error(resp.error || 'Gộp clip thất bại');
      vcxInputPath = resp.audioPath;
      var nm = resp.audioPath.split('/').pop();
      if (info) info.textContent = '✓ ' + nm + ' (' + clips.length + ' clip)';
    } catch (e) {
      vcxInputPath = '';
      if (info) info.textContent = '✗ ' + e.message;
      console.error('[vcx] getSelection', e);
    } finally {
      if (btn) btn.disabled = false;
    }
  }
```

- [ ] **Step 2: Hàm chọn file (theo mẫu `vcBrowseFile`)**

Thêm:

```js
  async function vcxBrowseInput() {
    var info = document.getElementById('vcxFileInfo');
    try {
      var uxp = window.require && window.require('uxp');
      if (!uxp || !uxp.storage) throw new Error('UXP storage không khả dụng');
      var fs = uxp.storage.localFileSystem;
      var file = await fs.getFileForOpening({ types: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] });
      if (!file) return; // user hủy
      var p = file.nativePath || (file.url ? decodeURIComponent(file.url.replace(/^file:\/\//, '')) : '');
      if (!p) throw new Error('Không đọc được đường dẫn file');
      vcxInputPath = p;
      if (info) info.textContent = '✓ ' + p.split('/').pop();
    } catch (e) {
      vcxInputPath = '';
      if (info) info.textContent = '✗ ' + e.message;
      console.error('[vcx] browse', e);
    }
  }
```

> KIỂM CHỨNG API file picker: mở `plugin/main.js`, xem hàm `vcBrowseFile` hiện có (đăng ký ~main.js:7991) dùng đúng `getFileForOpening` với `types` và cách lấy `nativePath` nào — sao chép ĐÚNG cách đó để nhất quán (thay `getFileForOpening` ở trên nếu code hiện có dùng dạng khác).

- [ ] **Step 3: Wire nút**

Trong khối wiring (cạnh Step 4 của Task 3), thêm:

```js
  var vcxGetSelBtn = document.getElementById('vcxGetSel');
  if (vcxGetSelBtn) vcxGetSelBtn.addEventListener('click', vcxGetSelectionAudio);
  var vcxBrowseBtn = document.getElementById('vcxBrowse');
  if (vcxBrowseBtn) vcxBrowseBtn.addEventListener('click', vcxBrowseInput);
```

- [ ] **Step 4: `node --check`**

Run: `node --check plugin/main.js`
Expected: không lỗi.

- [ ] **Step 5: Commit**

```bash
git add plugin/main.js
git commit -m "feat(vg): Voice Changer — thu input từ selection (gộp) + chọn file

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Plugin JS — voice picker riêng trong card

**Files:**
- Modify: `plugin/main.js` (thêm hàm render picker; wiring)
- Modify: `plugin/styles.css` (style panel picker)

**Interfaces:**
- Consumes: `VG_VOICES_DATA` (mảng `{voice_id, label, isCustom, isSep}`), `loadVoices()`.
- Produces: `vcxRenderVoiceList()`, toggle panel; set `vcxVoiceId`/`vcxVoiceLabel` + `#vcxVoiceLabel`.

- [ ] **Step 1: Hàm render danh sách voice (có filter)**

Thêm trong IIFE Voice Gen:

```js
  function vcxRenderVoiceList(filter) {
    var list = document.getElementById('vcxVoiceList');
    if (!list) return;
    list.innerHTML = '';
    var q = (filter || '').trim().toLowerCase();
    (VG_VOICES_DATA || []).forEach(function(v) {
      if (v.isSep || v.voice_id === '__custom__') return;
      var label = (v.isCustom ? '⭐ ' : '') + v.label;
      if (q && label.toLowerCase().indexOf(q) === -1) return;
      var item = document.createElement('div');
      item.className = 'vg-dropItem' + (v.voice_id === vcxVoiceId ? ' is-selected' : '');
      item.textContent = label;
      item.addEventListener('click', function() {
        vcxVoiceId = v.voice_id; vcxVoiceLabel = v.label;
        var lbl = document.getElementById('vcxVoiceLabel');
        if (lbl) lbl.textContent = v.label + ' ▾';
        var panel = document.getElementById('vcxVoicePanel');
        if (panel) panel.hidden = true;
        vcxSaveSettings();
      });
      list.appendChild(item);
    });
    if (!list.children.length) {
      var empty = document.createElement('div');
      empty.className = 'vc-clipInfo';
      empty.textContent = (VG_VOICES_DATA && VG_VOICES_DATA.length) ? 'Không khớp voice nào.' : 'Chưa nạp voice — bấm Refresh ở tab Voice.';
      list.appendChild(empty);
    }
  }
```

- [ ] **Step 2: Wire toggle panel + search**

Trong khối wiring, thêm:

```js
  var vcxVoiceLabelEl = document.getElementById('vcxVoiceLabel');
  if (vcxVoiceLabelEl) vcxVoiceLabelEl.addEventListener('click', function() {
    var panel = document.getElementById('vcxVoicePanel');
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) vcxRenderVoiceList(document.getElementById('vcxVoiceSearch').value);
  });
  var vcxSearch = document.getElementById('vcxVoiceSearch');
  if (vcxSearch) vcxSearch.addEventListener('input', function() { vcxRenderVoiceList(this.value); });
```

- [ ] **Step 3: Style panel (CSS)**

Trong `plugin/styles.css`, thêm:

```css
.vcx-voiceHost { position: relative; }
.vcx-voiceLabel {
  padding: 8px 10px; border: 1px solid var(--vg-border, #3a2f52);
  border-radius: 6px; cursor: pointer; font-size: 12px; color: #e8e8e8;
}
.vcx-voicePanel {
  margin-top: 4px; border: 1px solid var(--vg-border, #3a2f52);
  border-radius: 6px; background: rgba(20,16,32,0.98); padding: 6px;
}
.vcx-voicePanel .vg-dropList {
  max-height: 220px; overflow-y: auto; margin-top: 6px;
}
.vcx-range { width: 100%; }
```

> LƯU Ý UXP: KHÔNG dùng `z-index`. Panel là block thường (đẩy nội dung xuống), không phải overlay — phù hợp UXP.

- [ ] **Step 4: `node --check` + xác nhận CSS**

Run:
```bash
node --check plugin/main.js && grep -c "vcxRenderVoiceList" plugin/main.js && grep -c "vcx-voicePanel" plugin/styles.css
```
Expected: không lỗi; `2`; `1`.

- [ ] **Step 5: Commit**

```bash
git add plugin/main.js plugin/styles.css
git commit -m "feat(vg): Voice Changer — voice picker riêng (dùng chung VG_VOICES_DATA)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Plugin JS — nút Đổi giọng → `/voice/change` → kết quả

**Files:**
- Modify: `plugin/main.js` (hàm convert; wiring nút `#vcxConvert`)

**Interfaces:**
- Consumes: `postJsonVG()`, `renderVariations()` (main.js:6791), `lastVariations`, `lastVariationsMode`, `els.resultSection`, `ELEVENLABS_KEY`.
- Produces: `vcxConvert()`; đổ kết quả vào `#vgResultSection`.

- [ ] **Step 1: Hàm convert**

Thêm trong IIFE Voice Gen:

```js
  async function vcxConvert() {
    var status = document.getElementById('vcxStatus');
    var setS = function(cls, txt) { if (status) { status.className = 'ac-manualStatus' + (cls ? ' ' + cls : ''); status.textContent = txt; } };
    if (!vcxInputPath) { setS('is-err', '✗ Chưa có audio nguồn'); return; }
    if (!vcxVoiceId)   { setS('is-err', '✗ Chưa chọn giọng đích'); return; }
    if (!ELEVENLABS_KEY) { setS('is-err', '✗ Chưa có ElevenLabs API key (Settings)'); return; }

    var num = function(id, d) { var el = document.getElementById(id); return el ? Number(el.value) : d; };
    var dn  = document.getElementById('vcxDenoise');
    var body = {
      apiKey:  ELEVENLABS_KEY,
      voiceId: vcxVoiceId,
      inputPath: vcxInputPath,
      modelId: (document.getElementById('vcxModel') || {}).value || 'eleven_multilingual_sts_v2',
      settings: { stability: num('vcxStability', 0.5), similarity: num('vcxSimilarity', 0.75), style: num('vcxStyle', 0) },
      removeBackgroundNoise: !!(dn && dn.checked),
      filename: 'voicechange-' + (vcxVoiceLabel || 'out').replace(/[^\w.-]+/g, '_'),
    };
    setS('', '⏳ Đang đổi giọng…');
    try {
      var resp = await postJsonVG('/voice/change', body);
      if (!resp.ok) throw new Error(resp.error || 'Đổi giọng thất bại');
      lastVariations = resp.variations || [];
      lastVariationsMode = 'tts'; // dùng chung bin/flow tab Voice
      renderVariations();
      if (els.resultSection) els.resultSection.hidden = false;
      setS('is-ok', '✓ Xong — nghe thử & Lưu/Import ở khu kết quả bên dưới');
    } catch (e) {
      setS('is-err', '✗ ' + e.message);
      console.error('[vcx] convert', e);
    }
  }
```

- [ ] **Step 2: Wire nút**

Trong khối wiring, thêm:

```js
  var vcxConvertBtn = document.getElementById('vcxConvert');
  if (vcxConvertBtn) vcxConvertBtn.addEventListener('click', vcxConvert);
```

- [ ] **Step 3: `node --check`**

Run: `node --check plugin/main.js`
Expected: không lỗi.

- [ ] **Step 4: Kiểm chứng biến dùng chung tồn tại đúng tên**

Run:
```bash
grep -n "var ELEVENLABS_KEY\|ELEVENLABS_KEY =" plugin/main.js | head -1
grep -n "lastVariationsMode" plugin/main.js | head -1
grep -n "resultSection:" plugin/main.js | head -1
```
Expected: cả 3 đều có kết quả (xác nhận tên biến khớp; nếu khác, sửa lại trong `vcxConvert`).

- [ ] **Step 5: Commit**

```bash
git add plugin/main.js
git commit -m "feat(vg): Voice Changer — nút Đổi giọng gọi /voice/change + render kết quả

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Version bump + CHANGELOG + cài lại bản External

**Files:**
- Modify: `plugin/main.js` (dòng `PLUGIN_VERSION`, main.js:794), `plugin/manifest.json`, `CHANGELOG.md`

**Interfaces:** không có.

- [ ] **Step 1: Bump version**

Sửa `plugin/manifest.json` `"version"` → `"5.4.0"`.
Sửa dòng `PLUGIN_VERSION` (main.js:794) → `v5.4.0` với ghi chú ngắn về Voice Changer (đặt trước phần ghi chú cũ).

- [ ] **Step 2: CHANGELOG**

Thêm mục đầu `CHANGELOG.md`:

```markdown
## v5.4.0 — 2026-08-20

### ✅ Thêm mới
- **Voice Changer (Đổi giọng)** — card thứ 3 trong tab Create. Lấy audio từ clip
  đang chọn trên timeline (gộp nhiều clip qua ffmpeg) hoặc upload file → đổi sang
  giọng đích ElevenLabs (Speech-to-Speech). Settings: model STS, Stability/
  Similarity/Style, khử tiếng ồn nền. Kết quả dùng chung khu Lưu/Import của tab Voice.
- **Bridge `POST /voice/change`** — đọc file local → multipart STS → lưu output.
```

- [ ] **Step 3: `node --check` + xác nhận version**

Run:
```bash
node --check plugin/main.js && grep -m1 "PLUGIN_VERSION" plugin/main.js | grep -o "v5.4.0" && grep '"version"' plugin/manifest.json
```
Expected: `v5.4.0`; `"version": "5.4.0"`.

- [ ] **Step 4: Commit**

```bash
git add plugin/main.js plugin/manifest.json CHANGELOG.md
git commit -m "release: v5.4.0 — Voice Changer (ElevenLabs STS)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: Cài lại vào bản External mà Premiere chạy**

```bash
SRC="$PWD/plugin"
DST="$HOME/Library/Application Support/Adobe/UXP/Plugins/External/com.claudeai.premiere-assistant_5.3.0"
cp "$SRC/main.js" "$DST/main.js" && cp "$SRC/index.html" "$DST/index.html" && cp "$SRC/styles.css" "$DST/styles.css" && cp "$SRC/manifest.json" "$DST/manifest.json" && echo "copied"
grep -m1 "PLUGIN_VERSION" "$DST/main.js" | grep -o "v5.4.0"
```
Expected: `copied` + `v5.4.0`.

> Nhắc user: đóng/mở lại panel Claude AI (hoặc restart Premiere) để nạp code mới, rồi restart bridge (`cd bridge && node server.js`) vì có endpoint mới.

---

## Manual Integration Test (sau Task 7)

1. Restart bridge; `curl -s -X POST http://localhost:3030/voice/change -d '{}' -H 'Content-Type: application/json'` → `{"ok":false,"error":"apiKey required"}`.
2. Trong Premiere: tab Voice Gen → Create → card **Voice Changer**.
3. Chọn 2 clip audio trên timeline → **Lấy clip đang chọn** → thấy "✓ …(2 clip)".
4. Mở picker → chọn giọng đích; chỉnh sliders; (tuỳ chọn) bật khử ồn.
5. **ĐỔI GIỌNG** → khu kết quả bên dưới hiện audio → nghe thử.
6. **Lưu** + **Import** → clip vào đúng bin (không còn lỗi bin), + **Import timeline**.
7. Thử lại với **From File**.

---

## Self-Review (đã chạy)

- **Spec coverage:** input selection-concat (Task 4) ✓, upload (Task 4) ✓, picker riêng (Task 5) ✓, settings đầy đủ + persistence (Task 3) ✓, result dùng chung (Task 6) ✓, bridge `/voice/change` (Task 1) ✓, card trong Create (Task 2/3) ✓, version/CHANGELOG/install (Task 7) ✓.
- **Placeholder scan:** không có TODO/TBD; mọi step có code hoặc lệnh cụ thể. Hai chỗ "KIỂM CHỨNG"/"LƯU Ý" là hướng dẫn xác thực tên API/biến tại chỗ (do là codebase lớn không test tự động), kèm lệnh grep để chốt — không phải placeholder logic.
- **Type consistency:** `vcxInputPath/vcxVoiceId/vcxVoiceLabel` dùng nhất quán; endpoint trả `variations` khớp `renderVariations()`; `buildMultipartBody`/`elevenLabsMultipart(...,expectBinary)` khớp giữa Task 1 và endpoint.
