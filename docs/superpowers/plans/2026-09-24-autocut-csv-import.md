# Autocut CSV Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm nút "＋ CSV" vào Autocut để nạp script từ file CSV (cấu trúc nav-script), map `text_overlay→text`, `shot_start+"-"+shot_end→time`, `footage_name→source`, không đụng logic paste Google Sheet.

**Architecture:** Tách phần thuần (parse CSV + map cột) ra `plugin/csv-parse.js` (test được bằng node, giống tiền lệ `watch.js`). `main.js` thêm `sacImportCsv()` lo file-pick/confirm/nạp, gọi hàm thuần rồi `window.AutocutPushRows()` sẵn có (hàm này thay bảng + chạy `expandRows` gộp text nhiều dòng).

**Tech Stack:** UXP plugin (non-module classic scripts), Node built-in `assert` cho test, `uxp.storage.localFileSystem.getFileForOpening`.

## Global Constraints

- **Không đụng bridge.** Chỉ sửa `plugin/`.
- **Giữ nguyên** logic paste từ Google Sheet (`parseTSV`, paste handler) — không thay đổi.
- Non-module UXP: dùng `var`/`function`, không `import`/`export`; ràng buộc UXP (không `position:fixed`/`z-index`/`display:grid`).
- Map **theo tên header** (không phân biệt hoa/thường): `text_overlay`, `footage_name`, `shot_start`, `shot_end`.
- Ghép time: có `shot_start`&`shot_end` → `"{start}-{end}"`; chỉ `shot_start` → `"{start}"`; không có → `""`. Lấy nguyên văn, chỉ `.trim()`.
- `footage_name` giữ **nguyên** (cả `.mp4` + `[id]`).
- text_overlay nhiều dòng → gộp 1 dòng (nối bằng khoảng trắng, như `expandRows`).
- Cột bắt buộc: `text_overlay`, `footage_name`, `shot_start` (thiếu → lỗi, không nạp). `shot_end` không bắt buộc.
- Ghi đè bảng dùng **arm 2 bước trên nút** (pattern `elvDeleteBtn`), 4s tự huỷ arm.
- Version bump lên **5.9.0** (feature).

---

### Task 1: Parser thuần + node test (`plugin/csv-parse.js`)

**Files:**
- Create: `plugin/csv-parse.js`
- Create (test): `bridge/test/csv-import.test.js`

**Interfaces:**
- Produces:
  - `csvParse(text: string) → string[][]` — tách CSV (dấu phẩy, quoted field, `""`→`"`, xuống dòng trong ô, bỏ dòng toàn ô rỗng), strip BOM đầu file.
  - `csvRowsToSac(rows: string[][]) → { rows: {text:string,time:string,src:string}[], error: string|null }` — map theo header; thiếu cột bắt buộc → `{rows:[], error:'CSV thiếu cột: …'}`; bỏ dòng mà cả text lẫn src đều rỗng.
  - Cả hai gắn vào global (`window`/`globalThis`) và `module.exports` (guard) để dùng ở UXP lẫn node.

- [ ] **Step 1: Viết test thất bại**

Tạo `bridge/test/csv-import.test.js`:

