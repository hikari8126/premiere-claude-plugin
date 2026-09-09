# Toggle Auto-save SRT trong VO Setting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm option bật/tắt auto-save cho file SRT trong VO Setting; khi tắt, plugin mở hộp thoại Save cho người dùng tự chọn nơi lưu thay vì tự tìm cạnh file VO.

**Architecture:** Chỉ sửa phía plugin. Một checkbox trong panel settings Voice Gen ghi trạng thái vào `localStorage`. Hàm `stResolveOutputPath()` đọc trạng thái đó: BẬT → giữ nguyên logic cũ (VO folder → last folder → getFolder); TẮT → gọi `getFileForSaving()` cho người dùng chọn thư mục + tên. Bridge (`fs.writeFileSync`) không đổi.

**Tech Stack:** UXP plugin (non-module `main.js`, ~7300+ dòng), HTML/CSS thuần, `localStorage`, `require('uxp').storage.localFileSystem`.

## Global Constraints

- **UXP constraints:** không `position:fixed`, `z-index`, `display:grid`, `new Audio()`, `title=""`. Mọi Premiere API là async (`await`).
- **Không ES modules** trong `main.js` — dùng `var`/`function`, không `import`/`export`.
- **Không sửa bridge** — `server.js` giữ nguyên; `.srt` vẫn ghi qua endpoint hiện có.
- **Persistence:** `localStorage` (sync). Key mới: `st_srt_autosave` = `'1'` (bật) / `'0'` (tắt). Chưa đặt → coi như BẬT.
- **Không có test harness cho plugin JS** — verify bằng static check (`node -c`, grep) + test thủ công trong Premiere.
- **Tên file suggested** khi tắt = kết quả `stOutputBasename()` + `.srt` (giữ nguyên quy tắc đặt tên theo version sequence).

---

### Task 1: Thêm checkbox "Tự động lưu SRT" vào panel settings Voice Gen

**Files:**
- Modify: `plugin/index.html` (khu Output Folder trong panel `data-stab="voicegen"`, quanh dòng 294–306)

**Interfaces:**
- Consumes: mẫu switch có sẵn `vg-toggleRow` + `vg-switch` + `vg-switchTrack` (tham chiếu `vgLangOverride`, index.html:256–261).
- Produces: phần tử `<input type="checkbox" id="stSrtAutoSave">` để Task 2 wiring.

- [ ] **Step 1: Thêm block HTML toggle**

Chèn ngay **sau** khối `Filename suffix` (đóng ở index.html:306), trước `</div><!-- /settings-tabPanel voicegen -->`:

```html
        <div class="vg-sg">
          <div class="vg-toggleRow">
            <span class="vg-sl">Tự động lưu SRT</span>
            <label class="vg-switch">
              <input type="checkbox" id="stSrtAutoSave" checked />
              <span class="vg-switchTrack"></span>
            </label>
          </div>
          <div class="setting-hint-inline">
            Bật: lưu cạnh file VO, tên theo version sequence. Tắt: hiện hộp thoại chọn nơi lưu.
          </div>
        </div>
```

- [ ] **Step 2: Verify phần tử tồn tại đúng 1 lần**

Run:
```bash
grep -c 'id="stSrtAutoSave"' plugin/index.html
```
Expected: `1`

- [ ] **Step 3: Verify nằm trong panel voicegen (không lọt sang panel khác)**

Run:
```bash
awk '/data-stab="voicegen"/{f=1} f&&/stSrtAutoSave/{print "OK dòng " NR; exit} /\/settings-tabPanel voicegen/{if(f){print "MISS"; exit}}' plugin/index.html
```
Expected: in ra `OK dòng <n>` (checkbox nằm trước khi panel voicegen đóng)

- [ ] **Step 4: Commit**

```bash
git add plugin/index.html
git commit -m "feat(sub): checkbox Tự động lưu SRT trong settings Voice Gen"
```

---

### Task 2: Helper trạng thái + wiring persist + nhánh chọn nơi lưu khi tắt

**Files:**
- Modify: `plugin/main.js` — thêm helper `stSrtAutoSaveOn()` và sửa `stResolveOutputPath()` (module Tạo Sub, gần dòng 11472); thêm wiring checkbox (gần dòng 11655).

**Interfaces:**
- Consumes: `stOutputBasename()` (main.js:11451, async → trả basename không đuôi); `require('uxp').storage.localFileSystem`; phần tử `#stSrtAutoSave` từ Task 1; biến `$` (alias `document.getElementById`).
- Produces: `stSrtAutoSaveOn()` → `Boolean`; `stResolveOutputPath(forcePrompt)` async → trả `String` path đầy đủ (kèm `.srt`) hoặc `null` khi huỷ (chữ ký + kiểu trả về **không đổi**).

