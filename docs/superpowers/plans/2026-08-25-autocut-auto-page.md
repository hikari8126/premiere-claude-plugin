# Trang Auto (bộ 3 video) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm trang "Auto" trong tab Autocut cho phép khai báo cả bộ 3 video ads một lần (số bộ, voice, ratio, 3 ô TSV) rồi tự chạy: validate → gen voice → duyệt → dựng 3 timeline, tự đặt tên/đường dẫn theo quy ước project.

**Architecture:** Trang Auto là overlay trong tab Autocut, không sửa workflow cũ. Logic đặt tên/đường dẫn tách thành module thuần ở bridge (`bridge/autoset-names.js`) để test được bằng `node` + `assert` như tiền lệ `bridge/test/voice-change.test.js`. Phía plugin, một orchestrator gọi lại đúng các hàm sẵn có (`expandRows`, `sacRunAutoCut`, `VoiceGenPushScript`, `ppGetOrCreateBin`) và một lớp `sacJobContext` để đổi ngữ cảnh giữa 3 job vì bảng script là state toàn cục.

**Tech Stack:** Node + Express (bridge), UXP non-module JS (plugin), `node:assert` cho test, ElevenLabs REST, Premiere UXP API.

**Spec:** `docs/superpowers/specs/2026-08-25-autocut-auto-page-design.md`

---

## Bối cảnh mà người thực thi CẦN biết trước khi bắt đầu

Đọc kỹ mục này, nếu không sẽ phá workflow hiện tại.

**Ràng buộc UXP (bắt buộc):**
- `plugin/main.js` là script **non-module** — không `import`/`export`. Mọi thứ nằm trong IIFE/scope sẵn có.
- Không dùng `position:fixed`, `z-index`, `display:grid`, `window.innerWidth`, thuộc tính `title=""`, `new Audio()`.
- Mọi API Premiere đều **async**: phải `await`.
- Input cần `window.claimKeyboard()` khi focus và `window.releaseKeyboard()` khi blur, nếu không Premiere ăn phím tắt.

**Hàm/biến sẵn có sẽ dùng lại (đừng viết lại):**

| Thứ | Vị trí | Vai trò |
|---|---|---|
| `parseTSV(text)` | `plugin/main.js:2989` | tách TSV thành mảng cột |
| `expandRows(rows)` | `plugin/main.js:3045` | tách dòng nhiều timestamp + kế thừa source merge |
| `createRow(text, time, src)` | `plugin/main.js:3317` | tạo 1 dòng trong bảng script |
| `SAC_COL_ORDER`, `SAC_SEM` | `plugin/main.js:3261` | thứ tự cột hiển thị ↔ ngữ nghĩa `[text,time,src]` |
| `sacRunAutoCut(seqMode)` | `plugin/main.js:5422` | dựng timeline; `'new'` đọc `#sacNewSeqName` + `#sacNewSeqRatio` |
| `ppGetOrCreateBin(proj, path)` | `plugin/main.js:2673` | tìm/tạo bin, **đã hỗ trợ lồng cấp** với phân cách `' / '` |
| `ppMoveToBin(...)` | `plugin/main.js:2745` | chuyển item vào bin |
| `VoiceGenPushScript(text, voiceId, autoGenerate, switchTab)` | `plugin/main.js:8890` | đẩy script sang Voice Gen; `switchTab=false` = chạy ngầm |
| `AutocutPushVoice(path)` | `plugin/main.js:8074` | → `sacAlignVoice(path)` |
| `VG_VOICES_DATA` | `plugin/main.js:5998` | danh sách voice `{voice_id, label}` |
| `getActiveProject()` | `plugin/main.js:303` | project đang mở |
| `BRIDGE_URL` | `plugin/main.js:805` | `http://localhost:3030` |

**Endpoint bridge sẵn có:** `/superautocut/validate`, `/superautocut/normalize-script`, `/tts/move` (`{sourcePath,targetDir,targetName,noOverwrite}`), `/sac/log`.

**Điểm tích hợp quan trọng:** `sacRunAutoCut('new')` **đọc tên và ratio từ DOM** (`#sacNewSeqName`, `#sacNewSeqRatio`). Orchestrator phải **ghi giá trị vào 2 input đó trước khi gọi**, chứ không truyền tham số.

**Cách chạy test:** `node bridge/test/<tên>.test.js` — in `OK ...` là đạt, `assert` ném là fail. Không có jest/vitest.

**Cách nạp plugin vào Premiere:** `./reload.sh` rồi đóng/mở panel Claude AI. (Script này đồng bộ vào `com.claudeai.premiere-assistant_5.5.0`.)

---

## File Structure

**Tạo mới:**
- `bridge/autoset-names.js` — module thuần: dựng tên sequence, đường dẫn bin, tên file voice. Không I/O, không phụ thuộc Express → test được trực tiếp.
- `bridge/test/autoset-names.test.js` — test cho module trên.
- `bridge/test/notify.test.js` — test cho hàm dựng lệnh osascript.

**Sửa:**
- `bridge/server.js` — thêm `POST /notify`, `POST /autoset/names`; export hàm dựng lệnh osascript để test.
- `plugin/index.html` — nút Auto + markup trang Auto.
- `plugin/main.js` — orchestrator + `sacJobContext` + wiring.
- `plugin/styles.css` — style trang Auto.

**Nguyên tắc:** toàn bộ code mới trong `main.js` gom thành **một khối liền mạch** có comment mốc `// ── AUTO PAGE ──` … `// ── /AUTO PAGE ──`, không rải `if (autoMode)` vào hàm cũ.

---

### Task 1: ~~Kết luận đường dẫn `.prproj`~~ — ĐÃ XONG (2026-08-25)

Probe đã chạy trên Premiere **25.6.5** và đã được xoá khỏi `plugin/main.js`.

**Kết quả — NHÁNH A:**

```
project.path → "/Users/.../Editing File/SonaShape.prproj"
project.name → "SonaShape.prproj"
```

Không có hàm getter nào (`getPath`, `getProjectPath`, …) tồn tại — chỉ thuộc tính
`path`. Nó là **string đồng bộ**, không phải Promise.

**Hệ quả đã kiểm chứng trên project thật:**
- `Voice Over` nằm **cùng cấp với file .prproj** → `dirname(project.path) + '/Voice Over'`.
- Thư mục sản phẩm nằm ba cấp trên file project, **không** dùng làm gốc.
- Project ở Google Drive shared drive: đường dẫn có khoảng trắng + dấu ngoặc.
- Tên file voice thật: `31.0 - Advertising Voice 2.mp3` = `{set}.{idx} - {tên voice}.{ext}`.

→ **Task 9 dùng nhánh A. Bỏ hẳn nhánh B.**

- [x] Đã xác minh, đã xoá probe, đã cập nhật spec.

---

### Task 2: Module đặt tên — pure logic, có test

Đây là chỗ sai một chữ là sai tên deliverable, nên làm TDD trước tiên.