```js
// bridge/test/csv-import.test.js
const assert = require('assert');
const { csvParse, csvRowsToSac } = require('../../plugin/csv-parse.js');

// CSV mẫu: ô có dấu phẩy trong ngoặc (scene2), xuống dòng trong ngoặc (scene1),
// "" -> " (scene4), và 1 dòng trắng cuối.
const csv = [
  'scene,content,text_overlay,effects,voice_over,visual,notes,shot_name,footage_name,shot_start,shot_end,footage_s3_uri',
  '1,,"Mom, look what I’ve got!\nOh wow… Let me see",note,,,,Full length,K18-1 [mudsnhw5].mp4,0:00,0:04,s3://a',
  '2,,"Just grabbed 3 of these at 68% off... But they are not for me",,,,,Full length,K18-2 [mudsolno].mp4,0:00,0:06,s3://b',
  '4,,"It is ZoeShape \nThe only ""instant-snatch"" solution",,,,,Full length,K18-4 [mudsq04c].mp4,0:00,0:06,s3://c',
  ''
].join('\n');

const rows = csvParse(csv);
assert.strictEqual(rows.length, 4, 'header + 3 data (dòng trắng cuối bị bỏ)');
// dấu phẩy trong ngoặc không tách ô: scene2 vẫn đủ 12 cột
assert.strictEqual(rows[2].length, 12, 'scene2 đủ 12 cột (phẩy trong ngoặc)');

const map = csvRowsToSac(rows);
assert.strictEqual(map.error, null, 'không lỗi');
assert.strictEqual(map.rows.length, 3, '3 scene');
assert.strictEqual(map.rows[0].text, 'Mom, look what I’ve got! Oh wow… Let me see', 'text gộp 1 dòng');
assert.strictEqual(map.rows[0].time, '0:00-0:04', 'time ghép start-end');
assert.strictEqual(map.rows[0].src, 'K18-1 [mudsnhw5].mp4', 'source giữ nguyên');
assert.ok(map.rows[2].text.indexOf('"instant-snatch"') !== -1, '"" -> " literal');

// thiếu cột bắt buộc footage_name -> lỗi
const bad = csvRowsToSac(csvParse('text_overlay,shot_start\nhi,0:00'));
assert.ok(bad.error && bad.error.indexOf('footage_name') !== -1, 'thiếu footage_name -> lỗi');
assert.strictEqual(bad.rows.length, 0, 'lỗi thì không nạp dòng nào');

// thiếu shot_end -> time chỉ start
const noEnd = csvRowsToSac(csvParse('text_overlay,footage_name,shot_start\nhi,a.mp4,0:03'));
assert.strictEqual(noEnd.error, null);
assert.strictEqual(noEnd.rows[0].time, '0:03', 'không có shot_end -> chỉ start');

console.log('csv-import tests passed');
```

- [ ] **Step 2: Chạy test — phải THẤT BẠI (chưa có file)**

Run: `node bridge/test/csv-import.test.js`
Expected: FAIL — `Cannot find module '../../plugin/csv-parse.js'`

- [ ] **Step 3: Tạo `plugin/csv-parse.js`**

```js
// plugin/csv-parse.js — parser + map thuần cho tính năng "Thêm CSV" của Autocut.
// Classic script nạp TRƯỚC main.js (expose global csvParse/csvRowsToSac); đồng thời
// export cho node để test. KHÔNG đụng DOM. Thiết kế:
// docs/superpowers/specs/2026-09-24-autocut-csv-import-design.md

function csvParse(text) {
  text = String(text == null ? '' : text).replace(/^﻿/, ''); // strip BOM
  var rows = [], row = [], cell = '', inQ = false, i = 0, ch, nx;
  while (i < text.length) {
    ch = text[i]; nx = text[i + 1];
    if (inQ) {
      if (ch === '"' && nx === '"') { cell += '"'; i += 2; }   // "" -> "
      else if (ch === '"')          { inQ = false; i++; }       // end quote
      else                          { cell += ch; i++; }        // gồm cả \n trong ô
    } else {
      if      (ch === '"')                 { inQ = true; i++; }
      else if (ch === ',')                 { row.push(cell); cell = ''; i++; }
      else if (ch === '\n' || ch === '\r') {
        row.push(cell); cell = '';
        if (row.some(function (c) { return c !== ''; })) rows.push(row);
        row = [];
        if (ch === '\r' && nx === '\n') i++; // CRLF
        i++;
      } else { cell += ch; i++; }
    }
  }
  row.push(cell);
  if (row.some(function (c) { return c !== ''; })) rows.push(row);
  return rows;
}

function csvRowsToSac(rows) {
  if (!rows || !rows.length) return { rows: [], error: 'CSV rỗng' };
  var header = rows[0].map(function (h) { return String(h == null ? '' : h).trim().toLowerCase(); });
  function col(name) { return header.indexOf(name); }
  var iText = col('text_overlay'), iFoot = col('footage_name'),
      iStart = col('shot_start'), iEnd = col('shot_end');
  var missing = [];
  if (iText  < 0) missing.push('text_overlay');
  if (iFoot  < 0) missing.push('footage_name');
  if (iStart < 0) missing.push('shot_start');
  if (missing.length) return { rows: [], error: 'CSV thiếu cột: ' + missing.join(', ') };

  var out = [];
  for (var r = 1; r < rows.length; r++) {
    var rw = rows[r] || [];
    var textRaw = String(rw[iText] != null ? rw[iText] : '');
    var text = textRaw.split('\n').map(function (l) { return l.trim(); })
      .filter(Boolean).join(' ').trim();
    var start = String(rw[iStart] != null ? rw[iStart] : '').trim();
    var end   = iEnd >= 0 ? String(rw[iEnd] != null ? rw[iEnd] : '').trim() : '';
    var time  = (start && end) ? (start + '-' + end) : (start || '');
    var src   = String(rw[iFoot] != null ? rw[iFoot] : '').trim();
    if (!text && !src) continue; // dòng trắng
    out.push({ text: text, time: time, src: src });
  }
  return { rows: out, error: null };
}

(function (root) {
  if (root) { root.csvParse = csvParse; root.csvRowsToSac = csvRowsToSac; }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { csvParse: csvParse, csvRowsToSac: csvRowsToSac };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
```

