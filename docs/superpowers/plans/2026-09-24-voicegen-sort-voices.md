# Voice Gen — Sắp xếp list voice clone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm `<select>` sắp xếp list voice clone (Settings ▸ Voice Gen) theo Mới nhất / Cũ nhất / Tên A→Z / Z→A, nhớ lựa chọn; không đụng xoá/search.

**Architecture:** Tách hàm so sánh thuần `elvSortComparator(mode)` ra `plugin/elv-sort.js` (test node được, giống `csv-parse.js`). `main.js` giữ thêm `created` khi map voice, thêm `elvSortMode()`/`elvSortVoices()`, gọi `elvSortVoices()` đầu `elvRenderList()`, và wire `<select>`.

**Tech Stack:** UXP plugin (non-module classic scripts), Node `assert`, `Array.prototype.sort`, `String.localeCompare`.

## Global Constraints

- **Không đụng bridge.** Chỉ sửa `plugin/`.
- **Không đụng** logic xoá (`elvDeleteBtn`/`elvDoDelete`), search (`elvFilterRows`), slot-count.
- Non-module UXP: `var`/`function`, không `import`/`export`; ràng buộc UXP (không `position:fixed`/`z-index`/`display:grid`).
- 4 mã sort: `newest` (mặc định), `oldest`, `name_az`, `name_za`.
- Voice có `created == null` (API không trả `created_at_unix`) → luôn xếp **cuối** ở newest/oldest.
- `created` bằng nhau → tie-break theo `name` (ổn định).
- Tên so sánh **không phân biệt hoa/thường** (`localeCompare(..., undefined, {sensitivity:'base'})`).
- Persist `localStorage['elv_sort_mode']`, mặc định `'newest'`.
- `elv-sort.js` nạp **trước** `main.js`.
- Bump version **5.9.1** (nhiều branch mở song song — hoà giải số version lúc merge nếu trùng).

---

### Task 1: Hàm so sánh thuần + node test (`plugin/elv-sort.js`)

**Files:**
- Create: `plugin/elv-sort.js`
- Create (test): `bridge/test/elv-sort.test.js`

**Interfaces:**
- Produces: `elvSortComparator(mode: string) → (a,b)=>number` — trả hàm so sánh cho `Array.sort` trên các object `{name, created}`. Quy tắc: `name_az`/`name_za` theo name; còn lại (`newest` mặc định / `oldest`) theo `created` (null luôn cuối, tie-break theo name). Gắn global (`window`/`globalThis`) + `module.exports`.

- [ ] **Step 1: Viết test thất bại**

Tạo `bridge/test/elv-sort.test.js`:

```js
// bridge/test/elv-sort.test.js
const assert = require('assert');
const { elvSortComparator } = require('../../plugin/elv-sort.js');
function ids(a) { return a.map(function (v) { return v.id; }); }

// newest: created giảm dần, null cuối
var a = [{id:'a',name:'A',created:100},{id:'b',name:'B',created:300},{id:'c',name:'C',created:null},{id:'d',name:'D',created:200}];
a.sort(elvSortComparator('newest'));
assert.deepStrictEqual(ids(a), ['b','d','a','c'], 'newest 300,200,100,null');

// oldest: created tăng dần, null cuối
var b = [{id:'a',name:'A',created:100},{id:'b',name:'B',created:300},{id:'c',name:'C',created:null},{id:'d',name:'D',created:200}];
b.sort(elvSortComparator('oldest'));
assert.deepStrictEqual(ids(b), ['a','d','b','c'], 'oldest 100,200,300,null');

// name_az không phân biệt hoa/thường
var c = [{id:'x',name:'Beta'},{id:'y',name:'alpha'},{id:'z',name:'Gamma'}];
c.sort(elvSortComparator('name_az'));
assert.deepStrictEqual(ids(c), ['y','x','z'], 'alpha,Beta,Gamma');

// name_za
var d = [{id:'x',name:'Beta'},{id:'y',name:'alpha'},{id:'z',name:'Gamma'}];
d.sort(elvSortComparator('name_za'));
assert.deepStrictEqual(ids(d), ['z','x','y'], 'Gamma,Beta,alpha');

// created bằng nhau -> tie-break theo name
var e = [{id:'p',name:'Zed',created:100},{id:'q',name:'Abe',created:100}];
e.sort(elvSortComparator('newest'));
assert.deepStrictEqual(ids(e), ['q','p'], 'created bằng -> theo name');

// mode lạ/rỗng -> coi như newest
var f = [{id:'a',name:'A',created:1},{id:'b',name:'B',created:2}];
f.sort(elvSortComparator('bogus'));
assert.deepStrictEqual(ids(f), ['b','a'], 'mode lạ -> newest');

console.log('elv-sort tests passed');
```