**Files:**
- Create: `bridge/autoset-names.js`
- Test: `bridge/test/autoset-names.test.js`

- [ ] **Step 1: Viết test trước (đang fail)**

```javascript
// bridge/test/autoset-names.test.js
const assert = require('assert');
const { renderTemplate, buildSetNames } = require('../autoset-names.js');

const cfg = {
  product: 'SonaShape',
  co: 'ha.ttdo',
  editor: 'hoang.vietnguyen',
  seqNameTpl: '{sp} vid{set}.{idx} [c.{CO}] [{Editor}]',
  seqBinTpl:  'Sequence / FB / {set}x',
  voiceBinTpl:'voice over / {set}x',
};

// 1. renderTemplate thay đúng biến, giữ nguyên ký tự thật (ngoặc vuông, dấu cách, 'c.')
assert.strictEqual(
  renderTemplate(cfg.seqNameTpl, { sp: cfg.product, set: 31, idx: 0, CO: cfg.co, Editor: cfg.editor }),
  'SonaShape vid31.0 [c.ha.ttdo] [hoang.vietnguyen]',
  'tên sequence đúng từng ký tự'
);

// 2. biến không có giá trị → ném, KHÔNG để lọt '{sp}' vào tên file
assert.throws(
  () => renderTemplate('{sp} vid{set}.{idx}', { set: 1, idx: 0 }),
  /sp/,
  'thiếu biến thì phải ném, không đặt tên sai'
);

// 3. buildSetNames trả đủ 3 job
const out = buildSetNames(cfg, 31, 'mp3', 'Advertising Voice 2');
assert.strictEqual(out.length, 3, 'đúng 3 job');
assert.deepStrictEqual(out.map(j => j.idx), [0, 1, 2], 'idx 0,1,2');
assert.strictEqual(out[0].seqName, 'SonaShape vid31.0 [c.ha.ttdo] [hoang.vietnguyen]');
assert.strictEqual(out[2].seqName, 'SonaShape vid31.2 [c.ha.ttdo] [hoang.vietnguyen]');
assert.strictEqual(out[0].seqBin, 'Sequence / FB / 31x', 'bin sequence lồng cấp');
assert.strictEqual(out[1].voiceBin, 'voice over / 31x', 'bin voice');
assert.strictEqual(out[1].voiceFile, '31.1 - Advertising Voice 2.mp3', 'tên file voice có tên voice');
assert.strictEqual(out[0].voiceSubdir, '31x', 'thư mục con theo bộ');

// 4. số bộ dạng chuỗi vẫn chạy (ô input trả string)
assert.strictEqual(buildSetNames(cfg, '31', 'mp3', 'Evelyn3')[0].voiceFile, '31.0 - Evelyn3.mp3', 'set dạng string');

// 5. số bộ không hợp lệ → ném
assert.throws(() => buildSetNames(cfg, '', 'mp3', 'V'), /số bộ/i, 'set rỗng bị chặn');
assert.throws(() => buildSetNames(cfg, 'abc', 'mp3', 'V'), /số bộ/i, 'set không phải số bị chặn');

// 5b. tên voice có ký tự không hợp lệ cho tên file → làm sạch, không ném
assert.strictEqual(buildSetNames(cfg, 31, 'mp3', 'A/B:C')[0].voiceFile, '31.0 - A-B-C.mp3', 'ký tự / và : bị thay');
assert.throws(() => buildSetNames(cfg, 31, 'mp3', ''), /tên voice/i, 'thiếu tên voice bị chặn');

// 6. đuôi file đổi được
assert.strictEqual(buildSetNames(cfg, 31, 'wav', 'Evelyn3')[0].voiceFile, '31.0 - Evelyn3.wav', 'đuôi wav');

console.log('OK autoset-names');
```

- [ ] **Step 2: Chạy test để chắc chắn nó FAIL**

Run: `node bridge/test/autoset-names.test.js`
Expected: FAIL — `Cannot find module '../autoset-names.js'`

- [ ] **Step 3: Viết implementation tối thiểu**

```javascript
// bridge/autoset-names.js
// Dựng tên sequence / đường dẫn bin / tên file voice cho một bộ 3 video.
// Module THUẦN: không I/O, không Express → test trực tiếp bằng node + assert.

// Thay {biến} trong mẫu. Thiếu biến thì NÉM — thà lỗi rõ còn hơn đặt sai tên
// deliverable giao cho CO.
function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, function (_m, key) {
    if (vars[key] === undefined || vars[key] === null || vars[key] === '') {
      throw new Error('thiếu biến "' + key + '" khi dựng tên từ mẫu: ' + tpl);
    }
    return String(vars[key]);
  });
}

// Làm sạch tên voice để dùng trong tên file (giữ khoảng trắng — tên thật có
// khoảng trắng: "31.0 - Advertising Voice 2.mp3").
function safeVoiceName(name) {
  var n = String(name || '').trim();
  if (!n) throw new Error('thiếu tên voice');
  return n.replace(/[\/\\:*?"<>|]/g, '-');
}

function buildSetNames(cfg, setNumber, ext, voiceName) {
  var set = String(setNumber).trim();
  if (!/^\d+$/.test(set)) throw new Error('số bộ không hợp lệ: "' + setNumber + '"');
  var e = (ext || 'mp3').replace(/^\./, '');
  var vn = safeVoiceName(voiceName);

  var jobs = [];
  for (var idx = 0; idx < 3; idx++) {
    var vars = { sp: cfg.product, set: set, idx: idx, CO: cfg.co, Editor: cfg.editor };
    jobs.push({
      idx: idx,
      seqName:     renderTemplate(cfg.seqNameTpl, vars),
      seqBin:      renderTemplate(cfg.seqBinTpl, vars),
      voiceBin:    renderTemplate(cfg.voiceBinTpl, vars),
      voiceSubdir: set + 'x',
      voiceFile:   set + '.' + idx + ' - ' + vn + '.' + e,
    });
  }
  return jobs;
}

module.exports = { renderTemplate, safeVoiceName, buildSetNames };
```

- [ ] **Step 4: Chạy test để xác nhận PASS**

Run: `node bridge/test/autoset-names.test.js`
Expected: `OK autoset-names`

- [ ] **Step 5: Commit**

```bash
git add bridge/autoset-names.js bridge/test/autoset-names.test.js
git commit -m "feat(bridge): module dựng tên sequence/bin/voice cho bộ 3 video"
```

---

### Task 3: Endpoint `POST /notify` — thông báo macOS

**Files:**
- Modify: `bridge/server.js`
- Test: `bridge/test/notify.test.js`

- [ ] **Step 1: Viết test trước (đang fail)**

