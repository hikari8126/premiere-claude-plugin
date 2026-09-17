# Watch Folder Auto-Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Theo dõi nhiều thư mục trên đĩa và tự động import file mới vào đúng bin của project Premiere đang mở.

**Architecture:** Bridge (Node) quét thư mục định kỳ và giữ hàng đợi đường dẫn file; plugin UXP poll hàng đợi, tạo cây bin và gọi `project.importFiles()`, rồi ack lại. Bridge không biết gì về Premiere, plugin không biết gì về filesystem — nhờ vậy toàn bộ logic quét/lọc test được bằng Node trên thư mục tạm.

**Tech Stack:** Node 26 + Express (bridge, CommonJS), UXP plugin (JavaScript classic script, KHÔNG ES module), test bằng `node:assert` chạy trực tiếp `node test/x.test.js` — theo đúng kiểu `bridge/test/autoset-names.test.js` sẵn có.

**Spec:** `docs/superpowers/specs/2026-09-17-watch-folder-auto-import-design.md`

---

## Ràng buộc bắt buộc đọc trước khi code

**Bridge:**
- CommonJS (`require`/`module.exports`), không dùng `import`.
- Không thêm dependency mới. Chỉ `fs`, `path`, `os`.
- File trạng thái nằm ở `~/Library/Application Support/ClaudeBridge/` (giống `hotkeys.json` ở `server.js:3144`).

**Plugin UXP** (theo `CLAUDE.md`):
- Không `position:fixed`, không `z-index`, không `display:grid`, không `window.innerWidth`, không thuộc tính `title=""`.
- Vùng cuộn phải là **inner child** với `flex:1 1 0; min-height:0; overflow-y:auto` — đặt lên chính flex container sẽ không cuộn.
- Mọi API Premiere đều async: `await` hết.
- Mọi `<input>`/`<textarea>`: `focus` → `window.claimKeyboard()`, `blur` → `window.releaseKeyboard()`. Thiếu là phím tắt B/V/C của Premiere nuốt ký tự.
- `main.js` là classic script, không module. File mới `plugin/watch.js` nạp bằng thẻ `<script>` thứ hai **sau** `main.js`, dùng chung global scope.

## File Structure

| File | Trách nhiệm |
|---|---|
| `bridge/watchfolder-rules.js` (mới) | Thuần hàm: validate watch, `matchFile`, `binPathFor`. Không đụng fs |
| `bridge/watchfolder-scan.js` (mới) | Duyệt thư mục đệ quy có `maxDepth`, trả `{rel: [size, mtimeMs]}` |
| `bridge/watchfolder-store.js` (mới) | Đọc/ghi `watchfolder-config.json` + `watchfolder-state.json` |
| `bridge/watchfolder.js` (mới) | Engine: session, tick, ổn định file, hàng đợi, ack, interval thích ứng |
| `bridge/server.js` (sửa) | 6 endpoint mỏng + bump `BRIDGE_VERSION` |
| `bridge/package.json` (sửa) | Thêm script `test` |
| `plugin/index.html` (sửa) | Nút tab + panel `#tab-watch` + `<script src="watch.js">` |
| `plugin/styles.css` (sửa) | Style tab Watch |
| `plugin/watch.js` (mới) | Toàn bộ logic tab Watch |
| `plugin/manifest.json` (sửa) | Bump version 5.8.0 |

Mỗi task dưới đây tự chứa. Chạy test bằng `cd bridge && node test/<file>`.

---

### Task 1: Khung test cho bridge

**Files:**
- Modify: `bridge/package.json`

- [ ] **Step 1: Thêm script test**

Sửa khối `"scripts"` trong `bridge/package.json` thành:

```json
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "test": "for f in test/*.test.js; do echo \"→ $f\"; node \"$f\" || exit 1; done; echo 'ALL TESTS PASSED'"
  },
```

- [ ] **Step 2: Chạy để xác nhận test cũ vẫn pass**

Run: `cd bridge && npm test`
Expected: in ra 3 dòng `→ test/...` rồi `ALL TESTS PASSED`. Nếu `voice-change.test.js` fail vì thiếu API key, ghi lại kết quả và bỏ qua — các task sau chỉ chạy file test của chính nó.

- [ ] **Step 3: Commit**

```bash
git add bridge/package.json
git commit -m "chore(bridge): thêm npm test chạy toàn bộ test/*.test.js"
```

---

### Task 2: Luật lọc file (`watchfolder-rules.js`)

**Files:**
- Create: `bridge/watchfolder-rules.js`
- Test: `bridge/test/watchfolder-rules.test.js`

`relPath` luôn dùng dấu `/`, tương đối so với `watch.folder`. Ví dụ `B-roll/sunset/c.mp4`.

- [ ] **Step 1: Viết test fail trước**

Tạo `bridge/test/watchfolder-rules.test.js`:

```js
// bridge/test/watchfolder-rules.test.js
const assert = require('assert');
const { validateWatch, matchFile, binPathFor, PRESETS } = require('../watchfolder-rules.js');

const base = {
  id: 'w_1', enabled: true, label: 'T', folder: '/x', binPath: 'Footage/Drone',
  recursive: true, maxDepth: 3, mirrorSubfolders: true,
  include: ['video'], includeRegex: '', excludeRegex: '',
  intervalMs: 3000, stableChecks: 2,
};

// ── validateWatch ─────────────────────────────────────────────────────────
assert.strictEqual(validateWatch(base).ok, true, 'watch hợp lệ');
assert.strictEqual(validateWatch({ ...base, folder: '' }).ok, false, 'thiếu folder → lỗi');
assert.strictEqual(validateWatch({ ...base, binPath: '' }).ok, false, 'thiếu binPath → lỗi');
assert.strictEqual(validateWatch({ ...base, include: [] }).ok, false, 'không chọn loại file → lỗi');
const badRe = validateWatch({ ...base, excludeRegex: '[' });
assert.strictEqual(badRe.ok, false, 'regex sai cú pháp → lỗi');
assert.ok(/excludeRegex/.test(badRe.error), 'lỗi nêu đúng tên trường: ' + badRe.error);
assert.strictEqual(validateWatch({ ...base, intervalMs: 100 }).ok, false, 'interval < 1000ms → lỗi');

// ── matchFile: bỏ qua cứng ────────────────────────────────────────────────
assert.strictEqual(matchFile(base, '.DS_Store'), false, 'bỏ .DS_Store');
assert.strictEqual(matchFile(base, '._a.mp4'), false, 'bỏ file resource fork macOS');
assert.strictEqual(matchFile(base, '.hidden/a.mp4'), false, 'bỏ file trong thư mục ẩn');
assert.strictEqual(matchFile(base, 'a.mp4.tmp'), false, 'bỏ .tmp');
assert.strictEqual(matchFile(base, 'a.mp4.part'), false, 'bỏ .part');
assert.strictEqual(matchFile(base, 'a.mp4.crdownload'), false, 'bỏ .crdownload');
assert.strictEqual(
  matchFile(base, 'Adobe Premiere Pro Auto-Save/a.mp4'), false, 'bỏ thư mục Auto-Save');
assert.strictEqual(
  matchFile(base, 'Adobe Premiere Pro Preview Files/a.mp4'), false, 'bỏ Preview Files');

// ── matchFile: preset đuôi file ───────────────────────────────────────────
assert.strictEqual(matchFile(base, 'a.mp4'), true, 'video preset nhận mp4');
assert.strictEqual(matchFile(base, 'a.MOV'), true, 'đuôi file không phân biệt hoa thường');
assert.strictEqual(matchFile(base, 'a.wav'), false, 'video preset loại wav');
assert.strictEqual(matchFile({ ...base, include: ['video', 'audio'] }, 'a.wav'), true,
  'chọn nhiều preset');
assert.strictEqual(matchFile({ ...base, include: ['all'] }, 'a.xyz'), true, 'preset all nhận hết');
assert.strictEqual(matchFile({ ...base, include: ['all'] }, 'a.tmp'), false,
  'preset all vẫn không phá luật bỏ qua cứng');
assert.ok(PRESETS.video.includes('.braw') && PRESETS.image.includes('.dng'), 'preset đủ đuôi');

// ── matchFile: regex khớp trên TÊN FILE, không phải full path ─────────────
assert.strictEqual(matchFile({ ...base, excludeRegex: '_proxy$' }, 'a_proxy.mp4'), false,
  'excludeRegex khớp phần tên trước đuôi');
assert.strictEqual(matchFile({ ...base, excludeRegex: '_proxy$' }, 'a.mp4'), true);
assert.strictEqual(matchFile({ ...base, includeRegex: '^DJI_' }, 'DJI_0041.mp4'), true);
assert.strictEqual(matchFile({ ...base, includeRegex: '^DJI_' }, 'GOPRO.mp4'), false);
assert.strictEqual(matchFile({ ...base, includeRegex: '^DJI_' }, 'DJI_x/GOPRO.mp4'), false,
  'regex KHÔNG khớp vào tên thư mục cha');

// ── binPathFor ────────────────────────────────────────────────────────────
assert.strictEqual(binPathFor(base, 'a.mp4'), 'Footage/Drone', 'file gốc → bin gốc');
assert.strictEqual(binPathFor(base, 'B-roll/b.mp4'), 'Footage/Drone/B-roll');
assert.strictEqual(binPathFor(base, 'B-roll/sunset/c.mp4'), 'Footage/Drone/B-roll/sunset');
assert.strictEqual(binPathFor({ ...base, mirrorSubfolders: false }, 'B-roll/sunset/c.mp4'),
  'Footage/Drone', 'tắt mirror → đổ phẳng');

console.log('watchfolder-rules: OK');
```

- [ ] **Step 2: Chạy để xác nhận fail**

Run: `cd bridge && node test/watchfolder-rules.test.js`
Expected: FAIL — `Cannot find module '../watchfolder-rules.js'`

- [ ] **Step 3: Viết implementation tối thiểu**

