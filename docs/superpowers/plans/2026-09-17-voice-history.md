# History voice đã dùng gần đây (Voice Gen) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm mục "Gần đây" trên sidebar phải Voice Gen, liệt kê các lần gen TTS gần nhất (tên voice + đoạn script), bấm một phát là đổi lại voice.

**Architecture:** Chỉ sửa phía plugin. Một mảng JSON trong `localStorage` (`vg_voice_history`, cap 20) được ghi ở nhánh thành công của `generate()` khi `currentMode === 'tts'`. Một section HTML mới dưới section Profile được render bằng DOM API, mặc định hiện 3 mục, nút "Xem thêm" giãn tại chỗ tối đa 20. Click dòng → `vgSetVoice` + dispatch `change` (đúng cách `vgDropSelect` làm); nút ↺ riêng nạp lại script. Bridge không đổi.

**Tech Stack:** UXP plugin (non-module `plugin/main.js`, ~11600 dòng), HTML/CSS thuần, `localStorage`.

**Spec:** `docs/superpowers/specs/2026-09-17-voice-history-design.md`

## Global Constraints

- **UXP constraints:** không `position:fixed`, `z-index`, `display:grid`, `new Audio()`, và **không attribute `title=""`** (đây là lý do script hiện thành dòng thứ hai chứ không nấp trong tooltip).
- **Không ES modules** trong `main.js` — dùng `var`/`function`, không `import`/`export`.
- **Không sửa bridge.**
- **Scope:** mọi hàm mới phải nằm **trong IIFE của Voice Gen** (khối chứa `vgRememberSavedName` ở `plugin/main.js:8462` và `vgRenderProfiles()` ở `plugin/main.js:10149`), vì chúng dùng `els`, `currentMode`, `vgVoiceName`, `vgSetVoice` — đều là biến cục bộ của IIFE đó.
- **Không có test harness cho plugin JS** (`bridge/test/*.test.js` chỉ chạy cho bridge). Verify bằng `node --check plugin/main.js` + `grep` + checklist thủ công trong Premiere ở Task 6.
- **Ẩn/hiện section:** section nằm ngoài `.vg-modeContent` nên phải tự ẩn khi `currentMode !== 'tts'`.

## File Structure

| File | Trách nhiệm | Thay đổi |
|---|---|---|
| `plugin/index.html` | Khung section "Gần đây" (3 phần tử rỗng, JS đổ nội dung) | +9 dòng sau `.vg-profileSection` |
| `plugin/main.js` | Đọc/ghi `localStorage`, render danh sách, wiring click/↺, hook vào `generate()` + `switchMode()` | +~90 dòng, 3 chỗ sửa nhỏ |
| `plugin/styles.css` | Style `.vg-histItem` / `.vg-histScript` / `.vg-histMore` | +~30 dòng cạnh `.vg-profileSection` |

Không tạo file mới: `main.js` là non-module script duy nhất, thêm file nghĩa là thêm `<script>` vào `index.html` và mất scope IIFE chung.

---

### Task 1: Khung HTML section "Gần đây"

**Files:**
- Modify: `plugin/index.html` (ngay sau `.vg-profileSection`, đóng ở dòng 796)

**Interfaces:**
- Produces: `#vgHistSection`, `#vgHistList`, `#vgHistMore` cho Task 3 render.

- [ ] **Step 1: Chèn block HTML**

Chèn ngay **sau** `</div>` đóng `.vg-profileSection` (index.html:796), **trước**
`<!-- TTS settings -->`:

```html
        <!-- Voice đã dùng gần đây. Chỉ mode TTS — SFX/Music không có voice.
             Nằm ngoài .vg-modeContent (giống section Profile); JS ẩn/hiện theo mode. -->
        <div class="vg-sg vg-histSection" id="vgHistSection" hidden>
          <div class="vg-sl">Gần đây</div>
          <div id="vgHistList"></div>
          <div class="vg-histMore" id="vgHistMore" role="button" hidden></div>
        </div>
```

- [ ] **Step 2: Verify 3 id tồn tại đúng 1 lần**