```javascript
// bridge/test/notify.test.js
const assert = require('assert');
const { buildNotifyScript } = require('../server.js');

// 1. dựng đúng lệnh osascript
const s = buildNotifyScript('Xong', 'Bộ 31 đã dựng');
assert.ok(s.includes('display notification'), 'có display notification');
assert.ok(s.includes('"Bộ 31 đã dựng"'), 'có body');
assert.ok(s.includes('with title "Xong"'), 'có title');

// 2. dấu " và \ trong nội dung phải được escape, không làm vỡ script
const s2 = buildNotifyScript('A"B', 'C\\D"E');
assert.ok(!/[^\\]"[^\s)]/.test(s2.replace(/with title|display notification/g, '')) || true);
assert.ok(s2.includes('A\\"B'), 'escape dấu " trong title');
assert.ok(s2.includes('C\\\\D\\"E'), 'escape \\ và " trong body');

// 3. thiếu title → dùng mặc định, không ném
assert.ok(buildNotifyScript('', 'x').includes('with title "Claude AI"'), 'title mặc định');

// 4. cắt bớt nội dung quá dài (osascript giới hạn thực tế)
const long = 'x'.repeat(1000);
assert.ok(buildNotifyScript('t', long).length < 700, 'body bị cắt');

console.log('OK buildNotifyScript');
```

- [ ] **Step 2: Chạy test để chắc chắn nó FAIL**

Run: `node bridge/test/notify.test.js`
Expected: FAIL — `buildNotifyScript is not a function`

- [ ] **Step 3: Thêm hàm + endpoint vào `bridge/server.js`**

Chèn ngay **trước** dòng `app.post('/host-key'` (khu vực các endpoint hệ thống):

```javascript
// ── POST /notify — thông báo macOS khi pipeline chạm mốc ────────────────────
// Dùng chung khuôn execFile + osascript với /host-key.
function esc(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
function buildNotifyScript(title, body) {
  var t = esc(title || 'Claude AI').slice(0, 120);
  var b = esc(body || '').slice(0, 400);
  return 'display notification "' + b + '" with title "' + t + '"';
}

app.post('/notify', (req, res) => {
  const { title, body } = req.body || {};
  const script = buildNotifyScript(title, body);
  const { execFile } = require('child_process');
  execFile('osascript', ['-e', script], { timeout: 8000 }, (err, _o, stderr) => {
    if (err) return res.status(500).json({ ok: false, error: (stderr || err.message || '').trim() });
    res.json({ ok: true });
  });
});
```

Thêm `buildNotifyScript` vào `module.exports` ở cuối `server.js` (giữ nguyên các export đang có, ví dụ `buildMultipartBody`).

- [ ] **Step 4: Chạy test để xác nhận PASS**

Run: `node bridge/test/notify.test.js`
Expected: `OK buildNotifyScript`

- [ ] **Step 5: Kiểm chứng thật (thông báo hiện trên máy)**

```bash
curl -s -X POST http://localhost:3030/notify -H "Content-Type: application/json" \
  -d '{"title":"Claude AI","body":"Thử thông báo"}'
```
Expected: `{"ok":true}` và **thấy thông báo hiện ở góc phải màn hình**. Không thấy → mở System Settings › Notifications, bật cho `osascript`/Script Editor.

- [ ] **Step 6: Commit**

```bash
git add bridge/server.js bridge/test/notify.test.js
git commit -m "feat(bridge): POST /notify — thông báo macOS qua osascript"
```

---

### Task 4: Endpoint `POST /autoset/names`

**Files:**
- Modify: `bridge/server.js`

- [ ] **Step 1: Thêm endpoint**

Chèn ngay sau endpoint `/notify` vừa thêm:

```javascript
// ── POST /autoset/names — dựng tên cho cả bộ 3 video ───────────────────────
const autosetNames = require('./autoset-names.js');

app.post('/autoset/names', (req, res) => {
  try {
    const { config, setNumber, ext, voiceName } = req.body || {};
    if (!config) return res.status(400).json({ ok: false, error: 'thiếu config' });
    const jobs = autosetNames.buildSetNames(config, setNumber, ext, voiceName);
    res.json({ ok: true, jobs });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});
```

- [ ] **Step 2: Khởi động lại bridge và kiểm chứng**

```bash
curl -s -X POST http://localhost:3030/autoset/names -H "Content-Type: application/json" -d '{"setNumber":31,"ext":"mp3","voiceName":"Advertising Voice 2","config":{"product":"SonaShape","co":"ha.ttdo","editor":"hoang.vietnguyen","seqNameTpl":"{sp} vid{set}.{idx} [c.{CO}] [{Editor}]","seqBinTpl":"Sequence / FB / {set}x","voiceBinTpl":"Voice Over / {set}x"}}'
```
Expected: JSON có `jobs[0].seqName` = `SonaShape vid31.0 [c.ha.ttdo] [hoang.vietnguyen]`

- [ ] **Step 3: Kiểm chứng lỗi được báo tử tế**

```bash
curl -s -X POST http://localhost:3030/autoset/names -H "Content-Type: application/json" -d '{"setNumber":"abc","config":{"product":"X","co":"y","editor":"z","seqNameTpl":"{sp}{set}{idx}","seqBinTpl":"{set}","voiceBinTpl":"{set}"}}'
```
Expected: HTTP 400, `{"ok":false,"error":"số bộ không hợp lệ: \"abc\""}`

- [ ] **Step 4: Commit**

```bash
git add bridge/server.js
git commit -m "feat(bridge): POST /autoset/names dựng tên cả bộ"
```

---

### Task 5: Khung trang Auto (nút + overlay + 3 tab)

Chưa có logic chạy — chỉ mở/đóng được và chuyển tab.

**Files:**
- Modify: `plugin/index.html`
- Modify: `plugin/main.js`
- Modify: `plugin/styles.css`

- [ ] **Step 1: Thêm nút Auto vào footer bảng script**

Trong `plugin/index.html`, trong `<div id="sacTableFooter">` (khoảng dòng 1005), thêm **sau** `#sacPreviewBtn`:

```html
<div id="sacAutoBtn" class="sac-previewBtn" role="button"><span data-ic="bolt" data-ic-size="12"></span> Auto</div>
```

- [ ] **Step 2: Thêm markup trang Auto**

Trong `plugin/index.html`, thêm ngay **trước** thẻ đóng của `<div class="sac-panel" id="sacPanelManual">`… — thực tế đặt cùng cấp với `#sacNewSeqModal` (tìm `id="sacNewSeqModal"` và chèn khối này ngay trước nó):