- [ ] **Step 1: Thêm helper `stSrtAutoSaveOn()` ngay TRƯỚC `stResolveOutputPath`**

Chèn trước dòng comment `// Chọn thư mục lưu .srt theo thứ tự ưu tiên:` (main.js:11465):

```js
  // Auto-save SRT bật/tắt (đặt trong settings Voice Gen). Chưa đặt → mặc định BẬT
  // để giữ nguyên hành vi cũ (lưu cạnh VO). '0' = tắt (hỏi nơi lưu mỗi lần).
  function stSrtAutoSaveOn() {
    var v = localStorage.getItem('st_srt_autosave');
    return v == null ? true : v === '1';
  }
```

- [ ] **Step 2: Thêm nhánh "tắt auto-save" vào ĐẦU `stResolveOutputPath`**

Sửa thân hàm `stResolveOutputPath` (main.js:11472). Thay đoạn đầu:

```js
  async function stResolveOutputPath(forcePrompt) {
    var folder = '';
    if (!forcePrompt) {
```

thành:

```js
  async function stResolveOutputPath(forcePrompt) {
    var base = await stOutputBasename();
    // Auto-save TẮT → luôn mở hộp thoại Save để user chọn thư mục + tên (bỏ qua tự tìm).
    if (!stSrtAutoSaveOn()) {
      try {
        var lfsSave = require('uxp').storage.localFileSystem;
        var file = await lfsSave.getFileForSaving(base + '.srt');
        if (!file) return null; // user Cancel
        var chosen = file.nativePath || file.path || '';
        if (chosen) {
          localStorage.setItem('vg_last_save_folder', chosen.replace(/[\/\\][^\/\\]*$/, ''));
          return chosen;
        }
        return null;
      } catch (e) { throw new Error('Không chọn được nơi lưu: ' + e.message); }
    }
    var folder = '';
    if (!forcePrompt) {
```

Rồi **xoá** dòng `var base = await stOutputBasename();` cũ ở cuối hàm (main.js:11487) để tránh khai báo lại `base` — dòng return cuối giữ nguyên:

```js
    return folder.replace(/[\/\\]+$/, '') + '/' + base + '.srt';
```

- [ ] **Step 3: Thêm wiring checkbox (set trạng thái + persist) sau listener `stUseAI`**

Chèn ngay sau main.js:11655 (`if (stUseAIEl) stUseAIEl.addEventListener(...)`):

```js
  var stAutoSaveEl = $('stSrtAutoSave');
  if (stAutoSaveEl) {
    stAutoSaveEl.checked = stSrtAutoSaveOn();
    stAutoSaveEl.addEventListener('change', function () {
      localStorage.setItem('st_srt_autosave', stAutoSaveEl.checked ? '1' : '0');
    });
  }
```

- [ ] **Step 4: Verify cú pháp JS còn hợp lệ**

Run:
```bash
node -c plugin/main.js && echo "SYNTAX OK"
```
Expected: `SYNTAX OK`

- [ ] **Step 5: Verify không khai báo lại `base` hai lần trong hàm**

Run:
```bash
awk 'NR>=11472 && NR<=11500 && /var base = await stOutputBasename/' plugin/main.js | wc -l | tr -d ' '
```
Expected: `1` (chỉ còn 1 khai báo `base`, ở đầu hàm)

- [ ] **Step 6: Verify các symbol khớp nhau**

Run:
```bash
grep -c 'stSrtAutoSaveOn' plugin/main.js   # định nghĩa 1 + dùng 2 = 3
grep -c 'st_srt_autosave' plugin/main.js   # helper đọc 1 + wiring ghi 1 = 2
```
Expected: `3` và `2`

- [ ] **Step 7: Commit**

```bash
git add plugin/main.js
git commit -m "feat(sub): tắt auto-save SRT → mở Save dialog chọn nơi lưu"
```

---

### Task 3: Bump version + CHANGELOG

**Files:**
- Modify: `plugin/manifest.json` (dòng `"version"`)
- Modify: `plugin/main.js` (`PLUGIN_VERSION`, main.js:794)
- Modify: `CHANGELOG.md` (thêm entry đầu file)

**Interfaces:**
- Consumes: version hiện tại `5.6.1`.
- Produces: version `5.6.2` đồng bộ ở manifest + `PLUGIN_VERSION` + CHANGELOG.