Run:
```bash
cd plugin && grep -c 'id="vgHistSection"\|id="vgHistList"\|id="vgHistMore"' index.html
```
Expected: `3`

- [ ] **Step 3: Verify nằm sau section Profile và trước modeContent tts**

Run:
```bash
cd plugin && grep -n 'vg-profileSection\|id="vgHistSection"\|data-mode="tts"' index.html | head -3
```
Expected: ba dòng theo đúng thứ tự `vg-profileSection` → `vgHistSection` → `data-mode="tts"`, số dòng tăng dần.

- [ ] **Step 4: Commit**

```bash
git add plugin/index.html
git commit -m "feat(voicegen): khung section history voice gần đây"
```

---

### Task 2: Đọc/ghi `localStorage`

**Files:**
- Modify: `plugin/main.js` (thêm ngay **sau** `vgRememberSavedFolder`, kết thúc ở dòng 8478)

**Interfaces:**
- Produces: `vgHistGet()` → array; `vgHistPush(voiceId, voiceLabel, script)` → void.
- Consumes: `vgRenderHistory()` — **chưa tồn tại ở task này**, sẽ viết ở Task 3. Task 2 gọi nó qua guard `typeof` để `main.js` không vỡ giữa hai commit.

- [ ] **Step 1: Thêm 3 hằng + 2 hàm**

Chèn sau dấu `}` đóng `vgRememberSavedFolder` (main.js:8478):

```js
  // ── History voice đã dùng ─────────────────────────────────────────────────
  // Lưu voiceLabel kèm voiceId chứ không chỉ id: danh sách voice phụ thuộc API
  // key, nên khi đổi profile hoặc key hết hạn thì VG_VOICES_DATA không còn voice
  // đó — vẫn phải hiện được tên người đọc hiểu được thay vì một chuỗi id.
  var VG_HIST_KEY  = 'vg_voice_history';
  var VG_HIST_CAP  = 20;   // số mục lưu tối đa
  var VG_HIST_SHOW = 3;    // số mục hiện khi chưa bấm "Xem thêm"
  var VG_HIST_SNIP = 200;  // độ dài script lưu lại (đủ nhận ra, không phình localStorage)

  function vgHistGet() {
    try {
      var a = JSON.parse(localStorage.getItem(VG_HIST_KEY) || '[]');
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  }

  function vgHistPush(voiceId, voiceLabel, script) {
    if (!voiceId) return;
    var snip = String(script || '').trim().slice(0, VG_HIST_SNIP);
    // Trùng CẢ voice lẫn script → gộp lên đầu thay vì sinh mục trùng.
    var list = vgHistGet().filter(function (h) {
      return !(h.voiceId === voiceId && h.script === snip);
    });
    list.unshift({ voiceId: voiceId, voiceLabel: voiceLabel || voiceId, script: snip, ts: Date.now() });
    if (list.length > VG_HIST_CAP) list = list.slice(0, VG_HIST_CAP);
    try { localStorage.setItem(VG_HIST_KEY, JSON.stringify(list)); } catch (e) {}
    if (typeof vgRenderHistory === 'function') vgRenderHistory();
  }
```

- [ ] **Step 2: Verify cú pháp**