```html
<div id="sacAutoPage" class="sac-autoPage" hidden>
  <div class="sac-autoHeader">
    <span class="sac-autoTitle">Auto — bộ 3 video</span>
    <div id="sacAutoClose" class="sac-autoClose" role="button"><span data-ic="xmark" data-ic-size="13"></span></div>
  </div>

  <div class="sac-autoCfg">
    <label class="sac-autoLbl">Sản phẩm <input id="sacAutoProduct" class="sac-autoInp" type="text" /></label>
    <label class="sac-autoLbl">CO <input id="sacAutoCO" class="sac-autoInp" type="text" /></label>
    <label class="sac-autoLbl">Editor <input id="sacAutoEditor" class="sac-autoInp" type="text" /></label>
    <label class="sac-autoLbl">Số bộ <input id="sacAutoSet" class="sac-autoInp" type="text" /></label>
    <label class="sac-autoLbl">Bin sequence <input id="sacAutoSeqBin" class="sac-autoInp" type="text" /></label>
    <label class="sac-autoLbl">Ratio
      <select id="sacAutoRatio" class="sac-autoInp">
        <option value="1080x1920" selected>1080×1920 — 9:16</option>
        <option value="1080x1350">1080×1350 — 4:5</option>
        <option value="1080x1080">1080×1080 — 1:1</option>
        <option value="1920x1080">1920×1080 — 16:9</option>
        <option value="match">Match source clips</option>
      </select>
    </label>
    <label class="sac-autoLbl">Voice <select id="sacAutoVoice" class="sac-autoInp"></select></label>
    <label class="sac-autoChk"><input type="checkbox" id="sacAutoSkipAudition" /> Bỏ qua nghe thử</label>
  </div>

  <div id="sacAutoPreview" class="sac-autoPreview"></div>

  <div class="sac-autoTabs">
    <div class="sac-autoTab is-active" data-job="0" role="button">.0</div>
    <div class="sac-autoTab" data-job="1" role="button">.1</div>
    <div class="sac-autoTab" data-job="2" role="button">.2</div>
  </div>

  <textarea id="sacAutoTsv" class="sac-autoTsv" spellcheck="false"
    placeholder="Dán TSV từ Sheets cho video đang chọn (script / time / source)"></textarea>

  <div id="sacAutoStatus" class="sac-autoStatus"></div>
  <div id="sacAutoRun" class="sac-autoRun" role="button"><span data-ic="bolt" data-ic-size="13"></span> Chạy cả bộ</div>
</div>
```

- [ ] **Step 3: Thêm style**

Cuối `plugin/styles.css`. Không dùng `position:fixed`, `z-index`, `display:grid` (UXP không hỗ trợ):

```css
/* ── AUTO PAGE ── */
.sac-autoPage { display: flex; flex-direction: column; gap: 8px; padding: 10px; }
.sac-autoHeader { display: flex; align-items: center; justify-content: space-between; }
.sac-autoTitle { font-weight: 600; font-size: 13px; color: #e9d5ff; }
.sac-autoClose { padding: 2px 6px; cursor: pointer; }
.sac-autoCfg { display: flex; flex-direction: column; gap: 6px; }
.sac-autoLbl { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: #cbd5e1; }
.sac-autoInp { width: 60%; }
.sac-autoChk { font-size: 11px; color: #cbd5e1; }
.sac-autoPreview { font-size: 10px; color: #94a3b8; line-height: 1.5; }
.sac-autoTabs { display: flex; gap: 4px; }
.sac-autoTab { padding: 3px 12px; border-radius: 4px; background: #1e1b2e; color: #94a3b8; font-size: 12px; cursor: pointer; }
.sac-autoTab.is-active { background: #7c3aed; color: #fff; }
.sac-autoTsv { flex: 1 1 0; min-height: 120px; overflow-y: auto; font-family: monospace; font-size: 11px; }
.sac-autoStatus { font-size: 11px; color: #94a3b8; min-height: 16px; }
.sac-autoRun { padding: 6px; text-align: center; border-radius: 4px; background: #7c3aed; color: #fff; font-size: 12px; cursor: pointer; }
/* ── /AUTO PAGE ── */
```

- [ ] **Step 4: Wiring mở/đóng + chuyển tab**

Trong `plugin/main.js`, thêm khối này **trong cùng scope với `sacOpenNewSeqModal`** (tức cùng IIFE của tab Autocut), đặt ngay sau hàm `sacCloseNewSeqModal`:

```javascript
// ── AUTO PAGE ──────────────────────────────────────────────────────────────
// Trang riêng cho bộ 3 video. Tách khỏi workflow Autocut hiện tại: chỉ ẩn/hiện
// .sac-app như modal New-seq, không sửa hàm cũ.
var AUTO_CFG_KEY = 'sac_auto_cfg';       // cấu hình theo project
var AUTO_SET_KEY = 'sac_auto_set';       // 3 job đang soạn

var autoSet = { setNumber: '', ratio: '1080x1920', voiceId: '', skipAudition: false,
                jobs: [{ tsv: '' }, { tsv: '' }, { tsv: '' }] };
var autoActiveJob = 0;

function autoLoadState() {
  try {
    var c = JSON.parse(localStorage.getItem(AUTO_CFG_KEY) || '{}');
    if (c.product) $('sacAutoProduct').value = c.product;
    if (c.co)      $('sacAutoCO').value     = c.co;
    if (c.editor)  $('sacAutoEditor').value = c.editor;
    // Mẫu bin sửa được: đổi nền tảng (FB → TT) chỉ cần sửa ô này, không sửa code.
    $('sacAutoSeqBin').value = c.seqBinTpl || 'Sequence / FB / {set}x';
  } catch (e) {}
  try {
    var s = JSON.parse(localStorage.getItem(AUTO_SET_KEY) || 'null');
    if (s && Array.isArray(s.jobs) && s.jobs.length === 3) autoSet = s;
  } catch (e) {}
  $('sacAutoSet').value = autoSet.setNumber || '';
  $('sacAutoRatio').value = autoSet.ratio || '1080x1920';
  $('sacAutoSkipAudition').checked = !!autoSet.skipAudition;
  autoRenderTab();
}

function autoSaveState() {
  try {
    localStorage.setItem(AUTO_CFG_KEY, JSON.stringify({
      product: $('sacAutoProduct').value.trim(),
      co:      $('sacAutoCO').value.trim(),
      editor:  $('sacAutoEditor').value.trim(),
      seqBinTpl: $('sacAutoSeqBin').value.trim() || 'Sequence / FB / {set}x',
    }));
    autoSet.setNumber   = $('sacAutoSet').value.trim();
    autoSet.ratio       = $('sacAutoRatio').value;
    autoSet.voiceId     = $('sacAutoVoice').value;
    autoSet.skipAudition= $('sacAutoSkipAudition').checked;
    localStorage.setItem(AUTO_SET_KEY, JSON.stringify(autoSet));
  } catch (e) {}
}

function autoRenderTab() {
  document.querySelectorAll('.sac-autoTab').forEach(function (t) {
    t.classList.toggle('is-active', Number(t.dataset.job) === autoActiveJob);
  });
  $('sacAutoTsv').value = autoSet.jobs[autoActiveJob].tsv || '';
}

function autoFillVoices() {
  var sel = $('sacAutoVoice');
  if (!sel) return;
  sel.innerHTML = '';
  (VG_VOICES_DATA || []).forEach(function (v) {
    if (v.isSep) return;
    var o = document.createElement('option');
    o.value = v.voice_id; o.textContent = v.label;
    sel.appendChild(o);
  });
  if (autoSet.voiceId) sel.value = autoSet.voiceId;
}

function autoOpen() {
  var app = document.querySelector('#tab-autocut .sac-app');
  if (app) app.style.display = 'none';
  $('sacAutoPage').hidden = false;
  autoFillVoices();
  autoLoadState();
  if (window.claimKeyboard) window.claimKeyboard();
}

function autoClose() {
  autoSaveState();
  $('sacAutoPage').hidden = true;
  var app = document.querySelector('#tab-autocut .sac-app');
  if (app) app.style.display = '';
  if (window.releaseKeyboard) window.releaseKeyboard();
}

var sacAutoBtn = $('sacAutoBtn');
if (sacAutoBtn) sacAutoBtn.addEventListener('click', autoOpen);
var sacAutoCloseBtn = $('sacAutoClose');
if (sacAutoCloseBtn) sacAutoCloseBtn.addEventListener('click', autoClose);

document.querySelectorAll('.sac-autoTab').forEach(function (t) {
  t.addEventListener('click', function () {
    autoSet.jobs[autoActiveJob].tsv = $('sacAutoTsv').value;   // lưu tab đang rời
    autoActiveJob = Number(t.dataset.job);
    autoRenderTab();
    autoSaveState();
  });
});

var autoTsvEl = $('sacAutoTsv');
if (autoTsvEl) {
  autoTsvEl.addEventListener('focus', function () { if (window.claimKeyboard) window.claimKeyboard(); });
  autoTsvEl.addEventListener('blur',  function () {
    autoSet.jobs[autoActiveJob].tsv = autoTsvEl.value;
    autoSaveState();
    if (window.releaseKeyboard) window.releaseKeyboard();
  });
}

['sacAutoProduct','sacAutoCO','sacAutoEditor','sacAutoSet','sacAutoSeqBin'].forEach(function (id) {
  var el = $(id);
  if (!el) return;
  el.addEventListener('focus', function () { if (window.claimKeyboard) window.claimKeyboard(); });
  el.addEventListener('blur',  function () { autoSaveState(); if (window.releaseKeyboard) window.releaseKeyboard(); });
});
// ── /AUTO PAGE ──
```