- [ ] **Step 1: Bump manifest**

Sửa `plugin/manifest.json`: `"version": "5.6.1",` → `"version": "5.6.2",`

- [ ] **Step 2: Bump `PLUGIN_VERSION` trong main.js**

Sửa main.js:794: `var PLUGIN_VERSION = 'v5.6.1';` → `var PLUGIN_VERSION = 'v5.6.2';`
(giữ nguyên comment mô tả phía sau hoặc cập nhật ngắn gọn nếu muốn — không bắt buộc)

- [ ] **Step 3: Thêm entry CHANGELOG**

Chèn ngay sau dòng `> Dùng làm reference...` (đầu `CHANGELOG.md`, trước `## v5.6.1`):

```markdown
## v5.6.2 — 2026-09-09

> Bridge không đổi (vẫn 1.15.0). Chỉ sửa plugin.

**Tạo Sub: option bật/tắt tự động lưu SRT.** Thêm toggle "Tự động lưu SRT" trong Settings ▸ Voice Gen.

### ✅ Thêm mới
- **Toggle "Tự động lưu SRT"** (Settings ▸ Voice Gen) — mặc định BẬT, nhớ trạng thái qua localStorage (`st_srt_autosave`).
- **BẬT** (như 5.6.1): `.srt` tự lưu cạnh file VO, tên theo version sequence.
- **TẮT**: sau khi tạo xong mở hộp thoại **Save** (`getFileForSaving`) — chọn được cả thư mục lẫn tên, gợi ý sẵn tên theo version. Cancel → huỷ, không tạo file.

### 🔧 Kỹ thuật
- `stResolveOutputPath()` rẽ nhánh theo `stSrtAutoSaveOn()`; nhánh tắt dùng `localFileSystem.getFileForSaving(base + '.srt')`, nhớ thư mục vào `vg_last_save_folder`. Bridge (`fs.writeFileSync`) không đổi.

```

- [ ] **Step 4: Verify version đồng bộ**

Run:
```bash
grep -m1 '"version"' plugin/manifest.json; grep -m1 "PLUGIN_VERSION = " plugin/main.js; grep -m1 "## v5.6.2" CHANGELOG.md
```
Expected: manifest `5.6.2`, `PLUGIN_VERSION = 'v5.6.2'`, có dòng `## v5.6.2`

- [ ] **Step 5: Verify JS còn hợp lệ**

Run:
```bash
node -c plugin/main.js && echo "SYNTAX OK"
```
Expected: `SYNTAX OK`

- [ ] **Step 6: Commit**

```bash
git add plugin/manifest.json plugin/main.js CHANGELOG.md
git commit -m "chore: bump v5.6.2 — toggle auto-save SRT"
```

---

## Kiểm thử thủ công (sau khi code xong — trong Premiere)

> Không có test tự động cho plugin UXP. Reload plugin trong UXP Developer Tool rồi kiểm:

1. **Mặc định:** mở Settings ▸ Voice Gen → toggle "Tự động lưu SRT" đang **bật**. Tạo sub → `.srt` lưu cạnh VO như 5.6.1.
2. **Tắt → tạo sub:** tắt toggle, tạo sub → hiện hộp thoại Save, tên gợi ý `vNN.N.srt`; đổi thư mục + tên rồi lưu → file đúng chỗ đã chọn, import vào project OK.
3. **Tắt → Cancel:** bấm Cancel trong dialog → status "Đã huỷ — chưa chọn thư mục lưu.", không có file.
4. **Persist:** tắt toggle → đóng/mở lại Settings (hoặc reload plugin) → toggle vẫn tắt.
5. **Bật lại:** về lại hành vi tự lưu cạnh VO.

## Self-Review

- **Spec coverage:** UI checkbox (Task 1) ✓ · persist localStorage (Task 2 step 3) ✓ · getFileForSaving khi tắt (Task 2 step 2) ✓ · mặc định BẬT (Task 2 step 1) ✓ · giữ logic cũ khi bật (Task 2 step 2 giữ nguyên phần dưới) ✓ · nhớ thư mục (Task 2 step 2) ✓ · bump version + changelog (Task 3) ✓.
- **Placeholder scan:** không có TBD/TODO; mọi code step có code thật, mọi verify step có lệnh + expected.
- **Type consistency:** `stSrtAutoSaveOn()` (Boolean) dùng nhất quán ở helper + wiring + `stResolveOutputPath`; `base` khai báo đúng 1 lần sau sửa; key `st_srt_autosave` khớp giữa đọc/ghi.