Tạo `bridge/watchfolder-rules.js`:

```js
// bridge/watchfolder-rules.js
// Thuần hàm, không đụng filesystem — nhờ vậy test được không cần thư mục thật.
// relPath luôn dùng '/', tương đối so với watch.folder.

const PRESETS = {
  video: ['.mp4', '.mov', '.mxf', '.mkv', '.avi', '.r3d', '.braw', '.m4v', '.mts'],
  audio: ['.wav', '.mp3', '.aac', '.aiff', '.aif', '.flac', '.m4a'],
  image: ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.psd', '.exr', '.dng', '.gif'],
};

// Thư mục Premiere tự sinh — import vào là rác project.
const IGNORE_DIRS = [
  'adobe premiere pro auto-save',
  'adobe premiere pro preview files',
  'adobe premiere pro captured video',
  '.proxy',
];

// Đuôi của file đang được ghi dở.
const IGNORE_EXT = ['.tmp', '.part', '.crdownload', '.download', '.pek', '.cfa'];

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

function validateWatch(w) {
  if (!w || typeof w !== 'object') return { ok: false, error: 'watch rỗng' };
  if (!w.folder) return { ok: false, error: 'chưa chọn thư mục theo dõi' };
  if (!w.binPath) return { ok: false, error: 'chưa chọn bin đích' };
  if (!Array.isArray(w.include) || w.include.length === 0) {
    return { ok: false, error: 'chưa chọn loại file nào' };
  }
  if (!(Number(w.intervalMs) >= 1000)) {
    return { ok: false, error: 'intervalMs phải ≥ 1000' };
  }
  for (const field of ['includeRegex', 'excludeRegex']) {
    const src = w[field];
    if (!src) continue;
    try { new RegExp(src); }
    catch (e) { return { ok: false, error: field + ' sai cú pháp: ' + e.message }; }
  }
  return { ok: true };
}

function matchFile(w, relPath) {
  const parts = String(relPath).split('/');
  const name  = parts[parts.length - 1];
  const dirs  = parts.slice(0, -1);

  // 1. Bỏ qua cứng — không tắt được, kể cả preset 'all'.
  if (name.startsWith('.')) return false;
  for (const d of dirs) {
    if (d.startsWith('.')) return false;
    if (IGNORE_DIRS.indexOf(d.toLowerCase()) >= 0) return false;
  }
  const ext = extOf(name);
  if (IGNORE_EXT.indexOf(ext) >= 0) return false;

  // 2. Preset đuôi file.
  if (w.include.indexOf('all') < 0) {
    let hit = false;
    for (const key of w.include) {
      const list = PRESETS[key];
      if (list && list.indexOf(ext) >= 0) { hit = true; break; }
    }
    if (!hit) return false;
  }

  // 3 + 4. Regex chỉ soi TÊN FILE. Soi cả path sẽ khiến tên thư mục cha
  // vô tình khớp và lọc sai hàng loạt.
  if (w.includeRegex && !new RegExp(w.includeRegex).test(name)) return false;
  if (w.excludeRegex && new RegExp(w.excludeRegex).test(name)) return false;

  return true;
}

function binPathFor(w, relPath) {
  if (!w.mirrorSubfolders) return w.binPath;
  const dirs = String(relPath).split('/').slice(0, -1);
  if (dirs.length === 0) return w.binPath;
  return w.binPath + '/' + dirs.join('/');
}

module.exports = { PRESETS, IGNORE_DIRS, IGNORE_EXT, validateWatch, matchFile, binPathFor };
```

- [ ] **Step 4: Chạy test, phải pass**

Run: `cd bridge && node test/watchfolder-rules.test.js`
Expected: `watchfolder-rules: OK`

- [ ] **Step 5: Commit**

```bash
git add bridge/watchfolder-rules.js bridge/test/watchfolder-rules.test.js
git commit -m "feat(bridge): luật lọc file và ánh xạ bin cho watch folder"
```

---

### Task 3: Quét thư mục (`watchfolder-scan.js`)

**Files:**
- Create: `bridge/watchfolder-scan.js`
- Test: `bridge/test/watchfolder-scan.test.js`

- [ ] **Step 1: Viết test fail trước**

Tạo `bridge/test/watchfolder-scan.test.js`:

```js
// bridge/test/watchfolder-scan.test.js
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { scanFolder } = require('../watchfolder-scan.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-scan-'));
function put(rel, body) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

put('a.mp4', 'aaa');
put('sub/b.mp4', 'bb');
put('sub/deep/c.mp4', 'c');
put('sub/deep/deeper/d.mp4', 'd');

// 1. Không đệ quy → chỉ file ở cấp gốc
const flat = scanFolder(root, { recursive: false, maxDepth: 3 });
assert.strictEqual(flat.ok, true);
assert.deepStrictEqual(Object.keys(flat.files).sort(), ['a.mp4'], 'không đệ quy chỉ lấy cấp gốc');

// 2. Đệ quy maxDepth 2 → cắt ở sub/deep/c.mp4, không lấy deeper
const d2 = scanFolder(root, { recursive: true, maxDepth: 2 });
assert.deepStrictEqual(Object.keys(d2.files).sort(), ['a.mp4', 'sub/b.mp4'],
  'maxDepth 2 = tối đa 1 cấp thư mục con');

// 3. Đệ quy maxDepth 3
const d3 = scanFolder(root, { recursive: true, maxDepth: 3 });
assert.deepStrictEqual(Object.keys(d3.files).sort(),
  ['a.mp4', 'sub/b.mp4', 'sub/deep/c.mp4'], 'maxDepth 3');

// 4. Giá trị là [size, mtimeMs], relPath luôn dùng '/'
const st = fs.statSync(path.join(root, 'sub', 'b.mp4'));
assert.strictEqual(d3.files['sub/b.mp4'][0], st.size, 'lưu size');
assert.strictEqual(d3.files['sub/b.mp4'][1], Math.floor(st.mtimeMs), 'lưu mtime đã làm tròn');

// 5. Thư mục không tồn tại → ok:false, KHÔNG ném
const gone = scanFolder(path.join(root, 'khong-co'), { recursive: true, maxDepth: 3 });
assert.strictEqual(gone.ok, false, 'thư mục mất thì trả ok:false');
assert.ok(gone.error, 'có mô tả lỗi');

// 6. Vượt trần thì cắt và báo truncated, không phình bộ nhớ
const many = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-many-'));
for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(many, 'f' + i + '.mp4'), 'x');
const cap = scanFolder(many, { recursive: true, maxDepth: 3, maxFiles: 10 });
assert.strictEqual(Object.keys(cap.files).length, 10, 'cắt đúng trần');
assert.strictEqual(cap.truncated, true, 'báo truncated');

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(many, { recursive: true, force: true });
console.log('watchfolder-scan: OK');
```

- [ ] **Step 2: Chạy để xác nhận fail**

Run: `cd bridge && node test/watchfolder-scan.test.js`
Expected: FAIL — `Cannot find module '../watchfolder-scan.js'`

- [ ] **Step 3: Viết implementation tối thiểu**

Tạo `bridge/watchfolder-scan.js`:

```js
// bridge/watchfolder-scan.js
// Duyệt thư mục đồng bộ, trả snapshot { relPath: [size, mtimeMs] }.
// Đồng bộ là chủ ý: một lượt quét chạy trong vài ms tới vài trăm ms và
// engine gọi nó ngoài đường request, nên không chặn gì đáng kể — đổi lại
// logic đơn giản hơn hẳn bản async.

const fs   = require('fs');
const path = require('path');

const DEFAULT_MAX_FILES = 20000;

// maxDepth 1 = chỉ file ngay trong folder; 2 = thêm 1 cấp con; ...
function scanFolder(folder, opts) {
  const o = opts || {};
  const maxDepth  = o.recursive === false ? 1 : Math.max(1, Number(o.maxDepth) || 3);
  const maxFiles  = Number(o.maxFiles) || DEFAULT_MAX_FILES;
  const files = {};
  let count = 0;
  let truncated = false;

  function walk(abs, rel, depth) {
    if (truncated) return;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
    catch (e) { if (depth === 1) throw e; return; }   // lỗi ở gốc mới là lỗi thật

    for (const ent of entries) {
      if (truncated) return;
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        if (depth < maxDepth) walk(path.join(abs, ent.name), childRel, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;   // bỏ symlink, socket, fifo
      let st;
      try { st = fs.statSync(path.join(abs, ent.name)); } catch (e) { continue; }
      files[childRel] = [st.size, Math.floor(st.mtimeMs)];
      if (++count >= maxFiles) { truncated = true; return; }
    }
  }

  try { walk(folder, '', 1); }
  catch (e) { return { ok: false, error: e.code || e.message, files: {}, truncated: false }; }

  return { ok: true, files, truncated };
}

module.exports = { scanFolder, DEFAULT_MAX_FILES };
```

- [ ] **Step 4: Chạy test, phải pass**

Run: `cd bridge && node test/watchfolder-scan.test.js`
Expected: `watchfolder-scan: OK`

- [ ] **Step 5: Commit**

```bash
git add bridge/watchfolder-scan.js bridge/test/watchfolder-scan.test.js
git commit -m "feat(bridge): quét thư mục đệ quy có giới hạn độ sâu và trần số file"
```

---

### Task 4: Lưu trữ config và state (`watchfolder-store.js`)

**Files:**
- Create: `bridge/watchfolder-store.js`
- Test: `bridge/test/watchfolder-store.test.js`

- [ ] **Step 1: Viết test fail trước**

Tạo `bridge/test/watchfolder-store.test.js`:

```js
// bridge/test/watchfolder-store.test.js
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const store = require('../watchfolder-store.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-store-'));
store.setDir(dir);

const PROJ = '/Users/x/Series_A.prproj';

// 1. Project chưa có config → mảng rỗng, không ném
assert.deepStrictEqual(store.readConfig(PROJ), [], 'chưa có config → []');

// 2. Ghi rồi đọc lại đúng nguyên vẹn
const watches = [{ id: 'w_1', folder: '/a', binPath: 'Footage', include: ['video'] }];
store.writeConfig(PROJ, watches);
assert.deepStrictEqual(store.readConfig(PROJ), watches, 'đọc lại đúng');

// 3. Config của project khác không đè lên nhau
store.writeConfig('/Users/x/Series_B.prproj', []);
assert.deepStrictEqual(store.readConfig(PROJ), watches, 'project khác không đè config');

// 4. File config hỏng → trả [] chứ không làm sập bridge
fs.writeFileSync(path.join(dir, 'watchfolder-config.json'), '{ hỏng');
assert.deepStrictEqual(store.readConfig(PROJ), [], 'JSON hỏng → [] chứ không ném');

// 5. State đọc/ghi
store.writeConfig(PROJ, watches);
assert.deepStrictEqual(store.readState(), {}, 'state rỗng ban đầu');
store.writeState({ 'w_1': { snapshot: { 'a.mp4': [3, 111] } } });
assert.deepStrictEqual(store.readState()['w_1'].snapshot['a.mp4'], [3, 111], 'state lưu snapshot');

// 6. Ghi state là atomic — file tạm được dọn, không để lại rác
store.writeState({ 'w_1': { snapshot: {} } });
const leftovers = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
assert.deepStrictEqual(leftovers, [], 'không để lại file .tmp');

fs.rmSync(dir, { recursive: true, force: true });
console.log('watchfolder-store: OK');
```

- [ ] **Step 2: Chạy để xác nhận fail**

Run: `cd bridge && node test/watchfolder-store.test.js`
Expected: FAIL — `Cannot find module '../watchfolder-store.js'`

- [ ] **Step 3: Viết implementation tối thiểu**

Tạo `bridge/watchfolder-store.js`:

```js
// bridge/watchfolder-store.js
// Config + state nằm ngoài repo, cùng chỗ hotkeys.json, nên không mất khi
// cập nhật bridge. setDir() để test chạy trên thư mục tạm.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

let DIR = path.join(os.homedir(), 'Library', 'Application Support', 'ClaudeBridge');

function setDir(d) { DIR = d; }
function configPath() { return path.join(DIR, 'watchfolder-config.json'); }
function statePath()  { return path.join(DIR, 'watchfolder-state.json'); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }   // thiếu file hoặc JSON hỏng đều không được làm sập bridge
}

// Ghi qua file tạm rồi rename: bridge bị kill giữa chừng cũng không để lại
// file JSON cụt làm mất toàn bộ config.
function writeJson(file, data) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readConfig(projectPath) {
  const all = readJson(configPath(), {});
  const list = all && all[projectPath];
  return Array.isArray(list) ? list : [];
}

function writeConfig(projectPath, watches) {
  const all = readJson(configPath(), {}) || {};
  all[projectPath] = watches;
  writeJson(configPath(), all);
}

function readState()  { return readJson(statePath(), {}) || {}; }
function writeState(s) { writeJson(statePath(), s); }

module.exports = { setDir, readConfig, writeConfig, readState, writeState, configPath, statePath };
```

- [ ] **Step 4: Chạy test, phải pass**

Run: `cd bridge && node test/watchfolder-store.test.js`
Expected: `watchfolder-store: OK`

- [ ] **Step 5: Commit**

```bash
git add bridge/watchfolder-store.js bridge/test/watchfolder-store.test.js
git commit -m "feat(bridge): lưu config và state watch folder ở App Support, ghi atomic"
```

---

### Task 5: Engine — phát hiện file ổn định và xếp hàng đợi

**Files:**
- Create: `bridge/watchfolder.js`
- Test: `bridge/test/watchfolder-engine.test.js`

Engine nhận `scan` và `now` qua tham số để test điều khiển được thời gian và filesystem giả.

- [ ] **Step 1: Viết test fail trước**

Tạo `bridge/test/watchfolder-engine.test.js`:

```js
// bridge/test/watchfolder-engine.test.js
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { createEngine } = require('../watchfolder.js');
const store = require('../watchfolder-store.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-eng-'));
store.setDir(dir);

const PROJ = '/Users/x/Series_A.prproj';
const W = {
  id: 'w_1', enabled: true, label: 'Drone', folder: '/watched', binPath: 'Footage/Drone',
  recursive: true, maxDepth: 3, mirrorSubfolders: true,
  include: ['video'], includeRegex: '', excludeRegex: '',
  intervalMs: 3000, stableChecks: 2,
};

// Filesystem giả: test tự đặt nội dung mỗi lượt quét.
let fake = { ok: true, files: {}, truncated: false };
const scan = () => JSON.parse(JSON.stringify(fake));
let clock = 0;
const now = () => clock;

function newEngine() {
  return createEngine({ scan, now, store });
}

// ── 1. File có sẵn lúc tạo watch KHÔNG được import (Câu 3 = A) ────────────
fake = { ok: true, files: { 'old.mp4': [10, 1] }, truncated: false };
let eng = newEngine();
store.writeConfig(PROJ, [W]);
eng.start(PROJ);
eng.tick(); eng.tick(); eng.tick();
assert.deepStrictEqual(eng.poll(20).items, [], 'file có sẵn bị bỏ qua');

// ── 2. File mới chỉ vào queue sau khi ổn định qua stableChecks lượt ───────
fake.files['new.mp4'] = [100, 5];
eng.tick();
assert.deepStrictEqual(eng.poll(20).items, [], 'lượt đầu mới chỉ ghi nhận, chưa import');
fake.files['new.mp4'] = [200, 6];               // vẫn đang ghi
eng.tick();
assert.deepStrictEqual(eng.poll(20).items, [], 'size còn đổi thì chưa import');
fake.files['new.mp4'] = [200, 6];               // đứng yên
eng.tick();
let got = eng.poll(20).items;
assert.strictEqual(got.length, 1, 'ổn định rồi mới vào queue');
assert.strictEqual(got[0].filePath, path.join('/watched', 'new.mp4'), 'trả path tuyệt đối');
assert.strictEqual(got[0].binPath, 'Footage/Drone', 'kèm bin đích');
assert.strictEqual(got[0].watchId, 'w_1');

// ── 3. File 0 byte không bao giờ được coi là ổn định ──────────────────────
fake.files['empty.mp4'] = [0, 7];
eng.tick(); eng.tick(); eng.tick();
assert.ok(!eng.poll(20).items.some(i => /empty/.test(i.filePath)), 'file 0 byte bị hoãn');

// ── 4. ack done → biến khỏi queue và không quay lại ở lượt sau ────────────
const id = got[0].id;
eng.ack([id], []);
eng.tick();
assert.ok(!eng.poll(20).items.some(i => i.id === id), 'ack rồi thì không lặp lại');

// ── 5. ack failed → retry, quá 3 lần thì dead ────────────────────────────
fake.files['bad.mp4'] = [50, 9];
eng.tick(); eng.tick();
let bad = eng.poll(20).items.find(i => /bad\.mp4/.test(i.filePath));
assert.ok(bad, 'bad.mp4 vào queue');
for (let i = 0; i < 3; i++) {
  const cur = eng.poll(20).items.find(x => /bad\.mp4/.test(x.filePath));
  assert.ok(cur, 'lần thử ' + (i + 1) + ' vẫn còn trong queue');
  eng.ack([], [{ id: cur.id, reason: 'codec lạ' }]);
}
assert.ok(!eng.poll(20).items.some(i => /bad\.mp4/.test(i.filePath)),
  'quá 3 lần thất bại thì rời queue');
assert.ok(eng.stats().dead.some(d => /bad\.mp4/.test(d.filePath)), 'ghi nhận vào danh sách dead');

// ── 6. Thư mục biến mất → unavailable, quay lại KHÔNG import lại file cũ ──
fake = { ok: false, error: 'ENOENT', files: {}, truncated: false };
eng.tick();
assert.strictEqual(eng.stats().watches.find(w => w.id === 'w_1').status, 'unavailable',
  'mất thư mục → unavailable');
fake = { ok: true, files: { 'old.mp4': [10, 1], 'new.mp4': [200, 6] }, truncated: false };
eng.tick(); eng.tick(); eng.tick();
assert.deepStrictEqual(eng.poll(20).items, [],
  'thư mục quay lại không import lại file đã biết');

// ── 7. Quét bù sau khi stop/start: file rơi vào lúc panel đóng vẫn được import ──
eng.stop();
fake.files['while-closed.mp4'] = [77, 20];
const eng2 = newEngine();                       // bridge khởi động lại, đọc state từ đĩa
eng2.start(PROJ);
eng2.tick(); eng2.tick();
const caught = eng2.poll(20).items;
assert.strictEqual(caught.length, 1, 'đúng 1 file rơi lúc đóng');
assert.ok(/while-closed\.mp4/.test(caught[0].filePath), 'đúng file đó');

// ── 8. Interval thích ứng: lâu không có gì thì giãn ra ────────────────────
eng2.ack([caught[0].id], []);
assert.strictEqual(eng2.nextDelay(), 3000, 'vừa có file mới → giữ interval gốc');
clock += 121000;
eng2.tick();
assert.strictEqual(eng2.nextDelay(), 10000, 'hơn 2 phút không có gì → giãn lên 10s');

// ── 9. Thư mục quá lớn → tự hạ tần suất ──────────────────────────────────
fake.truncated = true;
eng2.tick();
assert.strictEqual(eng2.nextDelay(), 15000, 'vượt trần file → 15s');

// ── 10. Watch tắt thì không quét ─────────────────────────────────────────
fake = { ok: true, files: {}, truncated: false };
store.writeConfig(PROJ, [{ ...W, enabled: false }]);
const eng3 = newEngine();
eng3.start(PROJ);
fake.files['x.mp4'] = [10, 30];
eng3.tick(); eng3.tick(); eng3.tick();
assert.deepStrictEqual(eng3.poll(20).items, [], 'watch tắt thì bỏ qua hoàn toàn');

fs.rmSync(dir, { recursive: true, force: true });
console.log('watchfolder-engine: OK');
```