- [ ] **Step 5: Nạp và kiểm chứng bằng tay trong Premiere**

```bash
./reload.sh
```

Trong Premiere: đóng/mở panel Claude AI → tab Autocut → bấm **Auto**.

Kỳ vọng:
1. Trang Auto hiện, bảng script cũ bị ẩn.
2. Điền Sản phẩm/CO/Editor/Số bộ, dropdown Voice có danh sách voice.
3. Bấm `.1` → ô TSV trống; dán chữ vào; bấm `.0` rồi `.1` → nội dung mỗi tab giữ đúng.
4. Bấm ✕ → trang đóng, **bảng script cũ hiện lại nguyên vẹn**.
5. Đóng/mở lại panel → Sản phẩm/CO/Editor/Số bộ và nội dung 3 tab còn nguyên.
6. Gõ chữ `b`, `v`, `c` vào ô TSV → chữ vào ô, **Premiere không nhảy tool** (kiểm tra claimKeyboard).

- [ ] **Step 6: Commit**

```bash
git add plugin/index.html plugin/main.js plugin/styles.css
git commit -m "feat(auto): khung trang Auto — nút, overlay, 3 tab, lưu trạng thái"
```

---

### Task 6: Xem trước tên sinh ra (bắt lỗi cấu hình sớm)

Hiện tên sẽ dùng ngay trên trang, trước khi chạy — để sai cấu hình bị phát hiện trước khi tạo sequence.

**Files:**
- Modify: `plugin/main.js`

- [ ] **Step 1: Thêm hàm gọi `/autoset/names` + hiển thị**

Thêm vào trong khối `// ── AUTO PAGE ──`, ngay trước dòng `var sacAutoBtn = $('sacAutoBtn');`:

```javascript
// Label voice đang chọn — vào tên file: "31.0 - Advertising Voice 2.mp3".
function autoVoiceLabel() {
  var sel = $('sacAutoVoice');
  if (!sel || !sel.value) return '';
  var opt = sel.options[sel.selectedIndex];
  return (opt && opt.textContent) || '';
}

function autoBuildCfg() {
  return {
    product:     $('sacAutoProduct').value.trim(),
    co:          $('sacAutoCO').value.trim(),
    editor:      $('sacAutoEditor').value.trim(),
    seqNameTpl:  '{sp} vid{set}.{idx} [c.{CO}] [{Editor}]',
    seqBinTpl:   $('sacAutoSeqBin').value.trim() || 'Sequence / FB / {set}x',
    voiceBinTpl: 'Voice Over / {set}x',
  };
}

// Trả về mảng 3 job có seqName/seqBin/voiceBin/voiceFile, hoặc null nếu lỗi.
async function autoFetchNames() {
  var res = await fetch(BRIDGE_URL + '/autoset/names', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: autoBuildCfg(), setNumber: $('sacAutoSet').value.trim(),
                           ext: 'mp3', voiceName: autoVoiceLabel() }),
  });
  var j = await res.json();
  if (!j || !j.ok) throw new Error((j && j.error) || 'không dựng được tên');
  return j.jobs;
}

async function autoRenderPreview() {
  var box = $('sacAutoPreview');
  if (!box) return;
  try {
    var jobs = await autoFetchNames();
    box.textContent = jobs.map(function (j) { return '• ' + j.seqName + '  →  ' + j.seqBin; }).join('\n')
      + '\n• voice: ' + jobs[0].voiceBin + '/' + jobs[0].voiceFile;
    box.style.color = '#94a3b8';
  } catch (e) {
    box.textContent = '✗ ' + e.message;
    box.style.color = '#f87171';
  }
}
```

- [ ] **Step 2: Gọi preview khi cấu hình đổi**

Trong cùng khối, sửa vòng lặp bind blur đã viết ở Task 5 thành:

```javascript
['sacAutoProduct','sacAutoCO','sacAutoEditor','sacAutoSet','sacAutoSeqBin'].forEach(function (id) {
  var el = $(id);
  if (!el) return;
  el.addEventListener('focus', function () { if (window.claimKeyboard) window.claimKeyboard(); });
  el.addEventListener('blur',  function () {
    autoSaveState();
    autoRenderPreview();
    if (window.releaseKeyboard) window.releaseKeyboard();
  });
});
```

Và thêm `autoRenderPreview();` vào cuối hàm `autoOpen()`.

- [ ] **Step 3: Kiểm chứng bằng tay**

```bash
./reload.sh
```

Trong Premiere, mở trang Auto, điền `SonaShape` / `ha.ttdo` / `hoang.vietnguyen` / `31`, rời ô.

Kỳ vọng thấy đúng ba dòng:
```
• SonaShape vid31.0 [c.ha.ttdo] [hoang.vietnguyen]  →  Sequence / FB / 31x
• SonaShape vid31.1 [c.ha.ttdo] [hoang.vietnguyen]  →  Sequence / FB / 31x
• SonaShape vid31.2 [c.ha.ttdo] [hoang.vietnguyen]  →  Sequence / FB / 31x
• voice: voice over / 31x/31.0.mp3
```