- [ ] **Step 2: Chạy test — phải THẤT BẠI**

Run: `node bridge/test/elv-sort.test.js`
Expected: FAIL — `Cannot find module '../../plugin/elv-sort.js'`

- [ ] **Step 3: Tạo `plugin/elv-sort.js`**

```js
// plugin/elv-sort.js — hàm so sánh thuần cho sort list voice clone (Settings ▸ Voice Gen).
// Classic script nạp TRƯỚC main.js (expose global elvSortComparator); export cho node để test.
// KHÔNG đụng DOM. Thiết kế: docs/superpowers/specs/2026-09-24-voicegen-sort-voices-design.md

function elvSortComparator(mode) {
  function byName(a, b) {
    return String(a && a.name || '').localeCompare(String(b && b.name || ''), undefined, { sensitivity: 'base' });
  }
  function created(v) { return (v && typeof v.created === 'number') ? v.created : null; }

  if (mode === 'name_az') return byName;
  if (mode === 'name_za') return function (a, b) { return -byName(a, b); };

  // newest (mặc định) hoặc oldest — theo created, null luôn cuối, tie-break theo name.
  var dir = (mode === 'oldest') ? 1 : -1;
  return function (a, b) {
    var ca = created(a), cb = created(b);
    if (ca == null && cb == null) return byName(a, b);
    if (ca == null) return 1;   // a không có created -> xuống cuối
    if (cb == null) return -1;  // b không có created -> xuống cuối
    if (ca === cb) return byName(a, b);
    return (ca < cb ? -1 : 1) * dir;
  };
}

(function (root) {
  if (root) { root.elvSortComparator = elvSortComparator; }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { elvSortComparator: elvSortComparator };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
```

- [ ] **Step 4: Chạy test — phải PASS**

Run: `node bridge/test/elv-sort.test.js`
Expected: in `elv-sort tests passed`, exit 0.

- [ ] **Step 5: Chạy cả bộ test bridge**

Run: `cd bridge && npm test`
Expected: `ALL TESTS PASSED`.

- [ ] **Step 6: Commit**

```bash
git add plugin/elv-sort.js bridge/test/elv-sort.test.js
git commit -m "feat(voicegen): elv-sort.js — hàm so sánh sort voice + node test"
```

---

### Task 2: UI `<select>` + giữ created + wiring sort

**Files:**
- Modify: `plugin/index.html` (thêm `<script src="elv-sort.js">` trước main.js; thêm `<select>` sau `#elvVoiceSearch`)
- Modify: `plugin/styles.css` (thêm `.elv-sortSel`)
- Modify: `plugin/main.js` (giữ `created` khi map; `elvSortMode`/`elvSortVoices`; gọi trong `elvRenderList`; wire select)

**Interfaces:**
- Consumes: `elvSortComparator(mode)` (global từ Task 1); `elvVoices` (mảng `{id,name,category,created}`); `$` (getElementById); `elvRenderList`/`elvFilterRows`/`elvFetchState` sẵn có.
- Produces: `#elvSortSel`; `elvSortMode()`; `elvSortVoices()`.

- [ ] **Step 1: Nạp elv-sort.js TRƯỚC main.js**

`plugin/index.html` — trước `<script src="main.js"></script>` (dòng 1698):

```html
<script src="elv-sort.js"></script>
<script src="main.js"></script>
```

- [ ] **Step 2: Thêm `<select>` sau ô tìm voice**

`plugin/index.html` — chèn NGAY SAU `<input ... id="elvVoiceSearch" ... />` (dòng 227), trước `<div id="elvVoiceList" ...>`:

```html
          <select id="elvSortSel" class="vg-select elv-sortSel">
            <option value="newest">Mới nhất</option>
            <option value="oldest">Cũ nhất</option>
            <option value="name_az">Tên A→Z</option>
            <option value="name_za">Tên Z→A</option>
          </select>
```

- [ ] **Step 3: Thêm CSS `.elv-sortSel`**