- [ ] **Step 2: Chạy để xác nhận fail**

Run: `cd bridge && node test/watchfolder-engine.test.js`
Expected: FAIL — `Cannot find module '../watchfolder.js'`

- [ ] **Step 3: Viết implementation tối thiểu**

Tạo `bridge/watchfolder.js`:

```js
// bridge/watchfolder.js
// Engine watch folder. Không import gì của Premiere — chỉ sinh ra hàng đợi
// đường dẫn file cho plugin xử lý.
//
// Vòng đời: start(projectPath) → tick() lặp theo nextDelay() → stop().
// Quét bù nằm ngay ở tick() đầu tiên sau start, vì snapshot được nạp từ đĩa.

const path = require('path');
const { matchFile, binPathFor, validateWatch } = require('./watchfolder-rules.js');
const { scanFolder } = require('./watchfolder-scan.js');
const defaultStore = require('./watchfolder-store.js');

const IDLE_MS         = 120000;   // không có file mới bao lâu thì giãn interval
const IDLE_INTERVAL   = 10000;
const HUGE_INTERVAL   = 15000;    // khi thư mục vượt trần số file
const MAX_QUEUE       = 500;
const MAX_TRIES       = 3;
const MAX_DEAD        = 200;
const STATE_FLUSH_MS  = 30000;

function createEngine(deps) {
  const d = deps || {};
  const scan  = d.scan  || ((folder, opts) => scanFolder(folder, opts));
  const now   = d.now   || (() => Date.now());
  const store = d.store || defaultStore;

  let projectPath = null;
  let watches = [];
  let state = {};              // watchId → { snapshot, pending, status }
  let queue = [];              // { id, watchId, filePath, binPath, tries }
  let dead  = [];              // { filePath, reason, at }
  let seq = 0;
  let lastNewAt = 0;
  let lastScanAt = 0;
  let lastFlushAt = 0;
  let huge = false;
  let running = false;

  function stateFor(w) {
    if (!state[w.id]) state[w.id] = { snapshot: {}, pending: {}, status: 'ok' };
    const s = state[w.id];
    if (!s.snapshot) s.snapshot = {};
    if (!s.pending)  s.pending  = {};
    return s;
  }

  function flush(force) {
    if (!force && now() - lastFlushAt < STATE_FLUSH_MS) return;
    lastFlushAt = now();
    const out = {};
    for (const id of Object.keys(state)) {
      out[id] = { snapshot: state[id].snapshot, status: state[id].status };
    }
    store.writeState({ byWatch: out, queue, dead, projectPath });
  }

  function start(p) {
    projectPath = p;
    watches = store.readConfig(p).filter(w => validateWatch(w).ok);
    const saved = store.readState() || {};
    const by = saved.byWatch || {};
    state = {};
    for (const w of watches) {
      state[w.id] = {
        snapshot: (by[w.id] && by[w.id].snapshot) || null,   // null = chưa có baseline
        pending: {},
        status: 'ok',
      };
    }
    queue = (saved.projectPath === p && Array.isArray(saved.queue)) ? saved.queue : [];
    dead  = (saved.projectPath === p && Array.isArray(saved.dead))  ? saved.dead  : [];
    running = true;
    lastNewAt = now();
    return { watches, queued: queue.length };
  }

  function stop() {
    if (running) { tick(); }      // quét lượt cuối để snapshot sát thực tế nhất
    running = false;
    flush(true);
  }

  function tickWatch(w) {
    const s = stateFor(w);
    const res = scan(w.folder, {
      recursive: w.recursive, maxDepth: w.maxDepth,
    });

    if (!res.ok) {
      // Thư mục mất (rút ổ, mất NAS). Giữ nguyên snapshot — nếu xoá đi thì lúc
      // ổ quay lại toàn bộ file cũ sẽ bị coi là mới và import lại hàng loạt.
      s.status = 'unavailable';
      s.pending = {};
      return;
    }
    s.status = 'ok';
    if (res.truncated) huge = true;

    // Lần đầu thấy watch này: chỉ chụp baseline, không import gì (Câu 3 = A).
    if (s.snapshot === null) {
      s.snapshot = res.files;
      return;
    }

    const cur = res.files;
    for (const rel of Object.keys(cur)) {
      if (s.snapshot[rel]) continue;          // đã biết từ trước
      if (!matchFile(w, rel)) continue;

      const [size, mtime] = cur[rel];
      if (size === 0) { s.pending[rel] = { size, mtime, count: 1 }; continue; }

      const prev = s.pending[rel];
      if (prev && prev.size === size && prev.mtime === mtime) {
        prev.count += 1;
        if (prev.count >= (Number(w.stableChecks) || 2)) {
          enqueue(w, rel);
          delete s.pending[rel];
          s.snapshot[rel] = [size, mtime];
        }
      } else {
        s.pending[rel] = { size, mtime, count: 1 };
      }
    }

    // File biến mất trước khi kịp ổn định thì bỏ khỏi pending.
    for (const rel of Object.keys(s.pending)) if (!cur[rel]) delete s.pending[rel];
  }

  function enqueue(w, rel) {
    if (queue.length >= MAX_QUEUE) return;    // trần chống phình bộ nhớ
    queue.push({
      id: 'q' + (++seq) + '_' + now(),
      watchId: w.id,
      filePath: path.join(w.folder, rel.split('/').join(path.sep)),
      binPath: binPathFor(w, rel),
      tries: 0,
    });
    lastNewAt = now();
  }

  function tick() {
    if (!running) return;
    huge = false;
    for (const w of watches) {
      if (w.enabled === false) continue;
      tickWatch(w);
    }
    lastScanAt = now();
    flush(false);
  }

  function scanNow(watchId) {
    const w = watches.find(x => x.id === watchId);
    if (!w) return { ok: false, error: 'không tìm thấy watch' };
    tickWatch(w);
    flush(true);
    return { ok: true };
  }

  function poll(limit) {
    const n = Math.max(1, Number(limit) || 20);
    return { items: queue.slice(0, n), stats: stats() };
  }

  function ack(done, failed) {
    const doneSet = new Set(done || []);
    queue = queue.filter(it => !doneSet.has(it.id));

    for (const f of (failed || [])) {
      const it = queue.find(x => x.id === f.id);
      if (!it) continue;
      it.tries += 1;
      if (it.tries >= MAX_TRIES) {
        dead.unshift({ filePath: it.filePath, reason: f.reason || 'không rõ', at: now() });
        dead = dead.slice(0, MAX_DEAD);
        queue = queue.filter(x => x.id !== it.id);
      }
    }
    flush(true);
    return { queued: queue.length };
  }

  // Quét thưa dần khi không có gì xảy ra; có file mới là về lại ngay.
  function nextDelay() {
    if (huge) return HUGE_INTERVAL;
    const base = watches.reduce(
      (m, w) => Math.min(m, Number(w.intervalMs) || 3000), 3000);
    if (now() - lastNewAt > IDLE_MS) return Math.max(base, IDLE_INTERVAL);
    return base;
  }

  function stats() {
    return {
      running, projectPath, queued: queue.length, lastScanAt, dead,
      watches: watches.map(w => ({
        id: w.id, label: w.label, enabled: w.enabled !== false,
        status: (state[w.id] && state[w.id].status) || 'ok',
      })),
    };
  }

  return { start, stop, tick, scanNow, poll, ack, nextDelay, stats };
}

module.exports = { createEngine, MAX_QUEUE, MAX_TRIES };
```

- [ ] **Step 4: Chạy test, phải pass**

Run: `cd bridge && node test/watchfolder-engine.test.js`
Expected: `watchfolder-engine: OK`

- [ ] **Step 5: Commit**

```bash
git add bridge/watchfolder.js bridge/test/watchfolder-engine.test.js
git commit -m "feat(bridge): engine watch folder — ổn định file, hàng đợi, retry, interval thích ứng"
```

---

### Task 6: 6 endpoint trong `server.js`

**Files:**
- Modify: `bridge/server.js` (thêm khối mới ngay trước `app.listen`, và sửa `BRIDGE_VERSION` ở dòng ~2963)
- Test: `bridge/test/watchfolder-endpoints.test.js`

- [ ] **Step 1: Viết test fail trước**

Tạo `bridge/test/watchfolder-endpoints.test.js`. Test khởi động server thật trên port 3031 để không đụng bridge đang chạy:

```js
// bridge/test/watchfolder-endpoints.test.js
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

process.env.PORT = '3031';
process.env.WATCHFOLDER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ep-'));

const { app, watchEngine } = require('../server.js');
const PROJ = path.join(process.env.WATCHFOLDER_DIR, 'Series_A.prproj');
const WATCHED = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ep-watched-'));

const server = app.listen(3031, async () => {
  const base = 'http://127.0.0.1:3031';
  const post = (u, b) => fetch(base + u, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b || {}),
  }).then(r => r.json());
  const get = u => fetch(base + u).then(r => r.json());

  try {
    // 1. Ghi config — regex sai phải bị từ chối kèm lý do
    const bad = await post('/watch/config', {
      projectPath: PROJ,
      watches: [{ id: 'w_1', folder: WATCHED, binPath: 'F', include: ['video'],
                  intervalMs: 3000, excludeRegex: '[' }],
    });
    assert.strictEqual(bad.ok, false, 'regex sai → từ chối');
    assert.ok(/excludeRegex/.test(bad.error), 'lỗi nêu đúng trường: ' + bad.error);

    // 2. Ghi config hợp lệ
    const ok = await post('/watch/config', {
      projectPath: PROJ,
      watches: [{ id: 'w_1', enabled: true, label: 'T', folder: WATCHED, binPath: 'Footage',
                  recursive: true, maxDepth: 3, mirrorSubfolders: true, include: ['video'],
                  includeRegex: '', excludeRegex: '', intervalMs: 3000, stableChecks: 2 }],
    });
    assert.strictEqual(ok.ok, true, 'config hợp lệ được ghi');

    // 3. Đọc lại
    const cfg = await get('/watch/config?projectPath=' + encodeURIComponent(PROJ));
    assert.strictEqual(cfg.watches.length, 1, 'đọc lại đúng 1 watch');

    // 4. start → baseline, file có sẵn không vào queue
    fs.writeFileSync(path.join(WATCHED, 'old.mp4'), 'xxx');
    const started = await post('/watch/session/start', { projectPath: PROJ });
    assert.strictEqual(started.ok, true);
    watchEngine.tick(); watchEngine.tick();
    let p = await get('/watch/poll');
    assert.deepStrictEqual(p.items, [], 'file có sẵn không vào queue');

    // 5. File mới → vào queue sau khi ổn định
    fs.writeFileSync(path.join(WATCHED, 'new.mp4'), 'yyyy');
    watchEngine.tick(); watchEngine.tick();
    p = await get('/watch/poll');
    assert.strictEqual(p.items.length, 1, 'file mới vào queue');
    assert.ok(p.stats, 'poll trả kèm stats');

    // 6. ack
    const acked = await post('/watch/ack', { done: [p.items[0].id], failed: [] });
    assert.strictEqual(acked.ok, true);
    p = await get('/watch/poll');
    assert.deepStrictEqual(p.items, [], 'ack rồi queue rỗng');

    // 7. scan-now không ném với watchId lạ
    const sn = await post('/watch/scan-now', { watchId: 'khong-co' });
    assert.strictEqual(sn.ok, false, 'watchId lạ → ok:false, không sập');

    // 8. stop
    assert.strictEqual((await post('/watch/session/stop', {})).ok, true);

    console.log('watchfolder-endpoints: OK');
    server.close(); process.exit(0);
  } catch (e) {
    console.error(e); server.close(); process.exit(1);
  }
});
```

- [ ] **Step 2: Chạy để xác nhận fail**

Run: `cd bridge && node test/watchfolder-endpoints.test.js`
Expected: FAIL — `server.js` chưa export `{ app, watchEngine }`, hoặc endpoint trả 404.

- [ ] **Step 3: Thêm khối endpoint vào `server.js`**

Chèn ngay **trước** dòng `app.listen(` ở cuối `bridge/server.js`:

```js
// ── Watch folder: tự động import file mới vào bin ───────────────────────────
// Engine không biết gì về Premiere; nó chỉ sinh hàng đợi đường dẫn file, plugin
// poll về rồi gọi project.importFiles(). Xem docs/superpowers/specs/2026-09-17-*.
const wfStore  = require('./watchfolder-store.js');
const wfRules  = require('./watchfolder-rules.js');
const { createEngine } = require('./watchfolder.js');

if (process.env.WATCHFOLDER_DIR) wfStore.setDir(process.env.WATCHFOLDER_DIR);

const watchEngine = createEngine({});
let watchTimer = null;

function watchLoop() {
  clearTimeout(watchTimer);
  watchEngine.tick();
  watchTimer = setTimeout(watchLoop, watchEngine.nextDelay());
}

app.post('/watch/session/start', (req, res) => {
  try {
    const p = (req.body && req.body.projectPath) || '';
    if (!p) return res.status(400).json({ ok: false, error: 'thiếu projectPath' });
    const info = watchEngine.start(p);
    clearTimeout(watchTimer);
    watchTimer = setTimeout(watchLoop, watchEngine.nextDelay());
    res.json({ ok: true, watches: info.watches, queued: info.queued });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/watch/session/stop', (_req, res) => {
  try {
    clearTimeout(watchTimer); watchTimer = null;
    watchEngine.stop();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/watch/poll', (_req, res) => {
  try {
    const out = watchEngine.poll(20);
    res.json({ ok: true, items: out.items, stats: out.stats });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/watch/ack', (req, res) => {
  try {
    const b = req.body || {};
    res.json({ ok: true, ...watchEngine.ack(b.done || [], b.failed || []) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/watch/config', (req, res) => {
  try {
    const p = req.query.projectPath || '';
    if (!p) return res.status(400).json({ ok: false, error: 'thiếu projectPath' });
    res.json({ ok: true, watches: wfStore.readConfig(p) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/watch/config', (req, res) => {
  try {
    const b = req.body || {};
    if (!b.projectPath) return res.status(400).json({ ok: false, error: 'thiếu projectPath' });
    const list = Array.isArray(b.watches) ? b.watches : [];
    // Validate trước khi ghi: regex sai mà lọt vào file thì watch im lặng
    // import nhầm hoặc ném mỗi lượt quét.
    for (const w of list) {
      const v = wfRules.validateWatch(w);
      if (!v.ok) return res.json({ ok: false, error: (w.label || w.id || '?') + ': ' + v.error });
    }
    wfStore.writeConfig(b.projectPath, list);
    res.json({ ok: true, watches: list });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/watch/scan-now', (req, res) => {
  try {
    res.json(watchEngine.scanNow((req.body && req.body.watchId) || ''));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
```

- [ ] **Step 4: Export cho test và bump version**

Ở cuối `bridge/server.js`, thêm vào phần `module.exports` sẵn có (nếu chưa có thì tạo mới):

```js
module.exports.app = app;
module.exports.watchEngine = watchEngine;
```

Đồng thời sửa dòng `const BRIDGE_VERSION = '1.15.0';` (khoảng dòng 2963) thành:

```js
const BRIDGE_VERSION = '1.16.0';  // Watch folder: POST /watch/session/start|stop, GET /watch/poll, POST /watch/ack, GET|POST /watch/config, POST /watch/scan-now — bridge quét thư mục, plugin import vào bin. Prior 1.15.0: Trang Auto (/notify, /autoset/names, /autoset/voicedir).
```

Kiểm tra `app.listen` dùng biến `PORT`; nếu đang hard-code `3030` thì sửa dòng `const PORT = 3030;` thành `const PORT = Number(process.env.PORT) || 3030;` để test chạy được trên 3031.

- [ ] **Step 5: Chạy test, phải pass**

Run: `cd bridge && node test/watchfolder-endpoints.test.js`
Expected: `watchfolder-endpoints: OK`

- [ ] **Step 6: Chạy toàn bộ test**

Run: `cd bridge && npm test`
Expected: `ALL TESTS PASSED`

- [ ] **Step 7: Commit**

```bash
git add bridge/server.js bridge/test/watchfolder-endpoints.test.js
git commit -m "feat(bridge): 6 endpoint watch folder + bridge 1.16.0"
```

---

### Task 7: Markup tab Watch

**Files:**
- Modify: `plugin/index.html`
- Modify: `plugin/manifest.json`

- [ ] **Step 1: Thêm nút tab**

Trong `plugin/index.html`, sau dòng tab `subtext` (khoảng dòng 36), thêm:

```html
  <div class="tab-btn" role="button" data-tab="watch"><span data-ic="folder" data-ic-size="14"></span> WATCH</div>
```

- [ ] **Step 2: Thêm panel**

Trước `<script src="main.js"></script>` (khoảng dòng 1567), thêm:

```html
<!-- ═══════════════════════════════════════════════════════ -->
<!-- TAB: WATCH FOLDER                                      -->
<!-- ═══════════════════════════════════════════════════════ -->
<div class="tab-panel" id="tab-watch">
  <div class="wf-root">

    <!-- Thanh trạng thái -->
    <div class="wf-status">
      <div class="wf-status-line">
        <span class="wf-dot" id="wfDot"></span>
        <span id="wfStatusText">Chưa kết nối</span>
        <span class="wf-spacer"></span>
        <div class="wf-btn wf-btn-sm" id="wfPauseAll" role="button">Tạm dừng tất cả</div>
      </div>
      <div class="wf-status-sub" id="wfStatusSub"></div>
    </div>

    <!-- Danh sách watch: ĐÂY là vùng cuộn (inner child, không phải .wf-root) -->
    <div class="wf-list" id="wfList"></div>

    <div class="wf-actions">
      <div class="wf-btn wf-btn-primary" id="wfAdd" role="button">+ Thêm thư mục theo dõi</div>
    </div>

    <!-- Nhật ký, mặc định gập -->
    <div class="wf-log-wrap">
      <div class="wf-log-head" id="wfLogHead" role="button">
        <span id="wfLogCaret">▸</span> Nhật ký <span class="wf-log-count" id="wfLogCount"></span>
      </div>
      <div class="wf-log" id="wfLog" hidden></div>
    </div>

  </div>
</div>
```

- [ ] **Step 3: Nạp `watch.js` sau `main.js`**

Sửa dòng cuối thành:

```html
<script src="main.js"></script>
<script src="watch.js"></script>
```

Thứ tự này bắt buộc: `watch.js` dùng các global do `main.js` tạo (`BRIDGE_URL`, `claimKeyboard`).

- [ ] **Step 4: Bump version plugin**

Trong `plugin/manifest.json` sửa `"version": "5.7.1"` thành `"version": "5.8.0"`.

- [ ] **Step 5: Tạo `plugin/watch.js` rỗng để plugin không lỗi khi load**

```bash
printf '// plugin/watch.js — tab Watch Folder (xem Task 8-10)\n' > plugin/watch.js
```

- [ ] **Step 6: Kiểm tra thủ công**

Reload plugin trong UXP Developer Tool. Expected: tab **WATCH** xuất hiện, click vào thấy panel rỗng có nút "Thêm thư mục theo dõi", console không có lỗi.

- [ ] **Step 7: Commit**

```bash
git add plugin/index.html plugin/manifest.json plugin/watch.js
git commit -m "feat(plugin): khung tab Watch Folder (v5.8.0)"
```

---

### Task 8: Style tab Watch