Xoá ô Số bộ → rời ô → thấy dòng đỏ `✗ số bộ không hợp lệ: ""`.

Sửa ô **Bin sequence** thành `Sequence / TT / {set}x` → rời ô → preview đổi sang
`Sequence / TT / 31x`. Đây là bằng chứng nền tảng đổi được **không cần sửa code**.

- [ ] **Step 4: Commit**

```bash
git add plugin/main.js
git commit -m "feat(auto): xem trước tên sequence/bin trước khi chạy"
```

---

### Task 7: `sacJobContext` — đổi ngữ cảnh giữa 3 job

Bảng script, `parsedBlocks` và state voice là biến toàn cục dùng chung. Đây là lớp duy nhất được phép chạm vào chúng.

**Files:**
- Modify: `plugin/main.js`

- [ ] **Step 1: Xác nhận tên biến toàn cục thật trước khi viết**

```bash
grep -n "var parsedBlocks\|var sacVP\b\|rowSeq = 0" plugin/main.js | head
```

Ghi lại tên chính xác. Nếu khác `parsedBlocks` / `sacVP` / `rowSeq`, dùng tên thật ở Step 2 — **không đoán**.

- [ ] **Step 2: Viết lớp đổi ngữ cảnh**

Thêm vào khối `// ── AUTO PAGE ──`:

```javascript
// Bảng script + blocks + voice là state TOÀN CỤC dùng chung một bảng DOM.
// Lớp này là chỗ DUY NHẤT được nạp/lưu state đó cho từng job.
var sacJobContext = {
  // Lưu state hiện tại của bảng vào job.
  save: function (job) {
    job._rowsSnapshot = [];
    document.querySelectorAll('#sacBody .sac-row').forEach(function (row) {
      var inps = row.querySelectorAll('input');
      var cells = ['', '', ''];
      for (var d = 0; d < 3 && d < inps.length; d++) {
        cells[SAC_SEM[SAC_COL_ORDER[d]]] = inps[d].value || '';
      }
      job._rowsSnapshot.push(cells);
    });
    job._blocks = parsedBlocks;
  },
  // Nạp rows của job vào bảng, dọn state của job trước.
  load: function (job) {
    $('sacBody').innerHTML = '';
    rowSeq = 0;
    (job.rows || []).forEach(function (c) {
      createRow((c[0] || '').trim(), (c[1] || '').trim(), (c[2] || '').trim());
    });
    parsedBlocks = job._blocks || [];
  },
};

// TSV của job → rows [[text,time,src], ...] qua đúng đường manual paste.
function autoTsvToRows(tsv) {
  var parsed = parseTSV(tsv).map(function (cols) {
    var o = ['', '', ''];
    for (var d = 0; d < 3; d++) o[SAC_SEM[SAC_COL_ORDER[d]]] = cols[d] || '';
    return o;
  });
  return expandRows(parsed);
}
```

- [ ] **Step 3: Kiểm chứng `autoTsvToRows` cho kết quả GIỐNG manual paste**

Đây là phép so sánh quan trọng nhất của task này. Trong Premiere:

1. Mở tab Autocut (workflow cũ), dán TSV mẫu vào **cột ngoài cùng bên trái** của bảng, trong đó có **một dòng chứa 2 timestamp** và **một dòng để trống ô source** (để thử kế thừa merge). Đếm số dòng bảng tạo ra và ghi lại nội dung.
2. Mở trang Auto, dán **đúng TSV đó** vào tab `.0`.
3. Mở UXP Developer Tool › Console, chạy:

```javascript
autoTsvToRows(document.getElementById('sacAutoTsv').value).length
```

Expected: **bằng đúng số dòng** bảng cũ tạo ra ở bước 1. Lệch nhau → `SAC_COL_ORDER` remap sai, sửa trước khi đi tiếp.

- [ ] **Step 4: Commit**

```bash
git add plugin/main.js
git commit -m "feat(auto): sacJobContext + chuyển TSV sang rows dùng expandRows"
```

---

### Task 8: Chặng 1 — validate cả 3 job

**Files:**
- Modify: `plugin/main.js`

- [ ] **Step 1: Xác nhận cách gọi validate hiện tại**

```bash
sed -n '4700,4760p' plugin/main.js
```

Ghi lại: tên hàm bọc validate, payload gửi lên `/superautocut/validate`, và biến nhận kết quả blocks. Dùng đúng những tên đó ở Step 2.

- [ ] **Step 2: Viết vòng validate + thông báo**

Thêm vào khối `// ── AUTO PAGE ──`:

```javascript
function autoNotify(title, body) {
  try {
    fetch(BRIDGE_URL + '/notify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title, body: body }),
    });
  } catch (e) {}
}

function autoStatus(msg) { var el = $('sacAutoStatus'); if (el) el.textContent = msg; }

// Chặng 1: dựng rows + validate từng job. Job lỗi bị đánh dấu, KHÔNG chặn job khác.
async function autoStage1(jobs) {
  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    autoStatus('⏳ Validate .' + job.idx + '…');
    try {
      job.rows = autoTsvToRows(autoSet.jobs[job.idx].tsv || '');
      if (!job.rows.length) throw new Error('chưa dán TSV');
      sacJobContext.load(job);
      await sacAutoValidate();          // ← tên hàm validate thật, xác nhận ở Step 1
      sacJobContext.save(job);
      job.state = 'validated';
    } catch (e) {
      job.state = 'error';
      job.error = e.message;
    }
  }
  var bad = jobs.filter(function (j) { return j.state === 'error'; });
  if (bad.length) {
    var msg = bad.map(function (j) { return '.' + j.idx + ': ' + j.error; }).join(' · ');
    autoStatus('✗ ' + msg);
    autoNotify('Autocut — validate lỗi', msg);
  } else {
    autoStatus('✓ Validate 3/3 xong');
  }
  return jobs.filter(function (j) { return j.state === 'validated'; });
}
```

- [ ] **Step 3: Nối vào nút Chạy cả bộ (tạm dừng sau chặng 1)**

```javascript
var sacAutoRunBtn = $('sacAutoRun');
if (sacAutoRunBtn) sacAutoRunBtn.addEventListener('click', async function () {
  autoSet.jobs[autoActiveJob].tsv = $('sacAutoTsv').value;
  autoSaveState();
  try {
    var jobs = await autoFetchNames();
    var ok = await autoStage1(jobs);
    autoStatus(autoStatus_text(ok));
  } catch (e) {
    autoStatus('✗ ' + e.message);
    autoNotify('Autocut — lỗi', e.message);
  }
});
function autoStatus_text(ok) { return '✓ ' + ok.length + '/3 job sẵn sàng gen voice'; }
```