- [ ] **Step 4: Chạy test — phải PASS**

Run: `node bridge/test/csv-import.test.js`
Expected: in ra `csv-import tests passed`, exit 0.

- [ ] **Step 5: Chạy cả bộ test bridge (không vỡ test khác)**

Run: `cd bridge && npm test`
Expected: kết thúc `ALL TESTS PASSED`.

- [ ] **Step 6: Commit**

```bash
git add plugin/csv-parse.js bridge/test/csv-import.test.js
git commit -m "feat(autocut): csv-parse.js — parser + map cột cho import CSV (+ node test)"
```

---

### Task 2: UI nút CSV + wiring nạp bảng

**Files:**
- Modify: `plugin/index.html` (thêm `<script src="csv-parse.js">` trước main.js; thêm nút trong `#sacScriptToggle`)
- Modify: `plugin/styles.css` (thêm `.sac-csvBtn`)
- Modify: `plugin/main.js` (thêm `sacImportCsv` + arm 2 bước + wiring, cạnh handler `#sacScriptClear`)

**Interfaces:**
- Consumes: `csvParse`, `csvRowsToSac` (global từ Task 1); `window.AutocutPushRows(rows)` (sẵn có — thay bảng, chạy expandRows); `$` (alias getElementById); `#sacStatus`, `#sacBody`, `.sac-row`.
- Produces: nút `#sacCsvImport`; hàm `sacImportCsv`/`sacDoImportCsv` (không có consumer khác).

- [ ] **Step 1: Nạp csv-parse.js trong index.html (TRƯỚC main.js)**

Sửa `plugin/index.html` — trước dòng `<script src="main.js"></script>` (dòng 1698):

```html
<script src="csv-parse.js"></script>
<script src="main.js"></script>
```

- [ ] **Step 2: Thêm nút CSV vào header script**

Trong `#sacScriptToggle`, chèn NGAY TRƯỚC `<div id="sacScriptClear" ...>` (index.html dòng 998):

```html
        <div id="sacCsvImport" class="sac-csvBtn" role="button" title="Nạp script từ file CSV">＋ CSV</div>
```

- [ ] **Step 3: Thêm CSS `.sac-csvBtn`**

Trong `plugin/styles.css`, ngay sau khối `.sac-scriptClearBtn:hover` (dòng 1058):

```css
.sac-csvBtn {
  margin-left: auto; margin-right: 6px; flex: 0 0 auto;
  background: rgba(168,85,247,0.14); border: 1px solid rgba(168,85,247,0.45);
  color: #c4b5fd; border-radius: 5px; padding: 2px 8px; font-size: 10px; cursor: pointer;
}
.sac-csvBtn:hover { background: rgba(168,85,247,0.26); color: #fff; }
.sac-csvBtn.is-armed { background: rgba(239,68,68,0.22); border-color: rgba(239,68,68,0.6); color: #fff; }
```

- [ ] **Step 4: Thêm logic + wiring trong main.js**

Trong `plugin/main.js`, chèn NGAY SAU khối handler `sacScriptClear` (kết thúc quanh dòng 7470, sau `if (typeof sacUpdateRunVisibility === 'function') sacUpdateRunVisibility();` và `});` đóng addEventListener). Đặt cùng scope với `$`/`createRow`:

```js
  // ── Autocut: nạp script từ CSV (không đụng logic paste Google Sheet) ──────
  var sacCsvArmed = false, sacCsvArmTimer = null;
  function sacBoardHasData() {
    var body = $('sacBody'); if (!body) return false;
    var fields = body.querySelectorAll('textarea, input');
    for (var i = 0; i < fields.length; i++) {
      if ((fields[i].value || '').trim()) return true;
    }
    return false;
  }
  function sacDisarmCsv() {
    sacCsvArmed = false;
    if (sacCsvArmTimer) { clearTimeout(sacCsvArmTimer); sacCsvArmTimer = null; }
    var b = $('sacCsvImport');
    if (b) { b.classList.remove('is-armed'); b.textContent = '＋ CSV'; }
  }
  async function sacDoImportCsv() {
    var st = $('sacStatus');
    function say(msg) { if (st) { st.textContent = msg; st.style.display = 'block'; } }
    try {
      var uxp = require('uxp');
      var file = await uxp.storage.localFileSystem.getFileForOpening({ types: ['csv'] });
      if (!file) return; // user huỷ
      var text = await file.read();
      var parse = (typeof window !== 'undefined' && window.csvParse) ? window.csvParse : csvParse;
      var toSac = (typeof window !== 'undefined' && window.csvRowsToSac) ? window.csvRowsToSac : csvRowsToSac;
      var res = toSac(parse(text));
      if (res.error) { say('⚠ ' + res.error); return; }
      if (!res.rows.length) { say('⚠ CSV không có dòng dữ liệu nào.'); return; }
      if (typeof window.AutocutPushRows === 'function') window.AutocutPushRows(res.rows);
      say('✓ Đã nạp ' + res.rows.length + ' scene từ CSV.');
    } catch (err) {
      say('❌ Lỗi đọc CSV: ' + (err && err.message ? err.message : err));
    }
  }
  function sacOnCsvClick(e) {
    if (e) e.stopPropagation(); // đừng toggle collapse
    // Ghi đè bảng đang có dữ liệu → arm 2 bước
    if (sacBoardHasData() && !sacCsvArmed) {
      sacCsvArmed = true;
      var b = $('sacCsvImport');
      if (b) { b.textContent = 'Ghi đè? bấm lại'; b.classList.add('is-armed'); }
      sacCsvArmTimer = setTimeout(sacDisarmCsv, 4000);
      return;
    }
    sacDisarmCsv();
    sacDoImportCsv();
  }
  var sacCsvBtnEl = $('sacCsvImport');
  if (sacCsvBtnEl) sacCsvBtnEl.addEventListener('click', sacOnCsvClick);
```

- [ ] **Step 5: Kiểm cú pháp + không có marker/lỗi**

Run:
```bash
node -c plugin/main.js && echo "MAIN OK"
node -c plugin/csv-parse.js && echo "CSVPARSE OK"
grep -c 'sacCsvImport' plugin/index.html plugin/main.js plugin/styles.css
```
Expected: `MAIN OK`, `CSVPARSE OK`; `sacCsvImport` xuất hiện ở cả 3 file (index.html ≥1, main.js ≥3, styles.css ≥3).

- [ ] **Step 6: Verify thứ tự script + không đụng paste Google Sheet**

Run:
```bash
grep -n 'csv-parse.js\|main.js\|watch.js' plugin/index.html
grep -c "parseTSV" plugin/main.js
```
Expected: `csv-parse.js` đứng TRƯỚC `main.js`; `parseTSV` vẫn còn (không bị xoá — logic paste nguyên vẹn).

- [ ] **Step 7: Commit**

```bash
git add plugin/index.html plugin/styles.css plugin/main.js
git commit -m "feat(autocut): nút ＋CSV — chọn file, map cột, nạp bảng (arm 2 bước ghi đè)"
```

---

### Task 3: Bump version + CHANGELOG

**Files:**
- Modify: `plugin/manifest.json` (`"version"`)
- Modify: `plugin/main.js` (`PLUGIN_VERSION`, dòng 794)
- Modify: `CHANGELOG.md` (entry đầu)

**Interfaces:**
- Consumes: version hiện tại `5.8.2`.
- Produces: version `5.9.0` đồng bộ 3 nơi.

- [ ] **Step 1: Bump manifest**

Sửa `plugin/manifest.json`: `"version": "5.8.2",` → `"version": "5.9.0",`

- [ ] **Step 2: Bump PLUGIN_VERSION**

Sửa `plugin/main.js` dòng 794: đổi `var PLUGIN_VERSION = 'v5.8.2';` thành `var PLUGIN_VERSION = 'v5.9.0';` và chèn ghi chú mới vào ĐẦU phần comment cùng dòng (giữ nguyên phần mô tả v5.8.2 phía sau):

```
var PLUGIN_VERSION = 'v5.9.0';  // Autocut: nút ＋CSV nạp script từ file CSV (map text_overlay→script, shot_start-"-"-shot_end→time, footage_name→source; parser thuần plugin/csv-parse.js + node test; arm 2 bước ghi đè). Giữ nguyên paste Google Sheet. KHÔNG cần bridge mới. v5.8.2 — <giữ nguyên toàn bộ chuỗi mô tả cũ đang có>
```
(Chỉ đổi số + prepend đoạn mô tả CSV; KHÔNG xoá lịch sử v5.8.2… phía sau.)