**Files:**
- Modify: `plugin/styles.css`

- [ ] **Step 1: Thêm CSS vào cuối `plugin/styles.css`**

```css
/* ── Tab Watch Folder ───────────────────────────────────────────────────── */
/* UXP: không position:fixed, không z-index, không display:grid.
   Vùng cuộn phải là inner child (.wf-list) với flex:1 1 0 + min-height:0. */

.wf-root { display: flex; flex-direction: column; height: 100%; }

.wf-status { padding: 10px 12px; border-bottom: 1px solid #2a2438; flex: 0 0 auto; }
.wf-status-line { display: flex; align-items: center; gap: 8px; }
.wf-status-sub { margin-top: 4px; font-size: 11px; color: #8b8299; }
.wf-spacer { flex: 1 1 auto; }

.wf-dot { width: 8px; height: 8px; border-radius: 4px; background: #6b6478; flex: 0 0 auto; }
.wf-dot.ok    { background: #4ade80; }
.wf-dot.pause { background: #fbbf24; }
.wf-dot.err   { background: #f87171; }

.wf-list { flex: 1 1 0; min-height: 0; overflow-y: auto; padding: 8px 12px; }

.wf-card { border: 1px solid #2a2438; border-radius: 6px; margin-bottom: 8px; background: #1a1626; }
.wf-card.unavailable { border-color: #b4791f; }
.wf-card.invalid     { border-color: #f87171; }
.wf-card-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; }
.wf-card-title { font-weight: 600; }
.wf-card-path { font-size: 11px; color: #8b8299; padding: 0 10px 8px 10px; }
.wf-card-body { padding: 8px 10px; border-top: 1px solid #2a2438; }
.wf-card-body[hidden] { display: none; }

.wf-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.wf-row label { flex: 0 0 96px; font-size: 11px; color: #a79ebb; }
.wf-row input[type="text"], .wf-row input[type="number"] { flex: 1 1 auto; }

.wf-btn { padding: 4px 10px; border-radius: 4px; background: #2a2438; cursor: pointer;
          display: inline-block; font-size: 12px; }
.wf-btn:hover { background: #362e4a; }
.wf-btn-primary { background: #6d3ce0; }
.wf-btn-primary:hover { background: #7f52e8; }
.wf-btn-sm { font-size: 11px; padding: 2px 8px; }
.wf-actions { flex: 0 0 auto; padding: 8px 12px; }

/* Cây bin */
.wf-tree { max-height: 180px; overflow-y: auto; border: 1px solid #2a2438;
           border-radius: 4px; padding: 6px; margin-bottom: 8px; }
.wf-tree-row { padding: 2px 4px; cursor: pointer; border-radius: 3px; font-size: 12px; }
.wf-tree-row:hover { background: #2a2438; }
.wf-tree-row.selected { background: #6d3ce0; }
.wf-tree-new { color: #a78bfa; }
.wf-bin-hint { font-size: 11px; color: #8b8299; }

/* Nhật ký */
.wf-log-wrap { flex: 0 0 auto; border-top: 1px solid #2a2438; }
.wf-log-head { padding: 6px 12px; cursor: pointer; font-size: 12px; color: #a79ebb; }
.wf-log-count { color: #8b8299; }
.wf-log { max-height: 160px; overflow-y: auto; padding: 4px 12px 8px 12px;
          font-size: 11px; font-family: monospace; }
.wf-log-line { padding: 1px 0; color: #b9b1c8; }
.wf-log-line.err { color: #f87171; }
```

- [ ] **Step 2: Kiểm tra thủ công**

Reload plugin. Expected: panel Watch có thanh trạng thái trên, nút tím ở dưới, không tràn ngang, không có thanh cuộn ngang.

- [ ] **Step 3: Commit**

```bash
git add plugin/styles.css
git commit -m "style(plugin): giao diện tab Watch Folder"
```

---

### Task 9: Vòng đời session + poll + import (`watch.js` phần 1)

**Files:**
- Modify: `plugin/watch.js`
- Modify: `plugin/main.js:896` (bump `REQUIRED_BRIDGE`)

- [ ] **Step 1: Bump bridge tối thiểu**

Sửa `plugin/main.js` dòng 896:

```js
var REQUIRED_BRIDGE = '1.16.0'; // Plugin v5.8.0+ cần bridge ≥1.16.0 (tab Watch: /watch/session/start|stop, /watch/poll, /watch/ack, /watch/config, /watch/scan-now)
```

- [ ] **Step 2: Viết phần lõi của `plugin/watch.js`**

Ghi đè `plugin/watch.js` bằng:

```js
// plugin/watch.js — tab Watch Folder.
// Classic script, nạp SAU main.js nên dùng chung global: BRIDGE_URL, claimKeyboard.
// Mọi API Premiere đều async → await hết.

(function () {
  'use strict';

  var POLL_MS = 2000;

  var wfState = {
    projectPath: null,
    watches: [],
    paused: false,
    pollTimer: null,
    importing: false,
    sessionImported: 0,
    log: [],
  };

  // ── HTTP nhỏ gọn: UXP hỗ trợ fetch, nhưng bọc lại để lỗi mạng không ném ──
  function api(method, url, body) {
    return fetch(BRIDGE_URL + url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json(); })
      .catch(function (e) { return { ok: false, error: e.message, offline: true }; });
  }

  function wfLog(text, isErr) {
    var t = new Date();
    var hh = String(t.getHours()).padStart(2, '0');
    var mm = String(t.getMinutes()).padStart(2, '0');
    var ss = String(t.getSeconds()).padStart(2, '0');
    wfState.log.unshift({ time: hh + ':' + mm + ':' + ss, text: text, err: !!isErr });
    if (wfState.log.length > 200) wfState.log.length = 200;
    renderLog();
  }

  function renderLog() {
    var box = document.getElementById('wfLog');
    var cnt = document.getElementById('wfLogCount');
    if (cnt) cnt.textContent = '(' + wfState.log.length + ')';
    if (!box || box.hidden) return;
    box.innerHTML = '';
    wfState.log.forEach(function (l) {
      var d = document.createElement('div');
      d.className = 'wf-log-line' + (l.err ? ' err' : '');
      d.textContent = l.time + '  ' + l.text;
      box.appendChild(d);
    });
  }

  // ── Đường dẫn project đang mở ───────────────────────────────────────────
  // Project chưa lưu thì không có path → không tạo watch được, vì config gắn
  // theo projectPath.
  async function currentProjectPath() {
    try {
      var ppro = require('premierepro');
      var proj = await ppro.Project.getActiveProject();
      if (!proj) return null;
      var p = await proj.getPath();
      return p || null;
    } catch (e) { return null; }
  }

  // ── Session ─────────────────────────────────────────────────────────────
  async function startSession() {
    var p = await currentProjectPath();
    if (!p) { setStatusUI('err', 'Project chưa lưu — lưu .prproj trước khi tạo watch'); return; }
    wfState.projectPath = p;

    var cfg = await api('GET', '/watch/config?projectPath=' + encodeURIComponent(p));
    wfState.watches = (cfg && cfg.watches) || [];

    var r = await api('POST', '/watch/session/start', { projectPath: p });
    if (!r.ok) { setStatusUI('err', r.offline ? 'Bridge offline' : ('Lỗi: ' + r.error)); return; }

    renderWatches();
    setStatusUI('ok', 'Đang theo dõi');
    startPolling();
  }

  async function stopSession() {
    stopPolling();
    await api('POST', '/watch/session/stop', {});
  }

  function startPolling() {
    stopPolling();
    wfState.pollTimer = setInterval(pollOnce, POLL_MS);
    pollOnce();
  }

  function stopPolling() {
    if (wfState.pollTimer) clearInterval(wfState.pollTimer);
    wfState.pollTimer = null;
  }

  // ── Poll + import ───────────────────────────────────────────────────────
  async function pollOnce() {
    if (wfState.paused || wfState.importing) return;
    var r = await api('GET', '/watch/poll');
    if (!r.ok) { setStatusUI('err', r.offline ? 'Bridge offline' : ('Lỗi: ' + r.error)); return; }

    updateStatsUI(r.stats);
    if (!r.items || r.items.length === 0) return;

    wfState.importing = true;
    var done = [], failed = [];
    try {
      for (var i = 0; i < r.items.length; i++) {
        var it = r.items[i];
        try {
          await importOne(it);
          done.push(it.id);
          wfState.sessionImported += 1;
          wfLog('✓ ' + baseName(it.filePath) + ' → ' + it.binPath);
        } catch (e) {
          failed.push({ id: it.id, reason: e.message });
          wfLog('✗ ' + baseName(it.filePath) + ' — ' + e.message, true);
        }
      }
    } finally {
      wfState.importing = false;
    }

    await api('POST', '/watch/ack', { done: done, failed: failed });
    if (done.length > 0) {
      api('POST', '/notify', {
        title: 'Watch Folder',
        body: 'Đã import ' + done.length + ' file',
      });
    }
  }

  function baseName(p) { return String(p).split('/').pop().split('\\').pop(); }

  // ── Import một file vào đúng bin ────────────────────────────────────────
  // project.importFiles() KHÔNG trả về ProjectItem (xem main.js:2488), nên
  // phải import vào bin đích ngay bằng tham số targetBin thay vì import rồi
  // đi tìm clip để di chuyển.
  async function importOne(item) {
    var ppro = require('premierepro');
    var proj = await ppro.Project.getActiveProject();
    if (!proj) throw new Error('không có project đang mở');

    if (await findItemByPath(proj, item.filePath)) return;   // đã có, bỏ qua

    var bin = await ensureBinPath(proj, item.binPath);
    if (typeof proj.importFiles !== 'function') throw new Error('không có API importFiles');
    await proj.importFiles([item.filePath], true, bin);
  }

  window.wfInternals = {     // để Task 10 dùng lại, và để gỡ lỗi từ console
    api: api, wfLog: wfLog, wfState: wfState,
    startSession: startSession, stopSession: stopSession,
    currentProjectPath: currentProjectPath,
  };
})();
```