- [ ] **Step 4: Kiểm chứng bằng tay**

```bash
./reload.sh
```

Trong Premiere, mở project có media khớp, điền cấu hình, dán TSV vào cả 3 tab (**cố tình để tab `.1` tham chiếu clip không tồn tại**), bấm **Chạy cả bộ**.

Kỳ vọng:
1. Status chạy qua `.0`, `.1`, `.2`.
2. Cuối cùng báo lỗi **chỉ của `.1`**, và `.0`/`.2` vẫn được tính là sẵn sàng (`2/3`).
3. **Có thông báo macOS** về lỗi validate.

- [ ] **Step 5: Commit**

```bash
git add plugin/main.js
git commit -m "feat(auto): chặng 1 — validate 3 job, lỗi không chặn nhau"
```

---

### Task 9: Chặng 2 — gen voice, lưu đúng chỗ, nạp vào bin

**Nhánh phụ thuộc Task 1.** Nếu Task 1 kết luận **nhánh B**, dùng biến thể ở Step 2b.

**Files:**
- Modify: `plugin/main.js`

- [ ] **Step 1: Xác nhận biến giữ kết quả gen voice**

```bash
grep -n "lastVariations" plugin/main.js | head -5
```

Ghi lại cách lấy `audioPath` của bản vừa gen.

- [ ] **Step 2: Lấy thư mục chứa file project**

Task 1 đã xác minh `project.path` là **string đồng bộ** chứa đường dẫn `.prproj`.

```javascript
// Thư mục chứa .prproj — Voice Over nằm CÙNG CẤP với file này (đã kiểm chứng).
async function autoProjectDir() {
  var proj = await getActiveProject();
  var p = String(proj.path || '');
  if (!p) throw new Error('project chưa được lưu — hãy lưu project trước khi chạy Auto');
  var cut = p.lastIndexOf('/');
  if (cut < 0) throw new Error('đường dẫn project lạ: ' + p);
  return p.slice(0, cut);
}
```

- [ ] **Step 3: Viết chặng 2**

```javascript
// Dò thư mục voice over dưới gốc sản phẩm (chấp nhận biến thể tên), tạo nếu thiếu.
async function autoVoiceDir(root, subdir) {  // root = thư mục chứa .prproj
  var fs = require('uxp').storage.localFileSystem;
  var rootEntry = await fs.getEntryWithUrl('file://' + root);
  var entries = await rootEntry.getEntries();
  var vo = null;
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].isFolder && /^(voice\s*over|voiceover|vo)$/i.test(entries[i].name)) { vo = entries[i]; break; }
  }
  if (!vo) vo = await rootEntry.createFolder('Voice Over');
  var subs = await vo.getEntries();
  for (var k = 0; k < subs.length; k++) {
    if (subs[k].isFolder && subs[k].name === subdir) return subs[k].nativePath;
  }
  var made = await vo.createFolder(subdir);
  return made.nativePath;
}

// Chặng 2: normalize → gen voice → move về đúng path → nạp vào bin.
async function autoStage2(jobs) {
  var root = await autoProjectDir();
  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    autoStatus('⏳ Gen voice .' + job.idx + '…');
    try {
      var scriptText = (job.rows || []).map(function (r) { return r[0]; }).filter(Boolean).join('\n');
      if (!scriptText) throw new Error('không có lời đọc');

      // Gen ngầm ở tab Voice Gen (switchTab = false để không nhảy tab).
      VoiceGenPushScript(scriptText, autoSet.voiceId, true, false);
      var got = await autoWaitVariation();

      var dir = await autoVoiceDir(root, job.voiceSubdir);
      var mv = await fetch(BRIDGE_URL + '/tts/move', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: got.audioPath, targetDir: dir,
                               targetName: job.voiceFile, noOverwrite: true }),
      }).then(function (r) { return r.json(); });
      if (!mv || !mv.ok) throw new Error((mv && mv.error) || 'move file thất bại');

      job.voicePath = mv.targetPath;
      job.state = 'voiced';
    } catch (e) {
      job.state = 'error';
      job.error = e.message;
    }
  }
  var ok = jobs.filter(function (j) { return j.state === 'voiced'; });
  autoStatus('✓ Voice ' + ok.length + '/' + jobs.length + ' xong');
  autoNotify('Voice xong', ok.length + '/' + jobs.length + ' bản — chờ duyệt');
  return ok;
}

// Chờ Voice Gen đẩy ra bản mới. Không có callback nên phải poll lastVariations.
function autoWaitVariation() {
  var before = (lastVariations && lastVariations[0] && lastVariations[0].audioPath) || '';
  return new Promise(function (resolve, reject) {
    var waited = 0;
    var t = setInterval(function () {
      waited += 500;
      var v = lastVariations && lastVariations[0];
      if (v && v.audioPath && v.audioPath !== before) { clearInterval(t); resolve(v); return; }
      if (waited > 180000) { clearInterval(t); reject(new Error('gen voice quá 3 phút')); }
    }, 500);
  });
}
```

- [ ] **Step 4: Nối chặng 2 vào nút Chạy**

Trong handler của `#sacAutoRun`, thay `autoStatus(autoStatus_text(ok));` bằng:

```javascript
    if (!ok.length) return;
    var voiced = await autoStage2(ok);
    if (!voiced.length) return;
```

- [ ] **Step 5: Kiểm chứng bằng tay**

```bash
./reload.sh
```

Chạy với 3 tab TSV hợp lệ. Kỳ vọng:
1. Voice gen chạy lần lượt 3 lần, **panel không nhảy sang tab Voice Gen**.
2. Mở Finder tại thư mục chứa `.prproj`: có `Voice Over/32x/32.0 - <tên voice>.mp3`, `32.1 - …`, `32.2 - …` — **đúng tên, đúng thư mục**. (Dùng bộ 32 vì `31x` đã tồn tại trên Drive.)
3. Có thông báo macOS "Voice xong 3/3".
4. Chạy lại lần nữa với cùng số bộ → `noOverwrite` chặn, báo lỗi rõ ràng chứ **không ghi đè** file cũ.
5. Thử với project chưa lưu → báo `project chưa được lưu`, không tạo gì.

- [ ] **Step 6: Commit**

```bash
git add plugin/main.js
git commit -m "feat(auto): chặng 2 — gen voice 3 job, lưu đúng voice over/{bộ}x"
```

---

### Task 10: Chặng 3 — align, dựng timeline, đặt sequence vào bin

**Files:**
- Modify: `plugin/main.js`

- [ ] **Step 1: Viết chặng 3**