`plugin/styles.css` — ngay sau khối `.elv-slotRow { ... }` (dòng 3993):

```css
.elv-sortSel { margin-top: 4px; }
```

- [ ] **Step 4: Giữ `created` khi map voice**

`plugin/main.js` — sửa dòng `.map(...)` trong `elvFetchState` (dòng 10720):

TỪ:
```js
        .map(function (v) { return { id: v.voice_id, name: v.name || '(no name)', category: v.category || '' }; });
```
THÀNH:
```js
        .map(function (v) { return { id: v.voice_id, name: v.name || '(no name)', category: v.category || '', created: (typeof v.created_at_unix === 'number' ? v.created_at_unix : null) }; });
```

- [ ] **Step 5: Thêm `elvSortMode` + `elvSortVoices` và gọi trong `elvRenderList`**

`plugin/main.js` — chèn 2 hàm NGAY TRƯỚC `function elvRenderList() {` (dòng 10753):

```js
  function elvSortMode() {
    var m = localStorage.getItem('elv_sort_mode');
    return (m === 'oldest' || m === 'name_az' || m === 'name_za') ? m : 'newest';
  }
  function elvSortVoices() {
    var cmp = (typeof window !== 'undefined' && window.elvSortComparator) ? window.elvSortComparator : elvSortComparator;
    elvVoices.sort(cmp(elvSortMode()));
  }
```

Rồi thêm `elvSortVoices();` làm dòng ĐẦU TIÊN trong thân `elvRenderList` (ngay sau `function elvRenderList() {`):

```js
  function elvRenderList() {
    elvSortVoices();
    var list = $('elvVoiceList'); if (!list) return;
```

- [ ] **Step 6: Wire `<select>` trong `elvWire`**

`plugin/main.js` — trong IIFE `elvWire()`, chèn NGAY SAU khối `if (es) { ... }` (đóng ở dòng ~10824), trước vòng `document.querySelectorAll('.settings-tab')`:

```js
    var ss = $('elvSortSel');
    if (ss) {
      ss.value = elvSortMode();
      ss.addEventListener('change', function () {
        localStorage.setItem('elv_sort_mode', ss.value);
        elvRenderList();
      });
    }
```

- [ ] **Step 7: Kiểm cú pháp + anchor**

Run:
```bash
node -c plugin/main.js && echo "MAIN OK"
node -c plugin/elv-sort.js && echo "SORT OK"
grep -n 'elv-sort.js\|main.js' plugin/index.html | head
grep -c 'elvSortSel\|elvSortVoices\|elv_sort_mode\|created_at_unix' plugin/main.js
grep -c 'id="elvSortSel"' plugin/index.html
```
Expected: `MAIN OK`, `SORT OK`; `elv-sort.js` đứng TRƯỚC `main.js`; các symbol xuất hiện (main.js: `elvSortSel`≥1, `elvSortVoices`≥2, `elv_sort_mode`≥2, `created_at_unix`≥1); index.html `id="elvSortSel"`=1.

- [ ] **Step 8: Verify không đụng xoá/search**

Run:
```bash
grep -c "elvDoDelete\|elvFilterRows\|elvOnDeleteClick" plugin/main.js
```
Expected: ≥3 (các hàm này vẫn còn — không bị xoá/sửa).

- [ ] **Step 9: Commit**

```bash
git add plugin/index.html plugin/styles.css plugin/main.js
git commit -m "feat(voicegen): select sắp xếp list voice (thời gian tạo / tên) + nhớ lựa chọn"
```

---

### Task 3: Bump version + CHANGELOG

**Files:**
- Modify: `plugin/manifest.json` (`"version"`)
- Modify: `plugin/main.js` (`PLUGIN_VERSION`, dòng 794)
- Modify: `CHANGELOG.md` (entry đầu)

**Interfaces:**
- Consumes: version hiện tại `5.8.2`.
- Produces: version `5.9.1` đồng bộ 3 nơi.

- [ ] **Step 1: Bump manifest**

`plugin/manifest.json`: `"version": "5.8.2",` → `"version": "5.9.1",`

- [ ] **Step 2: Bump PLUGIN_VERSION**

`plugin/main.js` dòng 794: đổi `'v5.8.2'` → `'v5.9.1'` và PREPEND ghi chú (giữ nguyên chuỗi mô tả v5.8.2 phía sau, KHÔNG xoá lịch sử):