Run: `node --check plugin/main.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 3: Verify logic dedupe + cap bằng một script tạm**

Hai hàm này nằm trong IIFE nên không `require` được. Copy nguyên phần thân ra file tạm để
kiểm tra logic — file này **không** commit:

```bash
cat > /tmp/histcheck.js <<'JS'
const assert = require('assert');
const store = {};
const localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
const VG_HIST_KEY='vg_voice_history', VG_HIST_CAP=20, VG_HIST_SNIP=200;
function vgHistGet() {
  try { const a = JSON.parse(localStorage.getItem(VG_HIST_KEY) || '[]'); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function vgHistPush(voiceId, voiceLabel, script) {
  if (!voiceId) return;
  const snip = String(script || '').trim().slice(0, VG_HIST_SNIP);
  let list = vgHistGet().filter(h => !(h.voiceId === voiceId && h.script === snip));
  list.unshift({ voiceId, voiceLabel: voiceLabel || voiceId, script: snip, ts: Date.now() });
  if (list.length > VG_HIST_CAP) list = list.slice(0, VG_HIST_CAP);
  localStorage.setItem(VG_HIST_KEY, JSON.stringify(list));
}

// 1. mục mới đứng đầu
vgHistPush('v1', 'Rachel', 'bài A');
vgHistPush('v2', 'Adam', 'bài B');
assert.strictEqual(vgHistGet().length, 2, 'có 2 mục');
assert.strictEqual(vgHistGet()[0].voiceLabel, 'Adam', 'mới nhất đứng đầu');

// 2. trùng cả voice lẫn script → gộp lên đầu, không sinh mục trùng
vgHistPush('v1', 'Rachel', 'bài A');
assert.strictEqual(vgHistGet().length, 2, 'vẫn 2 mục');
assert.strictEqual(vgHistGet()[0].voiceLabel, 'Rachel', 'Rachel lên đầu');

// 3. cùng voice + script KHÁC → mục mới
vgHistPush('v1', 'Rachel', 'bài C');
assert.strictEqual(vgHistGet().length, 3, 'thành 3 mục');

// 4. cap 20
for (let i = 0; i < 50; i++) vgHistPush('v' + i, 'N' + i, 's' + i);
assert.strictEqual(vgHistGet().length, 20, 'cap đúng 20');

// 5. script dài bị cắt còn 200
vgHistPush('vlong', 'L', 'x'.repeat(500));
assert.strictEqual(vgHistGet()[0].script.length, 200, 'script cắt còn 200');

// 6. voiceId rỗng → bỏ qua
const before = vgHistGet().length;
vgHistPush('', 'X', 'y');
assert.strictEqual(vgHistGet().length, before, 'voiceId rỗng không ghi');

// 7. localStorage chứa rác → trả mảng rỗng, không ném
store[VG_HIST_KEY] = '{ not json';
assert.deepStrictEqual(vgHistGet(), [], 'JSON hỏng → mảng rỗng');

console.log('ALL OK');
JS
node /tmp/histcheck.js
```
Expected: `ALL OK`

- [ ] **Step 4: Commit**

```bash
git add plugin/main.js
git commit -m "feat(voicegen): lưu history voice vào localStorage (cap 20, gộp mục trùng)"
```

---

### Task 3: Render danh sách + nút "Xem thêm"

**Files:**
- Modify: `plugin/main.js` (thêm ngay sau `vgHistPush` từ Task 2)

**Interfaces:**
- Produces: `vgRenderHistory()` → void; biến `vgHistExpanded`.
- Consumes: `vgHistGet()` (Task 2), `currentMode`, `$()`, `piMakeButton`/`piSetBtn` (main.js:80, 99), `vgSetVoice` (main.js:7520), `els.voiceSelect`, `els.script`, `vgAutoResize` (main.js:1478), `vgReflowSoon` (main.js:1498), `updateCharCount`.

- [ ] **Step 1: Thêm `vgHistExpanded` + `vgRenderHistory`**

Chèn ngay sau dấu `}` đóng `vgHistPush`:

```js
  var vgHistExpanded = false;

  // Dựng bằng DOM API (không innerHTML cho từng mục) — cùng lối với renderVoiceDrop.
  // KHÔNG dùng attribute title="" làm tooltip: UXP không hỗ trợ.
  function vgRenderHistory() {
    var sec  = $('vgHistSection');
    var list = $('vgHistList');
    var more = $('vgHistMore');
    if (!sec || !list || !more) return;

    var hist = vgHistGet();
    if (!hist.length || currentMode !== 'tts') { sec.hidden = true; return; }
    sec.hidden = false;

    var shown = vgHistExpanded ? hist.length : Math.min(VG_HIST_SHOW, hist.length);
    list.innerHTML = '';

    hist.slice(0, shown).forEach(function (h) {
      var item = document.createElement('div');
      item.className = 'vg-histItem';
      item.setAttribute('role', 'button');
      piMakeButton(item);

      var textCol = document.createElement('div');
      textCol.className = 'vg-histText';

      var nameEl = document.createElement('div');
      nameEl.className = 'vg-histName';
      nameEl.textContent = h.voiceLabel || h.voiceId;
      textCol.appendChild(nameEl);

      var scriptEl = document.createElement('div');
      scriptEl.className = 'vg-histScript';
      scriptEl.textContent = h.script || '(không có script)';
      textCol.appendChild(scriptEl);

      item.appendChild(textCol);

      var reload = document.createElement('div');
      reload.className = 'vg-histReload';
      reload.setAttribute('role', 'button');
      piMakeButton(reload);
      piSetBtn(reload, 'rotate_left', null, null, 11);
      item.appendChild(reload);

      // Click dòng = đổi voice. Giống hệt vgDropSelect (main.js:7671) nên mọi
      // listener 'change' hiện có đều chạy. Script đang gõ không bị đụng tới.
      textCol.addEventListener('click', function () {
        vgSetVoice(h.voiceId);
        var evt = document.createEvent('Event');
        evt.initEvent('change', true, true);
        if (els.voiceSelect) els.voiceSelect.dispatchEvent(evt);
      });

      // Nút ↺ = nạp lại script. Thao tác phá huỷ → hỏi trước khi đè bài đang soạn.
      reload.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!els.script) return;
        var cur = els.script.value == null ? '' : String(els.script.value);
        var next = h.script || '';
        if (cur.trim() && cur.trim() !== next.trim()) {
          if (!confirm('Thay script đang soạn bằng script của lần gen này?')) return;
        }
        els.script.value = next;
        updateCharCount();
        vgAutoResize(els.script);
        vgReflowSoon(els.script);
      });

      list.appendChild(item);
    });

    if (hist.length > VG_HIST_SHOW) {
      more.hidden = false;
      more.textContent = vgHistExpanded ? 'Thu gọn' : ('Xem thêm (' + (hist.length - VG_HIST_SHOW) + ')');
    } else {
      more.hidden = true;
    }
  }