- [ ] **Step 3: Kiểm tra thủ công (chưa import được, vì Task 10 mới có `ensureBinPath`)**

Reload plugin. Expected: console báo `ensureBinPath is not defined` **chỉ khi** có file vào queue; tab mở được, status hiện "Bridge offline" nếu bridge tắt.

- [ ] **Step 4: Commit**

```bash
git add plugin/watch.js plugin/main.js
git commit -m "feat(plugin): vòng đời session và vòng poll import cho tab Watch"
```

---

### Task 10: Cây bin, render UI, form watch (`watch.js` phần 2)

**Files:**
- Modify: `plugin/watch.js`

- [ ] **Step 1: Thêm hàm bin và render vào trong IIFE của `plugin/watch.js`**

Chèn ngay trước dòng `window.wfInternals = {`:

```js
  // ── Cây bin ─────────────────────────────────────────────────────────────
  // So khớp tên bin KHÔNG phân biệt hoa thường để không sinh 'Footage' và
  // 'footage' song song.
  async function childBinByName(parent, name) {
    var n = await parent.getItems();
    for (var i = 0; i < n.length; i++) {
      var it = n[i];
      var nm = await it.name;
      if (String(nm).toLowerCase() === String(name).toLowerCase()) {
        if (typeof it.getItems === 'function') return it;   // chỉ nhận bin
      }
    }
    return null;
  }

  async function ensureBinPath(proj, binPath) {
    var root = await proj.getRootItem();
    var cur = root;
    var parts = String(binPath).split('/').filter(function (s) { return s.trim(); });
    for (var i = 0; i < parts.length; i++) {
      var existing = await childBinByName(cur, parts[i]);
      if (existing) { cur = existing; continue; }
      cur = await proj.createBin(parts[i], cur);
      if (!cur) throw new Error('không tạo được bin ' + parts[i]);
    }
    return cur;
  }

  async function findItemByPath(proj, filePath) {
    var root = await proj.getRootItem();
    var want = String(filePath).toLowerCase();
    async function walk(node) {
      var kids = await node.getItems();
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (typeof k.getItems === 'function') {
          var hit = await walk(k);
          if (hit) return hit;
          continue;
        }
        try {
          var mp = await k.getMediaFilePath();
          if (mp && String(mp).toLowerCase() === want) return k;
        } catch (e) { /* item không có media path */ }
      }
      return null;
    }
    return await walk(root);
  }

  // Đọc cây bin để hiển thị cho người dùng chọn.
  async function readBinTree() {
    var ppro = require('premierepro');
    var proj = await ppro.Project.getActiveProject();
    if (!proj) return [];
    var root = await proj.getRootItem();
    var out = [];
    async function walk(node, prefix, depth) {
      if (depth > 6) return;
      var kids = await node.getItems();
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (typeof k.getItems !== 'function') continue;
        var nm = await k.name;
        var p = prefix ? prefix + '/' + nm : nm;
        out.push({ path: p, name: nm, depth: depth });
        await walk(k, p, depth + 1);
      }
    }
    await walk(root, '', 0);
    return out;
  }

  // ── Render ──────────────────────────────────────────────────────────────
  function setStatusUI(kind, text) {
    var dot = document.getElementById('wfDot');
    var txt = document.getElementById('wfStatusText');
    if (dot) dot.className = 'wf-dot ' + (kind === 'ok' ? 'ok' : kind === 'pause' ? 'pause' : 'err');
    if (txt) txt.textContent = text;
  }

  function updateStatsUI(stats) {
    var sub = document.getElementById('wfStatusSub');
    if (!sub || !stats) return;
    var name = wfState.projectPath ? baseName(wfState.projectPath) : '—';
    sub.textContent = stats.watches.length + ' watch · ' + name
      + ' · chờ ' + stats.queued + ' file · đã import ' + wfState.sessionImported + ' file phiên này';

    // Watch mất thư mục thì tô cảnh báo lên card tương ứng.
    stats.watches.forEach(function (w) {
      var card = document.querySelector('.wf-card[data-id="' + w.id + '"]');
      if (card) card.className = 'wf-card' + (w.status === 'unavailable' ? ' unavailable' : '');
    });
  }

  function newWatch() {
    return {
      id: 'w_' + Math.random().toString(36).slice(2, 8),
      enabled: true, label: 'Watch mới', folder: '', binPath: '',
      recursive: true, maxDepth: 3, mirrorSubfolders: true,
      include: ['video'], includeRegex: '', excludeRegex: '',
      intervalMs: 3000, stableChecks: 2,
    };
  }

  function renderWatches() {
    var list = document.getElementById('wfList');
    if (!list) return;
    list.innerHTML = '';
    wfState.watches.forEach(function (w) { list.appendChild(renderCard(w)); });
  }

  function renderCard(w) {
    var card = document.createElement('div');
    card.className = 'wf-card';
    card.setAttribute('data-id', w.id);

    var head = document.createElement('div');
    head.className = 'wf-card-head';
    var chk = document.createElement('input');
    chk.type = 'checkbox'; chk.checked = w.enabled !== false;
    chk.addEventListener('change', function () { w.enabled = chk.checked; saveConfig(); });
    var title = document.createElement('div');
    title.className = 'wf-card-title'; title.textContent = w.label || 'Watch';
    var spacer = document.createElement('div'); spacer.className = 'wf-spacer';
    var edit = document.createElement('div');
    edit.className = 'wf-btn wf-btn-sm'; edit.textContent = 'Sửa'; edit.setAttribute('role', 'button');
    var scanNow = document.createElement('div');
    scanNow.className = 'wf-btn wf-btn-sm'; scanNow.textContent = 'Quét ngay';
    scanNow.setAttribute('role', 'button');
    scanNow.addEventListener('click', function () { api('POST', '/watch/scan-now', { watchId: w.id }); });
    var del = document.createElement('div');
    del.className = 'wf-btn wf-btn-sm'; del.textContent = 'Xoá'; del.setAttribute('role', 'button');
    del.addEventListener('click', function () {
      wfState.watches = wfState.watches.filter(function (x) { return x.id !== w.id; });
      saveConfig(); renderWatches();
    });
    head.appendChild(chk); head.appendChild(title); head.appendChild(spacer);
    head.appendChild(scanNow); head.appendChild(edit); head.appendChild(del);

    var pathLine = document.createElement('div');
    pathLine.className = 'wf-card-path';
    pathLine.textContent = (w.folder || '(chưa chọn thư mục)') + '  →  ' + (w.binPath || '(chưa chọn bin)');

    var body = renderForm(w, card);
    body.hidden = !!w.folder;     // watch mới thì mở sẵn form
    edit.addEventListener('click', function () { body.hidden = !body.hidden; });

    card.appendChild(head); card.appendChild(pathLine); card.appendChild(body);
    return card;
  }

  function bindKeyboard(input) {
    input.addEventListener('focus', function () { if (window.claimKeyboard) window.claimKeyboard(); });
    input.addEventListener('blur',  function () { if (window.releaseKeyboard) window.releaseKeyboard(); });
  }

  function row(labelText, node) {
    var r = document.createElement('div'); r.className = 'wf-row';
    var l = document.createElement('label'); l.textContent = labelText;
    r.appendChild(l); r.appendChild(node);
    return r;
  }

  function renderForm(w, card) {
    var body = document.createElement('div');
    body.className = 'wf-card-body';

    // Tên
    var nameIn = document.createElement('input');
    nameIn.type = 'text'; nameIn.value = w.label || '';
    bindKeyboard(nameIn);
    nameIn.addEventListener('change', function () { w.label = nameIn.value; saveConfig(); renderWatches(); });
    body.appendChild(row('Tên', nameIn));

    // Thư mục
    var pickFolder = document.createElement('div');
    pickFolder.className = 'wf-btn'; pickFolder.setAttribute('role', 'button');
    pickFolder.textContent = w.folder || 'Chọn thư mục…';
    pickFolder.addEventListener('click', async function () {
      var uxpFs = require('uxp').storage.localFileSystem;
      var folder = await uxpFs.getFolder();
      if (!folder) return;
      w.folder = folder.nativePath;
      pickFolder.textContent = w.folder;
      if (!w.label || w.label === 'Watch mới') w.label = folder.name;
      saveConfig(); renderWatches();
    });
    body.appendChild(row('Thư mục', pickFolder));

    // Bin đích + cây bin
    var binLine = document.createElement('div');
    binLine.className = 'wf-btn'; binLine.setAttribute('role', 'button');
    binLine.textContent = w.binPath ? w.binPath.split('/').join(' / ') : 'Chọn bin…';
    var tree = document.createElement('div');
    tree.className = 'wf-tree'; tree.hidden = true;
    binLine.addEventListener('click', async function () {
      tree.hidden = !tree.hidden;
      if (tree.hidden) return;
      tree.innerHTML = '<div class="wf-bin-hint">Đang đọc cây bin…</div>';
      var bins = await readBinTree();
      tree.innerHTML = '';
      bins.forEach(function (b) {
        var r = document.createElement('div');
        r.className = 'wf-tree-row' + (b.path === w.binPath ? ' selected' : '');
        r.textContent = '  '.repeat(b.depth) + b.name;
        r.setAttribute('role', 'button');
        r.addEventListener('click', function () {
          w.binPath = b.path;
          binLine.textContent = b.path.split('/').join(' / ');
          tree.hidden = true; saveConfig(); renderWatches();
        });
        tree.appendChild(r);
      });
      var mk = document.createElement('div');
      mk.className = 'wf-tree-row wf-tree-new'; mk.textContent = '＋ Tạo bin mới…';
      mk.setAttribute('role', 'button');
      mk.addEventListener('click', function () {
        var inp = document.createElement('input');
        inp.type = 'text'; inp.value = w.binPath || 'Footage/';
        bindKeyboard(inp);
        inp.addEventListener('change', function () {
          w.binPath = inp.value.replace(/^\/+|\/+$/g, '');
          binLine.textContent = w.binPath.split('/').join(' / ');
          hint.textContent = 'sẽ được tạo khi import';
          tree.hidden = true; saveConfig(); renderWatches();
        });
        tree.innerHTML = ''; tree.appendChild(inp); inp.focus();
      });
      tree.appendChild(mk);
    });
    var hint = document.createElement('div');
    hint.className = 'wf-bin-hint';
    body.appendChild(row('Bin đích', binLine));
    body.appendChild(tree); body.appendChild(hint);

    // Loại file
    var kinds = document.createElement('div');
    [['video', 'Video'], ['audio', 'Audio'], ['image', 'Ảnh'], ['all', 'Tất cả']].forEach(function (pair) {
      var lab = document.createElement('label');
      lab.style.marginRight = '10px';
      var c = document.createElement('input');
      c.type = 'checkbox'; c.checked = w.include.indexOf(pair[0]) >= 0;
      c.addEventListener('change', function () {
        w.include = c.checked
          ? w.include.concat([pair[0]])
          : w.include.filter(function (k) { return k !== pair[0]; });
        saveConfig();
      });
      lab.appendChild(c); lab.appendChild(document.createTextNode(' ' + pair[1]));
      kinds.appendChild(lab);
    });
    body.appendChild(row('Loại file', kinds));

    // Toggle + regex + interval
    function checkRow(labelText, key) {
      var c = document.createElement('input');
      c.type = 'checkbox'; c.checked = w[key] !== false;
      c.addEventListener('change', function () { w[key] = c.checked; saveConfig(); });
      return row(labelText, c);
    }
    body.appendChild(checkRow('Quét thư mục con', 'recursive'));
    body.appendChild(checkRow('Mirror thành bin con', 'mirrorSubfolders'));

    function textRow(labelText, key, placeholder) {
      var i = document.createElement('input');
      i.type = 'text'; i.value = w[key] || ''; i.placeholder = placeholder || '';
      bindKeyboard(i);
      i.addEventListener('change', function () { w[key] = i.value; saveConfig(); });
      return row(labelText, i);
    }
    body.appendChild(textRow('Chỉ nhận (regex)', 'includeRegex', 'ví dụ ^DJI_'));
    body.appendChild(textRow('Loại trừ (regex)', 'excludeRegex', 'ví dụ _proxy$'));

    var iv = document.createElement('input');
    iv.type = 'number'; iv.value = w.intervalMs || 3000; iv.min = '1000'; iv.step = '1000';
    bindKeyboard(iv);
    iv.addEventListener('change', function () { w.intervalMs = Number(iv.value) || 3000; saveConfig(); });
    body.appendChild(row('Chu kỳ quét (ms)', iv));

    var err = document.createElement('div');
    err.className = 'wf-bin-hint'; err.setAttribute('data-role', 'err');
    body.appendChild(err);
    card.setAttribute('data-has-err', '0');

    return body;
  }

  // Bridge validate lại một lần nữa; regex sai thì hiện đỏ ngay trên card.
  async function saveConfig() {
    if (!wfState.projectPath) return;
    var r = await api('POST', '/watch/config', {
      projectPath: wfState.projectPath, watches: wfState.watches,
    });
    var list = document.getElementById('wfList');
    if (!r.ok) {
      wfLog('Config chưa lưu được — ' + r.error, true);
      if (list) list.classList.add('invalid');
      setStatusUI('err', r.error);
      return;
    }
    if (list) list.classList.remove('invalid');
    // Config đổi thì khởi động lại session để engine nạp watch mới.
    await api('POST', '/watch/session/start', { projectPath: wfState.projectPath });
    setStatusUI(wfState.paused ? 'pause' : 'ok', wfState.paused ? 'Tạm dừng' : 'Đang theo dõi');
  }

  // ── Gắn sự kiện UI ──────────────────────────────────────────────────────
  document.getElementById('wfAdd').addEventListener('click', function () {
    wfState.watches.push(newWatch());
    renderWatches();
  });

  document.getElementById('wfPauseAll').addEventListener('click', function () {
    wfState.paused = !wfState.paused;
    document.getElementById('wfPauseAll').textContent =
      wfState.paused ? 'Tiếp tục' : 'Tạm dừng tất cả';
    setStatusUI(wfState.paused ? 'pause' : 'ok', wfState.paused ? 'Tạm dừng' : 'Đang theo dõi');
  });

  document.getElementById('wfLogHead').addEventListener('click', function () {
    var box = document.getElementById('wfLog');
    box.hidden = !box.hidden;
    document.getElementById('wfLogCaret').textContent = box.hidden ? '▸' : '▾';
    renderLog();
  });

  // Mở tab Watch lần đầu mới khởi động session — tránh quét khi người dùng
  // không dùng tính năng này.
  var started = false;
  document.querySelector('.tab-btn[data-tab="watch"]').addEventListener('click', function () {
    if (started) return;
    started = true;
    startSession();
  });

  // Đổi project khi panel đang mở: dừng session cũ, mở session mới.
  setInterval(async function () {
    if (!started) return;
    var p = await currentProjectPath();
    if (p && p !== wfState.projectPath) {
      await stopSession();
      await startSession();
      wfLog('Đã chuyển sang project ' + baseName(p));
    }
  }, 5000);
```