```
var PLUGIN_VERSION = 'v5.9.1';  // Voice Gen settings: thêm select sắp xếp list voice clone (Mới nhất/Cũ nhất theo created_at_unix, Tên A→Z/Z→A), nhớ localStorage elv_sort_mode; voice thiếu created xếp cuối. Hàm so sánh thuần plugin/elv-sort.js + node test. KHÔNG cần bridge mới. v5.8.2 — <giữ nguyên toàn bộ chuỗi mô tả cũ>
```

- [ ] **Step 3: Thêm entry CHANGELOG**

Chèn ngay trên `## v5.8.2 / bridge app 3.13 ...` trong `CHANGELOG.md`:

```markdown
## v5.9.1 — 2026-09-24

> Chỉ sửa plugin. **Không cần bridge mới.**

**Voice Gen: sắp xếp list voice clone (Settings).**

### ✅ Thêm mới
- `<select>` sắp xếp list voice clone: **Mới nhất** (mặc định) / Cũ nhất (theo thời gian tạo `created_at_unix`) / Tên A→Z / Z→A. Nhớ lựa chọn qua `localStorage['elv_sort_mode']`.
- Voice API không trả thời gian tạo → xếp cuới; sort theo tên vẫn chạy. Xoá/search giữ nguyên.

### 🔧 Kỹ thuật
- Hàm so sánh thuần `plugin/elv-sort.js` (`elvSortComparator`) + node test `bridge/test/elv-sort.test.js`. `elvFetchState` giữ thêm `created`; `elvRenderList` sort trước khi dựng rows.
```

- [ ] **Step 4: Verify đồng bộ + test xanh**

Run:
```bash
grep -m1 '"version"' plugin/manifest.json; grep -m1 "PLUGIN_VERSION = " plugin/main.js | grep -oE "v5\.9\.1"; grep -m1 "## v5.9.1" CHANGELOG.md
node -c plugin/main.js && (cd bridge && npm test | tail -1)
```
Expected: manifest `5.9.1`, `v5.9.1`, có `## v5.9.1`; `ALL TESTS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add plugin/manifest.json plugin/main.js CHANGELOG.md
git commit -m "chore: bump v5.9.1 — sort voice list"
```

---

## Kiểm thử thủ công (trong Premiere — UXP không headless)

> Reload plugin qua **UXP Developer Tools → ⟳** (Premiere nạp từ repo `plugin/`).

1. Settings ▸ Voice Gen → có `<select>` sort dưới ô tìm voice; mặc định **Mới nhất**.
2. Đổi Cũ nhất / Tên A→Z / Z→A → list đảo đúng thứ tự.
3. Đóng/mở lại settings (hoặc reload) → select nhớ đúng lựa chọn.
4. Tick + Xoá 1 voice → list vẫn đúng sort; gõ tìm → lọc đúng trên thứ tự đã sort.
5. Kiểm rủi ro: nếu Mới nhất/Cũ nhất không đổi thứ tự → tài khoản không có `created_at_unix` (sort tên vẫn phải chạy).

## Self-Review

- **Spec coverage:** comparator thuần + test (Task 1) ✓ · 4 mã sort + null-cuối + tie-break + name không phân biệt hoa/thường (Task 1) ✓ · giữ `created` (Task 2 Step 4) ✓ · select UI + nạp elv-sort trước main (Task 2 Step 1-2) ✓ · gọi sort trong elvRenderList (Task 2 Step 5) ✓ · wire + persist mặc định newest (Task 2 Step 6, `elvSortMode`) ✓ · không đụng xoá/search (Task 2 Step 8 verify) ✓ · version bump (Task 3) ✓ · test node + thủ công ✓.
- **Placeholder scan:** không TBD/TODO; code step có code thật; verify step có lệnh + expected. (Ngoại lệ có chủ đích: Task 3 Step 2 giữ nguyên chuỗi mô tả v5.8.2 dài — chỉ prepend.)
- **Type consistency:** `elvSortComparator(mode)→cmp` dùng nhất quán Task 1↔Task 2; object có field `created` (Task 2 Step 4) khớp cái comparator đọc (Task 1); id `elvSortSel` khớp index.html/CSS/main.js; key `elv_sort_mode` khớp `elvSortMode` (đọc) và wire (ghi).