- [ ] **Step 3: Thêm entry CHANGELOG**

Chèn ngay trên dòng `## v5.8.2 / bridge app 3.13 ...` trong `CHANGELOG.md`:

```markdown
## v5.9.0 — 2026-09-24

> Chỉ sửa plugin. **Không cần bridge mới.**

**Autocut: nạp script từ file CSV (nút ＋CSV).** Bổ sung cạnh cách paste Google Sheet (giữ nguyên).

### ✅ Thêm mới
- Nút **＋CSV** trong header Script của Autocut → chọn file `.csv` → nạp thẳng vào bảng.
- Map theo tên header: `text_overlay → script`, `shot_start + "-" + shot_end → time (in→out)`, `footage_name → source` (giữ nguyên cả `.mp4`/`[id]`).
- text_overlay nhiều dòng → gộp 1 dòng; ghi đè bảng dùng **arm 2 bước** (bấm lại trong 4s).
- Thiếu cột bắt buộc (`text_overlay`/`footage_name`/`shot_start`) → báo lỗi, không nạp.

### 🔧 Kỹ thuật
- Parser thuần tách ra `plugin/csv-parse.js` (`csvParse` + `csvRowsToSac`), có **node test** `bridge/test/csv-import.test.js` (dấu phẩy/xuống dòng/`""` trong ô, ghép time, thiếu cột). Tái dùng `window.AutocutPushRows()` + `expandRows` sẵn có.
- **Không đụng** `parseTSV`/paste Google Sheet.
```

- [ ] **Step 4: Verify đồng bộ version + test vẫn xanh**

Run:
```bash
grep -m1 '"version"' plugin/manifest.json; grep -m1 "PLUGIN_VERSION = " plugin/main.js | grep -oE "v5\.9\.0"; grep -m1 "## v5.9.0" CHANGELOG.md
node -c plugin/main.js && (cd bridge && npm test | tail -1)
```
Expected: manifest `5.9.0`, `v5.9.0`, có `## v5.9.0`; `ALL TESTS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add plugin/manifest.json plugin/main.js CHANGELOG.md
git commit -m "chore: bump v5.9.0 — Autocut CSV import"
```

---

## Kiểm thử thủ công (sau khi code — trong Premiere, UXP không test headless)

> Reload plugin qua **UXP Developer Tools → ⟳ Reload** (Premiere nạp từ repo `plugin/`).

1. Tab **AUTOCUT** → header Script có nút **＋CSV**.
2. Bấm ＋CSV → chọn `nav-script-98-v31-0-v85-20260924-1137.csv` → bảng nạp **5 scene**: time `0:00-0:04`, `0:00-0:06`, `0:00-0:04`, `0:00-0:06`, `0:00-0:47`; source giữ nguyên tên file; script scene 5 gộp 1 dòng.
3. Bảng đang có dữ liệu → bấm ＋CSV lần 1 hiện "Ghi đè? bấm lại", lần 2 mới nạp; đợi >4s thì phải bấm lại từ đầu.
4. CSV thiếu cột `footage_name` → báo "⚠ CSV thiếu cột: footage_name", không nạp.
5. Paste từ Google Sheet vào bảng vẫn hoạt động y như cũ.

## Self-Review

- **Spec coverage:** parser+map (Task 1) ✓ · map theo header + time combine + footage giữ nguyên + flatten text (Task 1 `csvRowsToSac`) ✓ · thiếu cột báo lỗi (Task 1) ✓ · nút UI + file pick + AutocutPushRows (Task 2) ✓ · arm 2 bước ghi đè (Task 2 `sacOnCsvClick`) ✓ · stopPropagation (Task 2 Step 4) ✓ · giữ nguyên paste (Task 2 Step 6 verify) ✓ · version bump (Task 3) ✓ · test node (Task 1) + thủ công (mục cuối) ✓.
- **Placeholder scan:** không TBD/TODO; mọi code step có code thật; verify step có lệnh + expected. (Ngoại lệ có chủ đích: Task 3 Step 2 giữ nguyên chuỗi mô tả v5.8.2 dài — không chép lại vào plan vì chỉ prepend.)
- **Type consistency:** `csvParse`/`csvRowsToSac` chữ ký + kiểu trả `{rows,error}` nhất quán giữa Task 1 (định nghĩa + test) và Task 2 (gọi); `sacCsvImport` id khớp ở index.html/CSS/main.js; `window.AutocutPushRows(rows)` nhận `{text,time,src}[]` đúng như `csvRowsToSac` trả.