- [ ] **Step 2: Kiểm tra thủ công — luồng chính**

1. Mở Premiere với một project đã lưu, bridge đang chạy (`cd bridge && node server.js`).
2. Mở tab WATCH → status chấm xanh "Đang theo dõi".
3. Bấm "+ Thêm thư mục theo dõi" → chọn một thư mục trống → chọn bin → đóng form.
4. Copy một file `.mp4` vào thư mục đó.
5. Expected: trong ~6–9s clip xuất hiện trong bin đã chọn, nhật ký có dòng `✓ tên.mp4 → bin`.

- [ ] **Step 3: Kiểm tra thủ công — checklist còn lại**

| Trường hợp | Kỳ vọng |
|---|---|
| File đã có sẵn trong thư mục trước khi tạo watch | Không được import |
| Tạo subfolder trong thư mục watch rồi copy file vào | Tạo bin con cùng tên, clip vào đúng bin con |
| Copy lại chính file đã import | Bỏ qua, không nhân đôi clip |
| Gõ `[` vào ô "Loại trừ (regex)" | Nhật ký đỏ báo lỗi, config không lưu |
| Đóng panel, copy file vào, mở lại panel | File được import bù |
| Rút ổ/ngắt NAS đang watch | Card viền vàng, không spam lỗi |
| Project chưa lưu | Status đỏ "Project chưa lưu", không tạo được watch |
| Gõ chữ vào ô Tên | Không kích hoạt phím tắt B/V/C của Premiere |

- [ ] **Step 4: Commit**

```bash
git add plugin/watch.js
git commit -m "feat(plugin): cây bin, form cấu hình và render tab Watch Folder"
```

---

### Task 11: Tài liệu và chạy toàn bộ test

**Files:**
- Modify: `CLAUDE.md` (bảng "Bridge endpoints")
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Thêm endpoint vào bảng trong `CLAUDE.md`**

Thêm vào cuối bảng "Bridge endpoints":

```markdown
| `/watch/session/start` | POST | Mở session watch cho một project, quét bù file rơi lúc panel đóng |
| `/watch/session/stop` | POST | Quét lượt cuối, ghi snapshot, dừng quét |
| `/watch/poll` | GET | Lấy tối đa 20 file chờ import + thống kê |
| `/watch/ack` | POST | Báo file đã import xong / thất bại |
| `/watch/config` | GET/POST | Đọc/ghi danh sách watch của project hiện tại |
| `/watch/scan-now` | POST | Quét ép một watch, không đợi chu kỳ |
```

- [ ] **Step 2: Thêm mục vào `CHANGELOG.md`**

Thêm lên đầu file, dưới tiêu đề:

```markdown
## 5.8.0 — Watch Folder

- Tab **Watch**: theo dõi nhiều thư mục, tự import file mới vào bin đã chọn.
- Mỗi watch có bin đích riêng, lọc theo loại file + regex, mirror subfolder thành bin con.
- Bỏ qua file có sẵn lúc tạo watch; chờ file ghi xong mới import; bỏ qua file đã có trong project.
- Quét bù khi mở lại panel, nên file rơi vào lúc Premiere đóng vẫn được import.
- Bridge 1.16.0: 6 endpoint `/watch/*`.
```

- [ ] **Step 3: Chạy toàn bộ test bridge**

Run: `cd bridge && npm test`
Expected: `ALL TESTS PASSED`

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: tài liệu tính năng Watch Folder (v5.8.0 / bridge 1.16.0)"
```

---

## Ghi chú rủi ro cho người triển khai

**Chữ ký `importFiles` có thể khác.** Task 9 gọi `proj.importFiles([path], true, bin)`. Trong `main.js` các chỗ gọi hiện tại chỉ truyền mảng path (`main.js:5792`, `:6616`, `:8307`) rồi tự đi tìm clip vừa import vì hàm **không trả về ProjectItem**. Nếu tham số `targetBin` không được UXP API hỗ trợ ở phiên bản Premiere đang dùng, fallback: gọi `await proj.importFiles([path])`, rồi dùng `findItemByPath()` (đã có trong Task 10) tìm clip vừa vào và di chuyển sang bin đích bằng API move của Premiere. Kiểm tra trước bằng cách đọc lại `main.js:5787-5800` — đó là chỗ gần nhất đã giải quyết đúng bài toán này.

**Chu kỳ import thực tế.** Với `stableChecks: 2` và `intervalMs: 3000`, một file mới mất khoảng 6–9 giây từ lúc ghi xong tới lúc vào bin. Đây là đánh đổi có chủ ý để không import file render dở, không phải bug.