```

- [ ] **Step 2: Wire nút "Xem thêm" một lần duy nhất**

`vgRenderHistory` chạy lại mỗi lần gen, nên listener phải gắn **ngoài** hàm render, nếu
không mỗi lần render sẽ chồng thêm một listener và một cú bấm sẽ toggle nhiều lần. Chèn
ngay sau dấu `}` đóng `vgRenderHistory`:

```js
  var vgHistMoreBtn = $('vgHistMore');
  if (vgHistMoreBtn) {
    piMakeButton(vgHistMoreBtn);
    vgHistMoreBtn.addEventListener('click', function () {
      vgHistExpanded = !vgHistExpanded;
      vgRenderHistory();
    });
  }
```

- [ ] **Step 3: Verify cú pháp**

Run: `node --check plugin/main.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 4: Verify không dùng API bị cấm trong code vừa thêm**

Run:
```bash
cd plugin && sed -n '/── History voice đã dùng/,/^  var vgHistMoreBtn/p' main.js | grep -n "title=\|position: *fixed\|display: *grid\|z-index" || echo NO_FORBIDDEN_API
```
Expected: `NO_FORBIDDEN_API`

- [ ] **Step 5: Verify listener "Xem thêm" chỉ gắn 1 lần**

Run:
```bash
cd plugin && grep -c "vgHistExpanded = !vgHistExpanded" main.js
```
Expected: `1`

- [ ] **Step 6: Commit**

```bash
git add plugin/main.js
git commit -m "feat(voicegen): render section history voice + nút xem thêm"
```

---

### Task 4: Hook vào `generate()` và `switchMode()`

**Files:**
- Modify: `plugin/main.js:8005` (nhánh thành công của `generate()`)
- Modify: `plugin/main.js:8016` (`switchMode`)
- Modify: `plugin/main.js:10149` (sau `vgRenderProfiles();` lúc init)

**Interfaces:**
- Consumes: `vgHistPush` (Task 2), `vgRenderHistory` (Task 3).

- [ ] **Step 1: Ghi history ở nhánh gen thành công**

Trong `generate()`, ngay **sau** dòng
`setStatus('✓ Generated ' + lastVariations.length + ' ' + label + ' · click play to preview', true);`
(main.js:8005), thêm:

```js
      // Chỉ TTS single-speaker: SFX/Music không có voice, còn multi-speaker đã
      // return sớm ở trên (generateMultiSpeaker) nên không bao giờ tới đây.
      if (currentMode === 'tts') {
        vgHistPush(body.voiceId, vgVoiceName(body.voiceId), body.text);
      }
```

Đọc `body.voiceId` / `body.text` chứ không đọc lại DOM: `body` là chính payload vừa gửi
lên bridge nên chắc chắn khớp với audio vừa tạo ra. Nhãn lấy bằng `vgVoiceName(voiceId)` —
**không** dùng `selectedIndex`, vì UXP không cập nhật `selectedIndex` khi `.value` được set
bằng dropdown tuỳ biến (bẫy đã ghi chú ở main.js:7942).

- [ ] **Step 2: Ẩn/hiện theo mode**

Trong `switchMode(mode)`, ngay sau dòng `vgRenderBinNames();`, thêm:

```js
    vgRenderHistory();   // section nằm ngoài .vg-modeContent nên phải tự ẩn khi rời TTS
```

- [ ] **Step 3: Render lần đầu lúc init**

Ngay sau `vgRenderProfiles();` ở main.js:10149, thêm:

```js
  vgRenderHistory();
```

- [ ] **Step 4: Verify cú pháp**

Run: `node --check plugin/main.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 5: Verify đủ call site**

Run:
```bash
cd plugin && grep -c "vgRenderHistory();" main.js
```
Expected: `4` — bốn dòng gọi: guard `typeof` trong `vgHistPush` (Task 2), listener nút "Xem thêm" (Task 3), `switchMode` (Task 4 Step 2), init sau `vgRenderProfiles()` (Task 4 Step 3).

- [ ] **Step 6: Verify `vgHistPush` được gọi đúng 1 chỗ trong generate**

Run:
```bash
cd plugin && grep -n "vgHistPush(body.voiceId" main.js
```
Expected: đúng 1 dòng.

- [ ] **Step 7: Commit**

```bash
git add plugin/main.js
git commit -m "feat(voicegen): ghi history khi gen TTS thành công, ẩn theo mode"
```

---

### Task 5: CSS

**Files:**
- Modify: `plugin/styles.css` (chèn sau block `#vgProfileChipName`, kết thúc ở dòng 2219)

**Interfaces:**
- Consumes: class do Task 3 sinh ra — `.vg-histItem`, `.vg-histText`, `.vg-histName`, `.vg-histScript`, `.vg-histReload`, `.vg-histMore`.

- [ ] **Step 1: Thêm block CSS**

Chèn ngay trước comment `/* ── Body: left + right ── */` (styles.css:2221):

```css
/* Voice đã dùng gần đây — mượn bảng token và lối trình bày của .vg-profileChip.
   Không display:grid, không position:fixed, không z-index (UXP không hỗ trợ). */
.vg-histSection { border-bottom: 1px solid var(--border); }
.vg-histItem {
  display: flex;
  align-items: center;
  min-width: 0;
  background: rgba(255,255,255,0.05);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 5px 7px;
  margin-bottom: 4px;
  cursor: pointer;
}
.vg-histItem:hover { border-color: var(--accent); }
/* flex:1 1 0 + min-width:0 là điều kiện để text-overflow:ellipsis hoạt động */
.vg-histText { flex: 1 1 0; min-width: 0; }
.vg-histName {
  font-size: 11px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vg-histScript {
  font-size: 10px;
  opacity: 0.6;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
div[role="button"].vg-histReload { flex: 0 0 auto; margin-left: 6px; opacity: 0.55; }
div[role="button"].vg-histReload:hover { opacity: 1; }
.vg-histMore {
  font-size: 10px;
  color: var(--accent);
  text-align: center;
  padding: 3px 0;
  cursor: pointer;
}
.vg-histMore:hover { text-decoration: underline; }
```

- [ ] **Step 2: Verify đủ 7 class**

Run:
```bash
cd plugin && for c in vg-histSection vg-histItem vg-histText vg-histName vg-histScript vg-histReload vg-histMore; do grep -q "\.$c" styles.css && echo "$c OK" || echo "$c MISSING"; done
```
Expected: 7 dòng `OK`, không có `MISSING`.