```javascript
// Chặng 3: align voice + dựng timeline + chuyển sequence vào bin.
// sacRunAutoCut('new') ĐỌC TÊN/RATIO TỪ DOM → phải ghi vào 2 input trước khi gọi.
async function autoStage3(jobs) {
  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    autoStatus('⏳ Dựng .' + job.idx + '…');
    try {
      sacJobContext.load(job);
      AutocutPushVoice(job.voicePath);
      await autoWaitAlign();

      $('sacNewSeqName').value  = job.seqName;
      $('sacNewSeqRatio').value = autoSet.ratio;
      await sacRunAutoCut('new');

      await autoMoveSeqToBin(job.seqName, job.seqBin);
      job.state = 'built';
    } catch (e) {
      job.state = 'error';
      job.error = e.message;
    }
  }
  var ok = jobs.filter(function (j) { return j.state === 'built'; });
  var msg = 'Bộ ' + autoSet.setNumber + ': ' + ok.length + '/' + jobs.length + ' timeline xong';
  autoStatus('✓ ' + msg);
  autoNotify('Autocut xong', msg);
}

// Chờ sacAlignVoice xong. Dò qua badge thời lượng voice mà align điền vào.
function autoWaitAlign() {
  return new Promise(function (resolve, reject) {
    var waited = 0;
    var t = setInterval(function () {
      waited += 500;
      var info = $('sacVoiceInfo');
      if (info && !/Chưa có voice/.test(info.textContent || '')) { clearInterval(t); resolve(); return; }
      if (waited > 120000) { clearInterval(t); reject(new Error('align voice quá 2 phút')); }
    }, 500);
  });
}

// Chuyển sequence vừa tạo vào bin. ppGetOrCreateBin đã hỗ trợ 'A / B / C'.
async function autoMoveSeqToBin(seqName, binPath) {
  var proj = await getActiveProject();
  var bin = await ppGetOrCreateBin(proj, binPath);
  if (!bin) throw new Error('không tạo được bin ' + binPath);
  var all = await sacWalkProject(proj);        // ← xác nhận tên hàm walk ở Step 2
  var hit = all.filter(function (it) { return it.name === seqName; })[0];
  if (!hit) throw new Error('không tìm thấy sequence ' + seqName);
  await ppMoveToBin(proj, hit.item, binPath);
}
```

- [ ] **Step 2: Xác nhận tên hàm walk project và chữ ký `ppMoveToBin`**

```bash
grep -n "ppMoveToBin\s*=\|function ppMoveToBin\|async function sacWalk\|sacAllProjectItems" plugin/main.js | head
```

Sửa `sacWalkProject` và lời gọi `ppMoveToBin` ở Step 1 cho khớp chữ ký thật. **Không đoán tham số.**

- [ ] **Step 3: Nối chặng 3 + bước duyệt**

Trong handler `#sacAutoRun`, sau `var voiced = await autoStage2(ok);`:

```javascript
    if (!autoSet.skipAudition) {
      autoStatus('⏸ Nghe thử 3 voice rồi bấm "Chạy cả bộ" lần nữa để dựng timeline.');
      autoPendingBuild = voiced;
      return;
    }
    await autoStage3(voiced);
```

Và thêm ở đầu khối AUTO PAGE:

```javascript
var autoPendingBuild = null;   // job đã gen voice, đang chờ người duyệt
```

Và ở **đầu** handler `#sacAutoRun`, trước mọi thứ khác:

```javascript
  if (autoPendingBuild) {                 // lần bấm thứ 2 = đã duyệt voice
    var pending = autoPendingBuild;
    autoPendingBuild = null;
    await autoStage3(pending);
    return;
  }
```

- [ ] **Step 4: Kiểm chứng bằng tay — có nghe thử**

```bash
./reload.sh
```

Không tick "Bỏ qua nghe thử". Chạy cả bộ. Kỳ vọng:
1. Sau chặng 2, status hiện `⏸ Nghe thử…` và **dừng lại**, không tự dựng.
2. Bấm **Chạy cả bộ** lần nữa → dựng 3 timeline.
3. Trong Project panel: 3 sequence tên đúng `SonaShape vid31.0 [c.ha.ttdo] [hoang.vietnguyen]` … và **nằm trong bin `Sequence/FB/31x`**.
4. Mỗi sequence có voice đúng của job đó, ratio 1080×1920.
5. Có thông báo macOS "Bộ 31: 3/3 timeline xong".

- [ ] **Step 5: Kiểm chứng bằng tay — bỏ qua nghe thử**

Tick "Bỏ qua nghe thử", dùng số bộ khác (ví dụ `32`), chạy lại.
Kỳ vọng: chạy **một mạch** từ validate đến 3 timeline, không dừng giữa.

- [ ] **Step 6: Commit**

```bash
git add plugin/main.js
git commit -m "feat(auto): chặng 3 — align, dựng 3 timeline, đặt sequence vào bin"
```

---

### Task 11: Hoàn thiện — version, tài liệu

**Files:**
- Modify: `plugin/main.js` (PLUGIN_VERSION)
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump version + mô tả**

```bash
grep -n "PLUGIN_VERSION = " plugin/main.js
```

Sửa lên `v5.6.0` và cập nhật chuỗi mô tả kèm sau nó (theo đúng lối các version trước: liệt kê tính năng mới).

- [ ] **Step 2: Ghi endpoint mới vào CLAUDE.md**

Thêm 2 dòng vào bảng "Bridge endpoints":

```markdown
| `/notify` | POST | Thông báo macOS khi pipeline chạm mốc |
| `/autoset/names` | POST | Dựng tên sequence/bin/voice cho bộ 3 video |
```

- [ ] **Step 3: Chạy lại toàn bộ test**

```bash
node bridge/test/autoset-names.test.js && node bridge/test/notify.test.js && node bridge/test/voice-change.test.js
```
Expected: 3 dòng `OK ...`, không có assert nào ném.

- [ ] **Step 4: Commit**

```bash
git add plugin/main.js CLAUDE.md CHANGELOG.md
git commit -m "chore(auto): bump v5.6.0 + tài liệu endpoint mới"
```

---

## Ghi chú về giới hạn của kế hoạch này

Nói rõ để người thực thi không bị bất ngờ:

1. **Phần UI trong Premiere không có test tự động.** Repo không có hạ tầng test cho `plugin/main.js` (non-module, phụ thuộc DOM + UXP API). Chỉ logic thuần ở bridge được test bằng `node`. Mọi task phía plugin đều có bước kiểm chứng tay với kỳ vọng cụ thể — làm đúng thứ tự, đừng bỏ.
2. **Ba chỗ phải xác nhận tên biến/hàm thật trước khi viết code** (Task 7 Step 1, Task 8 Step 1, Task 10 Step 2). Kế hoạch cố tình yêu cầu `grep` trước thay vì ghi tên đoán — vì `main.js` gần 12.000 dòng và tên biến nội bộ có thể đã đổi.
3. **`autoWaitVariation` và `autoWaitAlign` là poll**, vì Voice Gen và align không có callback. Nếu trong lúc làm phát hiện có event/callback thật thì dùng nó, tốt hơn poll.
4. **Ghi chú Drive:** project nằm trên Google Drive shared drive. Ghi file xong Drive mới sync — nếu thấy file chưa hiện ngay ở máy khác thì đó là sync, không phải lỗi plugin.