- [ ] **Step 3: Verify không có API bị cấm**

Run:
```bash
cd plugin && sed -n '/Voice đã dùng gần đây — mượn bảng token/,/\.vg-histMore:hover/p' styles.css | grep -n "position: *fixed\|display: *grid\|z-index" || echo NO_FORBIDDEN_CSS
```
Expected: `NO_FORBIDDEN_CSS`

- [ ] **Step 4: Commit**

```bash
git add plugin/styles.css
git commit -m "style(voicegen): style cho section history voice"
```

---

### Task 6: Test thủ công trong Premiere + bump version

**Files:**
- Modify: `plugin/main.js:794` (`PLUGIN_VERSION`)
- Modify: `plugin/manifest.json` (field `version`)
- Modify: `CHANGELOG.md` nếu có

- [ ] **Step 1: Reload plugin và chạy checklist**

Bridge phải đang chạy (`cd bridge && node server.js`), rồi bấm **Reload** trong UXP
Developer Tool. Chạy đủ 11 mục, đánh dấu từng mục:

1. Gen TTS với Rachel → section "Gần đây" hiện ra, một mục "Rachel" + đầu script.
2. Gen tiếp với Adam → Adam lên đầu, Rachel xuống dưới.
3. Gen lại Rachel với **đúng script cũ** → vẫn 2 mục, Rachel lên đầu (không sinh mục trùng).
4. Gen lại Rachel với script **khác** → thành 3 mục.
5. Gen hơn 3 lần → hiện "Xem thêm (n)"; bấm → giãn ra; bấm lại → thu về 3.
6. Bấm vào một dòng → nhãn dropdown voice đổi theo, script đang gõ **không đổi**.
7. Bấm ↺ khi ô script đang có bài khác → hiện confirm; đồng ý → script được thay, textarea
   giãn đúng chiều cao, bộ đếm ký tự cập nhật; từ chối → không đổi gì.
8. Đổi sang mode SFX/Music → section biến mất; quay lại TTS → hiện lại.
9. Đổi profile sang key khác (voice cũ không còn trong danh sách) → mục cũ vẫn hiện tên,
   click vẫn đặt được voice.
10. Reload plugin trong UXP Developer Tool → history còn nguyên.
11. Gen multi-speaker (thêm speaker thứ 2) → history **không** thêm mục nào.

Mục nào fail thì sửa rồi chạy lại từ mục đó, **không** bump version khi còn mục fail.

- [ ] **Step 2: Bump version**

`plugin/main.js:794` → `var PLUGIN_VERSION = 'v5.7.0';` và thêm mô tả vào đầu comment
cùng dòng (giữ nguyên toàn bộ phần mô tả các bản cũ phía sau):

```
Voice Gen: section "Gần đây" trên sidebar phải — 3 lần gen TTS gần nhất (tên voice + đoạn script), click đổi voice, nút ↺ nạp lại script, "Xem thêm" giãn tối đa 20. Lưu ở localStorage vg_voice_history, chỉ single-speaker TTS.
```

Cập nhật field `version` trong `plugin/manifest.json` cho khớp (`5.7.0`), và thêm một
entry vào đầu `CHANGELOG.md` theo đúng mẫu các bản trước (đọc entry v5.6.5 hiện có làm mẫu):
tiêu đề `## v5.7.0`, gạch đầu dòng mô tả section "Gần đây", ghi rõ **không cần bridge mới**
(tính năng thuần plugin, bridge giữ nguyên ≥1.15.0).

- [ ] **Step 3: Verify version khớp nhau**

Run:
```bash
grep -o "v5\.7\.0" plugin/main.js | head -1; grep -o '"version": *"5\.7\.0"' plugin/manifest.json
```
Expected: cả hai dòng đều in ra.

- [ ] **Step 4: Dọn file tạm**

```bash
rm -f /tmp/histcheck.js
```

- [ ] **Step 5: Commit**

```bash
git add plugin/main.js plugin/manifest.json CHANGELOG.md
git commit -m "feat(voicegen): history voice đã dùng gần đây (v5.7.0)"
```
