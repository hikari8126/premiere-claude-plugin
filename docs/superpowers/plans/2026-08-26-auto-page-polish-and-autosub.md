# Gọn trang Auto + trang Auto Sub — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gọn trang Auto (popup confirm thay preview inline, dùng token màu), và thay trang success của luồng Auto bằng trang Auto Sub tự đổ script + đổi sequence theo từng video.

**Architecture:** Toàn bộ nằm trong khối `// ── AUTO PAGE ──` … `// ── /AUTO PAGE ──` của IIFE Autocut trong `plugin/main.js`, cộng markup ở `plugin/index.html` và CSS ở `plugin/styles.css`. Trang Auto Sub **mượn node `.st-app`** từ tab TẠO SUB đúng cơ chế `autoBorrowManual()` — không nhân bản. Không có thay đổi nào ở `bridge/`.

**Tech Stack:** UXP plugin (non-module JS, ES5-style `var`/`function`), Premiere Pro UXP API, CSS custom properties.

---

## ⚠ Về kiểm thử — đọc trước khi bắt đầu

**`plugin/main.js` KHÔNG có hạ tầng test** (phụ thuộc DOM UXP + Premiere API). Không có jest/vitest. Đừng cố viết unit test cho code trong file này — đó là lý do logic tên deliverable được đẩy sang `bridge/autoset-names.js`, nơi test được bằng `node`.

Plan này **không đụng bridge**, nên không có test tự động nào để viết. Thay vào đó mỗi task kết thúc bằng một trong hai cách kiểm:

- **[HARNESS]** — mở harness browser (Task 1) và soi bằng mắt. Dùng cho CSS và bố cục.
- **[PREMIERE]** — reload plugin trong UXP Developer Tool rồi thao tác thật. Dùng cho mọi thứ chạm vào Premiere API hoặc DOM đã mượn.

Sau mỗi lần sửa `plugin/main.js`, luôn chạy:
```bash
node --check plugin/main.js
```
Nó chỉ bắt lỗi cú pháp, không bắt được `ReferenceError` lúc chạy — lỗi `autoNormalizeJobs is not defined` đã lọt qua đúng kiểu này. Nên **[PREMIERE]** là bắt buộc, không bỏ qua được.

---

## Bản đồ file

| File | Trách nhiệm | Đụng ở task |
|---|---|---|
| `plugin/index.html` | Markup modal confirm, trang Auto Sub | 4, 8 |
| `plugin/styles.css` | Token màu trang Auto, CSS modal + trang Sub | 2, 4, 8 |
| `plugin/main.js` | Toàn bộ logic (khối AUTO PAGE) | 3, 5, 6, 7, 9, 10, 11 |
| `scratchpad/preview/` | Harness browser (không commit) | 1 |
| `.claude/launch.json` | Trỏ harness | 1 |

---

## Task 1: Dựng lại harness browser

Harness của session cũ đã mất; `.claude/launch.json` đang trỏ vào đường dẫn scratchpad không còn tồn tại. Cần nó trước vì Task 2 và 4 kiểm bằng mắt.

**Files:**
- Create: `<scratchpad>/preview/preview.html`
- Create: `<scratchpad>/preview/styles.css` (bản copy)
- Modify: `.claude/launch.json`

- [ ] **Step 1: Tạo thư mục và copy CSS thật**

```bash
mkdir -p "$SCRATCH/preview"
cp plugin/styles.css "$SCRATCH/preview/styles.css"
```
(`$SCRATCH` = thư mục scratchpad của session.)

- [ ] **Step 2: Viết preview.html**

Trích markup THẬT của `#sacPanelAuto` từ `plugin/index.html:1064-1124` vào 3 khung có kích thước khác nhau. Nội dung file:

Sinh phần markup bằng lệnh, KHÔNG chép tay:

```bash
sed -n '1064,1124p' plugin/index.html > "$SCRATCH/preview/auto-markup.html"
```

Rồi viết `preview.html` như dưới, và dán **nguyên nội dung** `auto-markup.html`
vào chỗ đánh dấu, đổi `style="display:none"` ở dòng đầu thành `style="display:flex"`:

```html
<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="styles.css">
<style>
  body { background:#111; margin:0; padding:16px; display:flex; gap:16px; align-items:flex-start; font-family:system-ui; }
  .frame { background:var(--bg); border:1px solid #444; overflow:hidden; display:flex; flex-direction:column; }
  .frame > .sac-app { flex:1 1 0; min-height:0; display:flex; flex-direction:column; }
  .f380 { width:380px; height:820px; }
  .f300 { width:300px; height:820px; }
  .f420 { width:380px; height:420px; }
  .cap { color:#888; font-size:11px; margin-bottom:4px; }
</style></head><body>
  <div><div class="cap">380×820</div><div class="frame f380" id="a"></div></div>
  <div><div class="cap">300×820 (hẹp)</div><div class="frame f300" id="b"></div></div>
  <div><div class="cap">380×420 (panel thấp)</div><div class="frame f420" id="c"></div></div>
<script>
// DÁN markup thật của #sacPanelAuto (index.html:1064-1124) vào đây, đổi
// style="display:none" thành display:flex. Giữ nguyên mọi class và id.
var MARKUP = `
  <div class="sac-app">
  <!-- nội dung auto-markup.html dán nguyên vào đây (đã đổi display:none → flex) -->
  </div>
`;
['a','b','c'].forEach(function(id){ document.getElementById(id).innerHTML = MARKUP; });
</script>
</body></html>
```

- [ ] **Step 3: Trỏ launch.json vào harness**

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "preview",
      "runtimeExecutable": "python3",
      "runtimeArgs": ["-m", "http.server", "8777", "--directory", "<đường dẫn tuyệt đối tới $SCRATCH/preview>"],
      "port": 8777
    }
  ]
}
```

- [ ] **Step 4: Mở và xác nhận harness chạy**

Dùng `preview_start` với `{name: "preview"}`, rồi `computer {action:"screenshot"}`.
Kỳ vọng: thấy 3 khung, mỗi khung có trang Auto với tab .0/.1/.2, nút "Chạy cả bộ" nằm TRONG khung ở cả khung 420px.

- [ ] **Step 5: KHÔNG commit harness** — nó nằm trong scratchpad. Chỉ commit `.claude/launch.json`:

```bash
git add .claude/launch.json
git commit -m "chore: trỏ launch.json vào harness preview của session này"
```

---

## Task 2: Thay hex cứng bằng token màu

**Files:**
- Modify: `plugin/styles.css` — khối `/* ── AUTO PAGE ── */` (khoảng dòng 4169-4240 sau các sửa hôm nay; tìm bằng `grep -n "AUTO PAGE" plugin/styles.css`)

- [ ] **Step 1: Chụp ảnh "trước" từ harness**

Screenshot khung 380px. Giữ lại để so sánh.

- [ ] **Step 2: Thay từng hex**

Sửa đúng 6 dòng sau trong khối AUTO PAGE:

```css
/* TRƯỚC */
.sac-autoTitle { font-weight: 600; font-size: 13px; color: #e9d5ff; flex: 1 1 0; min-width: 0; }
/* SAU */
.sac-autoTitle { font-weight: 600; font-size: 13px; color: var(--accent-lighter); flex: 1 1 0; min-width: 0; }
```

```css
/* TRƯỚC */
.sac-autoSetInput {
  width: 58px; padding: 6px 4px; text-align: center; font-size: 13px;
  border-radius: 4px; border: 1px solid var(--border, #3a2f52);
  background: var(--input-bg, #1e1b2e); color: var(--text);
}
/* SAU — bỏ fallback hex cứng, dùng token có thật trong :root */
.sac-autoSetInput {
  width: 58px; padding: 6px 4px; text-align: center; font-size: 13px;
  border-radius: 4px; border: 1px solid var(--border);
  background: var(--surface2); color: var(--text);
}
```

```css
/* TRƯỚC */
.sac-autoTabsLabel { flex: 0 0 auto; font-size: 11px; color: #94a3b8; }
/* SAU */
.sac-autoTabsLabel { flex: 0 0 auto; font-size: 11px; color: var(--text-dim); }
```

```css
/* TRƯỚC */
.sac-autoTab {
  flex: 1 1 0; min-width: 0; text-align: center;
  padding: 8px 6px; border-radius: 6px; background: #1e1b2e; color: #94a3b8;
  font-size: 15px; font-weight: 700; cursor: pointer;
  border: 1px solid transparent;
}
.sac-autoTab.is-active { background: #7c3aed; color: #fff; border-color: #a78bfa; }
/* SAU */
.sac-autoTab {
  flex: 1 1 0; min-width: 0; text-align: center;
  padding: 8px 6px; border-radius: 6px; background: var(--surface2); color: var(--text-dim);
  font-size: 15px; font-weight: 700; cursor: pointer;
  border: 1px solid transparent;
}
.sac-autoTab.is-active { background: var(--accent); color: var(--accent-fg); border-color: var(--accent-light); }
```

```css
/* TRƯỚC */
.sac-autoStatus { flex: 0 0 auto; font-size: 11px; color: #94a3b8; min-height: 16px; }
/* SAU */
.sac-autoStatus { flex: 0 0 auto; font-size: 11px; color: var(--text-dim); min-height: 16px; }
```

```css
/* TRƯỚC */
.sac-autoRun { flex: 0 0 auto; padding: 6px; text-align: center; border-radius: 4px; background: #7c3aed; color: #fff; font-size: 12px; cursor: pointer; }
/* SAU — theo đúng .sac-previewBtn, nút primary chuẩn của Autocut */
.sac-autoRun {
  flex: 0 0 auto; padding: 6px; text-align: center; border-radius: 4px;
  background: var(--accent); color: var(--accent-fg); font-size: 12px; cursor: pointer;
}
.sac-autoRun:hover { background: var(--accent-dark); }
```

- [ ] **Step 3: Xác nhận không còn hex cứng trong khối AUTO PAGE**

```bash
awk '/── AUTO PAGE ──/,/── \/AUTO PAGE ──/' plugin/styles.css | grep -nE '#[0-9a-fA-F]{3,6}\b'
```
Kỳ vọng: **không in ra gì**.

- [ ] **Step 4: [HARNESS] Kiểm đổi accent**

Copy lại `styles.css` vào harness, reload trang, rồi trong console của harness chạy:
```js
document.documentElement.style.setProperty('--accent', '#22c55e');
document.documentElement.style.setProperty('--accent-fg', '#ffffff');
document.documentElement.style.setProperty('--accent-light', '#4ade80');
```
Kỳ vọng: nút "Chạy cả bộ" và tab active chuyển sang **xanh lá**. Trước khi sửa thì chúng vẫn tím.

- [ ] **Step 5: Commit**

```bash
git add plugin/styles.css
git commit -m "style(auto): dùng token màu thay hex cứng, nút theo .sac-previewBtn"
```

---

## Task 3: Tách `autoBuildConfirmLines()` khỏi `autoRenderPreview()`

Tách logic dựng chuỗi ra khỏi việc ghi DOM, để Task 5 dùng lại. Chưa đổi hành vi gì.

**Files:**
- Modify: `plugin/main.js:5344-5356` (`autoRenderPreview`)

- [ ] **Step 1: Thay hàm**

Tìm:
```js
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

Thay bằng:
```js
  // Dựng các dòng xác nhận cho ĐỦ 3 video. Trả về mảng string, KHÔNG chạm DOM —
  // để modal confirm dùng lại. Tên do bridge /autoset/names sinh (nơi duy nhất có
  // test cho logic tên); đừng dựng lại tên ở đây.
  async function autoBuildConfirmLines() {
    var jobs = await autoFetchNames();
    var out = [];
    jobs.forEach(function (j) {
      out.push('.' + j.idx + '  ' + j.seqName);
      out.push('     ' + j.seqBin);
      out.push('     ' + j.voiceBin + '/' + j.voiceFile);
    });
    return out;
  }
```

- [ ] **Step 2: Xoá mọi lời gọi `autoRenderPreview()`**

Tìm hết:
```bash
grep -n "autoRenderPreview" plugin/main.js
```
Kỳ vọng có 3 chỗ gọi: trong `autoOpen()`, trong handler đóng Settings (`sacAutoSettingsClose`), và trong `blur` của nhóm input cấu hình. **Xoá cả 3 dòng gọi.**

- [ ] **Step 3: Xác nhận không còn tham chiếu chết**

```bash
grep -n "autoRenderPreview\|sacAutoPreview" plugin/main.js
```
Kỳ vọng: **không in ra gì**.

- [ ] **Step 4: Kiểm cú pháp**

```bash
node --check plugin/main.js
```
Kỳ vọng: không lỗi.

- [ ] **Step 5: [PREMIERE] Kiểm chưa vỡ gì**

Reload plugin. Vào tab Autocut → Auto. Kỳ vọng: trang mở bình thường, khối preview 4 dòng vẫn còn (chưa xoá markup) nhưng **trống rỗng**. Console không có lỗi mới.

- [ ] **Step 6: Commit**

```bash
git add plugin/main.js
git commit -m "refactor(auto): tách autoBuildConfirmLines() khỏi autoRenderPreview()"
```

---

## Task 4: Markup + CSS modal confirm

**Files:**
- Modify: `plugin/index.html` — xoá dòng `<div id="sacAutoPreview" …>`; thêm modal cạnh `#sacAutoSettings` (khoảng dòng 1131)
- Modify: `plugin/styles.css` — xoá `.sac-autoPreview`; thêm CSS modal

- [ ] **Step 1: Xoá khối preview inline khỏi index.html**

Tìm và xoá đúng dòng này (khoảng `index.html:1112`):
```html
        <div id="sacAutoPreview" class="sac-autoPreview"></div>
```

- [ ] **Step 2: Thêm markup modal, ngay SAU khối `#sacAutoSettings`**

Đặt sau `</div>` đóng của `#sacAutoSettings` (khoảng `index.html:1147`):
```html
  <!-- Xác nhận trước khi chạy bộ 3 video. Tên là deliverable giao cho CO —
       đây là điểm dừng bắt buộc duy nhất chắc chắn người dùng có đọc. -->
  <div id="sacAutoConfirm" class="sac-newseq-modal" hidden>
    <div class="sac-newseq-box">
      <div class="sac-autoConfirmHead" id="sacAutoConfirmHead"></div>
      <div class="sac-autoConfirmBody" id="sacAutoConfirmBody"></div>
      <div class="sac-autoConfirmActions">
        <div id="sacAutoConfirmCancel" class="sac-autoConfirmCancel" role="button">Huỷ</div>
        <div id="sacAutoConfirmGo" class="sac-autoRun" role="button" style="flex:1 1 0"><span data-ic="bolt" data-ic-size="13"></span> Chạy cả bộ</div>
      </div>
    </div>
  </div>
```

- [ ] **Step 3: Xoá `.sac-autoPreview` và thêm CSS modal**

Trong `plugin/styles.css`, xoá dòng:
```css
.sac-autoPreview { flex: 0 0 auto; font-size: 10px; color: var(--text-dim); line-height: 1.5; white-space: pre-line; word-break: break-word; }
```

Thêm vào cuối khối AUTO PAGE (ngay TRƯỚC `/* ── /AUTO PAGE ── */`):
```css
/* Modal confirm — dùng khuôn .sac-newseq-modal, đã có rule [hidden] ở đó. */
.sac-autoConfirmHead { font-size: 12px; font-weight: 600; color: var(--text); margin-bottom: 8px; word-break: break-word; }
/* pre-line: mặc định white-space gộp \n → 9 dòng dồn thành 1 đoạn. */
.sac-autoConfirmBody {
  font-size: 11px; color: var(--text-dim); line-height: 1.6;
  white-space: pre-line; word-break: break-word;
  max-height: 320px; overflow-y: auto; margin-bottom: 12px;
}
.sac-autoConfirmActions { display: flex; gap: 8px; align-items: center; }
.sac-autoConfirmCancel {
  flex: 0 0 auto; padding: 6px 14px; text-align: center; border-radius: 4px;
  background: var(--surface2); color: var(--text-dim); font-size: 12px; cursor: pointer;
  border: 1px solid var(--border);
}
.sac-autoConfirmCancel:hover { background: var(--border); color: var(--text); }
```

- [ ] **Step 4: Xác nhận modal có rule `[hidden]`**

```bash
grep -n "sac-newseq-modal\[hidden\]" plugin/styles.css
```
Kỳ vọng: in ra 1 dòng `.sac-newseq-modal[hidden] { display: none; }`.
**Nếu không có, modal sẽ hiện vĩnh viễn** — bẫy UXP #1 trong handoff.

- [ ] **Step 5: [HARNESS] Soi bố cục modal**

Copy `styles.css` + markup mới vào harness, đổi `hidden` thành mở, đổ 9 dòng giả vào `#sacAutoConfirmBody`. Kiểm ở cả 3 khung:
- Khung 300px: tên dài KHÔNG tràn ngang (phải xuống dòng).
- Khung 420px thấp: phần thân cuộn được, 2 nút vẫn thấy.
- 9 dòng hiện thành 9 dòng riêng, không dồn thành 1 đoạn.

- [ ] **Step 6: Commit**

```bash
git add plugin/index.html plugin/styles.css
git commit -m "feat(auto): markup + CSS modal confirm, bỏ preview inline"
```

---

## Task 5: Nối modal vào nút Chạy cả bộ

**Files:**
- Modify: `plugin/main.js` — handler `sacAutoRunBtn` (khoảng dòng 5661)

- [ ] **Step 1: Thêm hàm mở/đóng modal, đặt NGAY TRƯỚC `var sacAutoRunBtn = $('sacAutoRun');`**

```js
  // Mở modal confirm. UXP vẽ input/select NATIVE đè lên MỌI overlay bất kể
  // z-index — backdrop mờ không che được bảng script phía sau. Cách duy nhất là
  // ẩn hẳn nội dung phía sau, y như modal Settings đang làm.
  async function autoOpenConfirm() {
    var modal = $('sacAutoConfirm');
    var head  = $('sacAutoConfirmHead');
    var body  = $('sacAutoConfirmBody');
    if (!modal || !head || !body) return false;
    var cfg = autoBuildCfg();
    head.textContent = 'Bộ ' + ($('sacAutoSet').value.trim() || '?')
      + ' · ' + (cfg.product || '?') + ' · ' + (cfg.co || '?') + ' · ' + (cfg.editor || '?');
    body.textContent = '⏳ Đang dựng tên…';
    modal.hidden = false;
    if (sacAutoScrollEl) sacAutoScrollEl.style.display = 'none';
    if (sacAutoRunEl) sacAutoRunEl.style.display = 'none';
    try {
      body.textContent = (await autoBuildConfirmLines()).join('\n');
    } catch (e) {
      body.textContent = '✗ ' + e.message;
      return false;
    }
    return true;
  }
  function autoCloseConfirm() {
    var modal = $('sacAutoConfirm');
    if (modal) modal.hidden = true;
    if (sacAutoScrollEl) sacAutoScrollEl.style.display = '';
    if (sacAutoRunEl) sacAutoRunEl.style.display = '';
  }
```

> `autoBuildCfg()` ở `main.js:5321` trả về `{product, co, editor, seqNameTpl, seqBinTpl, voiceBinTpl}` — đã đối chiếu, `cfg.product` / `cfg.co` / `cfg.editor` dùng được luôn.

- [ ] **Step 2: Chèn cổng confirm vào handler**

Trong handler của `sacAutoRunBtn`, tìm đoạn:
```js
    if (autoRunning) { autoStatus('⏳ Đang chạy — chờ xong đã.'); return; }
    autoCaptureRows(autoSet.jobs[autoActiveJob]);
    autoSaveState();
    // Chặn sớm: không chạy pipeline (và không chạm vào bảng) khi chưa có gì.
    var filled = autoSet.jobs.filter(function (j) { return (j.rows || []).length; });
    if (!filled.length) {
      autoStatus('✗ Cả 3 video chưa có script — dán script vào bảng ở từng tab .0 / .1 / .2.');
      return;
    }
    autoRunning = true;
```

Chèn **giữa** khối `if (!filled.length)` và `autoRunning = true;`:
```js
    // Xác nhận tên trước khi chạy. Chỉ hiện modal; việc chạy do nút trong modal
    // kích hoạt (Step 3), nên ở đây return luôn.
    await autoOpenConfirm();
    return;
  });

  // Nút "Chạy cả bộ" TRONG modal — đây mới là chỗ chạy pipeline thật.
  var sacAutoConfirmGoBtn = $('sacAutoConfirmGo');
  if (sacAutoConfirmGoBtn) sacAutoConfirmGoBtn.addEventListener('click', async function () {
    autoCloseConfirm();
    if (autoRunning) { autoStatus('⏳ Đang chạy — chờ xong đã.'); return; }
    autoRunning = true;
```

Phần còn lại của handler cũ (`sacAutoRunBtn.style.opacity = '0.5';` cho tới hết `});`) giữ nguyên, giờ thuộc về handler mới này.

- [ ] **Step 3: Thêm handler nút Huỷ, ngay sau handler trên**

```js
  var sacAutoConfirmCancelBtn = $('sacAutoConfirmCancel');
  if (sacAutoConfirmCancelBtn) sacAutoConfirmCancelBtn.addEventListener('click', autoCloseConfirm);
```

- [ ] **Step 4: Kiểm cú pháp**

```bash
node --check plugin/main.js
```
Kỳ vọng: không lỗi. Nếu báo lỗi ngoặc, kiểm lại chỗ cắt handler ở Step 2.

- [ ] **Step 5: [PREMIERE] Kiểm luồng**

Reload. Trang Auto → nhập bộ 99, dán script vào .0 → bấm "Chạy cả bộ".
Kỳ vọng:
- Modal hiện, có **9 dòng**: 3 video × (tên sequence + bin + đường dẫn voice).
- Đường dẫn voice **khác nhau giữa 3 video** (33.0/33.1/33.2), không phải cùng 1 dòng.
- Nội dung phía sau modal bị ẩn hẳn, chữ trong bảng không xuyên qua.
- Bấm **Huỷ** → modal đóng, không chạy gì.
- Bấm **Chạy cả bộ** trong modal → pipeline bắt đầu như cũ.

- [ ] **Step 6: Commit**

```bash
git add plugin/main.js
git commit -m "feat(auto): popup confirm đủ 3 video trước khi chạy"
```

---

## Task 6: Dọn `autoBorrowVoiceDrop` trùng lặp

**Files:**
- Modify: `plugin/main.js` — hai bản trùng ở khoảng dòng 5045 và 5061

- [ ] **Step 1: Xác nhận đúng là trùng**

```bash
grep -n "function autoBorrowVoiceDrop\|function autoReturnVoiceDrop\|var autoVoiceDropHome" plugin/main.js
```
Kỳ vọng: mỗi tên xuất hiện **2 lần**.

- [ ] **Step 2: Xoá bản ĐẦU, sửa bản SAU sang cơ chế placeholder**

Xoá nguyên khối đầu:
```js
  function autoBorrowVoiceDrop() {
    var vd = $('vgVoiceDrop'), slot = $('sacAutoVoiceSlot');
    if (!vd || !slot || autoVoiceDropHome) return;
    autoVoiceDropHome = { parent: vd.parentNode, next: vd.nextSibling };
    slot.appendChild(vd);
  }
  function autoReturnVoiceDrop() {
    if (!autoVoiceDropHome) return;
    var vd = $('vgVoiceDrop');
    autoVoiceDropHome.parent.insertBefore(vd, autoVoiceDropHome.next);
    autoVoiceDropHome = null;
  }
```

Thay khối SAU bằng:
```js
  var autoVoiceDropHome = null;
  // Placeholder thay vì nhớ nextSibling — cùng lý do đã làm panel Manual biến mất
  // (commit fee1cdd): ở UXP nextSibling có thể là text/comment node và
  // insertBefore với ref node kiểu đó ném lỗi.
  function autoBorrowVoiceDrop() {
    var drop = $('vgVoiceDrop');
    var slot = $('sacAutoVoiceSlot');
    if (!drop || !slot || autoVoiceDropHome) return;
    var ph = document.createElement('div');
    ph.id = 'vgVoiceDropHomeMark';
    ph.style.display = 'none';
    drop.parentNode.insertBefore(ph, drop);
    autoVoiceDropHome = { mark: ph };
    slot.appendChild(drop);
  }
  function autoReturnVoiceDrop() {
    if (!autoVoiceDropHome) return;
    var drop = $('vgVoiceDrop');
    var mark = autoVoiceDropHome.mark;
    autoVoiceDropHome = null;
    if (!drop) return;
    try { if (mark && mark.parentNode) mark.parentNode.insertBefore(drop, mark); }
    catch (e) { console.error('[SAC] autoReturnVoiceDrop lỗi:', e); }
    try { if (mark && mark.parentNode) mark.parentNode.removeChild(mark); } catch (e) {}
  }
```

- [ ] **Step 3: Xác nhận chỉ còn 1 bản**

```bash
grep -c "function autoBorrowVoiceDrop" plugin/main.js
```
Kỳ vọng: `1`.

- [ ] **Step 4: Kiểm cú pháp**

```bash
node --check plugin/main.js
```

- [ ] **Step 5: [PREMIERE] Kiểm dropdown voice**

Reload. Manual → Auto → chọn voice ở tab .0 → sang tab .1 chọn voice khác → về Manual → sang tab Voice Gen.
Kỳ vọng: dropdown voice ở tab Voice Gen **vẫn còn và bấm được**, mỗi job giữ voice riêng.

- [ ] **Step 6: Commit**

```bash
git add plugin/main.js
git commit -m "refactor(auto): gộp 2 bản autoBorrowVoiceDrop trùng, dùng placeholder"
```

---

## Task 7: Chặn trang success trong luồng Auto

**Files:**
- Modify: `plugin/main.js:6478-6480` (cuối `sacRunAutoCut`)

- [ ] **Step 1: Bọc bằng cờ `autoRunning`**

Tìm:
```js
      status.style.display = 'none';
      $('sacPanelManual').style.display = 'none';
      $('sacSuccessPanel').style.display = 'flex';
```

Thay bằng:
```js
      status.style.display = 'none';
      // Trang Auto gọi sacRunAutoCut('new') 3 lần trong autoStage3. Nếu không
      // chặn, trang success chen vào GIỮA lúc chạy bộ 3 video và ẩn mất panel
      // Manual đang được mượn. Luồng Manual (autoRunning = false) giữ nguyên
      // trang success như cũ. Một cổng duy nhất ở đây — KHÔNG rải if vào hàm khác.
      if (!autoRunning) {
        $('sacPanelManual').style.display = 'none';
        $('sacSuccessPanel').style.display = 'flex';
      }
```

- [ ] **Step 2: Xác nhận `autoRunning` nhìn thấy được từ đây**

```bash
grep -n "var autoRunning" plugin/main.js
grep -n "END Super Auto Cut module" plugin/main.js
```
Kỳ vọng: dòng `var autoRunning` có số nhỏ hơn dòng sửa (6478) và nhỏ hơn dòng `END Super Auto Cut module` → cùng IIFE, gọi trực tiếp được. Nếu KHÔNG cùng IIFE thì dừng lại và báo — phải đi qua `window.*` (handoff §3.3).

- [ ] **Step 3: Kiểm cú pháp**

```bash
node --check plugin/main.js
```

- [ ] **Step 4: [PREMIERE] Kiểm cả 2 luồng**

- Luồng Manual: dán script → Validate → Gen voice → dựng. Kỳ vọng: **vẫn hiện** trang success với 2 nút New AutoCut / Về block.
- Luồng Auto: chạy bộ 99 tới hết chặng 3. Kỳ vọng: **không** thấy trang success chen vào; panel Manual mượn không bị ẩn giữa chừng.

- [ ] **Step 5: Commit**

```bash
git add plugin/main.js
git commit -m "fix(auto): không bật trang success khi trang Auto đang chạy"
```

---

## Task 8: Markup + CSS trang Auto Sub, mượn/trả `.st-app`

**Files:**
- Modify: `plugin/index.html` — thêm `#sacPanelAutoSub` sau `#sacPanelAuto` (khoảng dòng 1124)
- Modify: `plugin/styles.css` — thêm CSS trang Sub
- Modify: `plugin/main.js` — thêm `autoBorrowSub()` / `autoReturnSub()`

- [ ] **Step 1: Thêm markup, ngay SAU `</div>` đóng của `#sacPanelAuto`**

```html
    <!-- ── AUTO SUB PANEL ── -->
    <!-- Thay trang success cho luồng Auto. MƯỢN node .st-app từ tab TẠO SUB
         (autoBorrowSub) đúng cơ chế autoBorrowManual — không nhân bản. -->
    <div class="sac-panel sac-autoPage" id="sacPanelAutoSub" style="display:none">
      <div class="sac-autoHeader">
        <span class="sac-autoTitle" id="sacAutoSubTitle">Auto Sub</span>
        <div class="sac-autoHeaderBtns">
          <div id="sacAutoSubBack" class="sac-autoSubBack" role="button"><span data-ic="arrow_left" data-ic-size="12"></span> Về cut</div>
        </div>
      </div>

      <div class="sac-autoTabRow">
        <span class="sac-autoTabsLabel">Video</span>
        <div class="sac-autoTabs">
          <div class="sac-autoSubTab is-active" data-job="0" role="button">.0</div>
          <div class="sac-autoSubTab" data-job="1" role="button">.1</div>
          <div class="sac-autoSubTab" data-job="2" role="button">.2</div>
        </div>
      </div>

      <div id="sacAutoSubSlot" class="sac-autoSubSlot"></div>

      <!-- Status RIÊNG: #sacAutoStatus nằm trong #sacPanelAuto, mà panel đó bị ẩn
           khi trang Sub mở → autoStatus() ghi vào chỗ không ai thấy. -->
      <div id="sacAutoSubStatus" class="sac-autoStatus"></div>
    </div>
```

- [ ] **Step 2: Thêm CSS, trước `/* ── /AUTO PAGE ── */`**

```css
/* Trang Auto Sub — tab .0/.1/.2 dùng chung dáng với .sac-autoTab. */
.sac-autoSubTab {
  flex: 1 1 0; min-width: 0; text-align: center;
  padding: 8px 6px; border-radius: 6px; background: var(--surface2); color: var(--text-dim);
  font-size: 15px; font-weight: 700; cursor: pointer;
  border: 1px solid transparent;
}
.sac-autoSubTab.is-active { background: var(--accent); color: var(--accent-fg); border-color: var(--accent-light); }
.sac-autoSubBack {
  padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 11px;
  background: var(--surface2); color: var(--text-dim); border: 1px solid var(--border);
}
.sac-autoSubBack:hover { background: var(--border); color: var(--text); }
/* Slot phải giãn hết chỗ còn lại, nếu không .st-app co về 0. Cùng lý do đã ghi
   ở .sac-autoManualSlot. */
.sac-autoSubSlot { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; }
```

- [ ] **Step 3: Thêm hàm mượn/trả, đặt NGAY SAU `autoReturnVoiceDrop()`**

```js
  var autoSubHome = null;    // placeholder ở vị trí gốc của .st-app trong tab TẠO SUB
  function autoBorrowSub() {
    var app = document.querySelector('.st-app');
    var slot = $('sacAutoSubSlot');
    if (!app || !slot || autoSubHome) return;
    var ph = document.createElement('div');
    ph.id = 'stAppHomeMark';
    ph.style.display = 'none';
    app.parentNode.insertBefore(ph, app);
    autoSubHome = { mark: ph };
    slot.appendChild(app);
  }
  function autoReturnSub() {
    if (!autoSubHome) return;
    var app = document.querySelector('.st-app');
    var mark = autoSubHome.mark;
    autoSubHome = null;
    if (!app) return;
    try { if (mark && mark.parentNode) mark.parentNode.insertBefore(app, mark); }
    catch (e) { console.error('[SAC] autoReturnSub lỗi:', e); }
    try { if (mark && mark.parentNode) mark.parentNode.removeChild(mark); } catch (e) {}
  }
```

- [ ] **Step 4: Kiểm cú pháp**

```bash
node --check plugin/main.js
```

- [ ] **Step 5: [HARNESS] Soi bố cục trang Sub**

Thêm `#sacPanelAutoSub` (đổi sang `display:flex`) vào harness, nhét một khối cao giả vào `#sacAutoSubSlot`.
Kỳ vọng: ở khung 420px thấp, phần slot cuộn được và nút "Về cut" vẫn thấy ở header.

- [ ] **Step 6: Commit**

```bash
git add plugin/index.html plugin/styles.css plugin/main.js
git commit -m "feat(autosub): markup + CSS trang Auto Sub, mượn/trả node .st-app"
```

---

## Task 9: Đổi sequence theo tab

**Files:**
- Modify: `plugin/main.js` — thêm `autoActivateSeqByName()` sau `autoMoveSeqToBin()` (khoảng dòng 5631)

- [ ] **Step 1: XÁC MINH API trước khi viết tiếp**

`projectItem.getSequence()` được dùng ở `main.js:11731` nhưng trên projectItem của **clip nested**, chưa xác minh trên projectItem của sequence thường. Kiểm bằng cách chạy trong console plugin của Premiere (có sẵn 1 sequence tên bất kỳ):

```js
(async function () {
  var proj = await getActiveProject();
  var root = typeof proj.getRootItem === 'function' ? proj.getRootItem() : proj.rootItem;
  if (root && root.then) root = await root;
  var all = await sacCollectBinItems(root);
  console.log('items:', all.map(function (i) { return i.name; }));
  var hit = all[0];
  console.log('getSequence có không:', typeof hit.item.getSequence);
  console.log('kết quả:', await hit.item.getSequence());
})();
```

Kỳ vọng: `getSequence` là `'function'` và trả về object sequence (không null).
**Nếu trả về null hoặc không có hàm** — dừng lại, báo lại, đừng đoán API khác.

- [ ] **Step 2: Thêm hàm**

```js
  // Kích hoạt sequence theo TÊN. Tra theo tên chứ không giữ object: object của
  // sequence vừa tạo có thể stale sau khi Premiere xử lý xong. Tên là duy nhất
  // vì tên chính là deliverable.
  async function autoActivateSeqByName(seqName) {
    var proj = await getActiveProject();
    var root = typeof proj.getRootItem === 'function' ? proj.getRootItem() : proj.rootItem;
    if (root && typeof root.then === 'function') root = await root;
    var all = await sacCollectBinItems(root);
    var hit = all.filter(function (it) { return it.name === seqName; })[0];
    if (!hit) throw new Error('không tìm thấy sequence ' + seqName);
    var seq = null;
    try { seq = await hit.item.getSequence(); } catch (e) {}
    if (!seq) throw new Error('không mở được sequence ' + seqName);
    if (typeof proj.openSequence === 'function') await proj.openSequence(seq);
    if (typeof proj.setActiveSequence === 'function') await proj.setActiveSequence(seq);
    // Sequence vừa kích hoạt mà chạm ngay là nguyên nhân crash quen thuộc —
    // sacRunAutoCut chờ 900ms sau khi activate vì lý do này.
    await new Promise(function (r) { setTimeout(r, 900); });
    return seq;
  }
```

- [ ] **Step 3: Kiểm cú pháp**

```bash
node --check plugin/main.js
```

- [ ] **Step 4: [PREMIERE] Kiểm riêng hàm này**

Trong console plugin, với project đã có sequence tên biết trước:
```js
await autoActivateSeqByName('TÊN SEQUENCE CÓ THẬT');
```
Kỳ vọng: Premiere nhảy sang đúng sequence đó trong timeline.
(Nếu hàm nằm trong IIFE nên console không gọi được, tạm gán `window.__t = autoActivateSeqByName;` để test rồi **xoá dòng đó trước khi commit**.)

- [ ] **Step 5: Commit**

```bash
git add plugin/main.js
git commit -m "feat(autosub): autoActivateSeqByName — kích hoạt sequence theo tên"
```

---

## Task 10: Tab trang Sub — đổi sequence + đổ script

**Files:**
- Modify: `plugin/main.js` — thêm sau `autoActivateSeqByName()`

- [ ] **Step 1: Thêm state + hàm render tab**

```js
  var autoSubActiveJob = 0;
  var autoSubJobs = [];   // jobs từ autoStage3 (đã có seqName, idx, rows)

  // KHÔNG dùng autoStatus() ở trang Sub: nó ghi vào #sacAutoStatus nằm trong
  // #sacPanelAuto, mà panel đó đang bị ẩn → thông báo lỗi biến mất.
  function autoSubStatus(msg) {
    var el = $('sacAutoSubStatus');
    if (el) el.textContent = msg;
  }

  // Đổ script của job vào ô script của tab TẠO SUB. Dùng stSetScript() có sẵn
  // (nó lo cả reflow textarea). Điền script KHÔNG kích hoạt chạy: countdown chỉ
  // được gọi từ MỘT chỗ, ở cuối bước transcribe sau khi người dùng bấm nút.
  function autoSubFillScript(job) {
    var lines = ((job && job.rows) || [])
      .map(function (c) { return (c[0] || '').trim(); })
      .filter(Boolean);
    if (typeof window.SubtextSetScript === 'function') window.SubtextSetScript(lines);
  }

  async function autoSubRenderTab() {
    document.querySelectorAll('.sac-autoSubTab').forEach(function (t) {
      t.classList.toggle('is-active', Number(t.dataset.job) === autoSubActiveJob);
    });
    var job = autoSubJobs[autoSubActiveJob];
    if (!job) { autoSubStatus('✗ Video .' + autoSubActiveJob + ' chưa dựng được timeline.'); return; }
    var title = $('sacAutoSubTitle');
    if (title) title.textContent = 'Auto Sub — ' + job.seqName;
    autoSubFillScript(job);
    autoSubStatus('⏳ Đang mở sequence ' + job.seqName + '…');
    try {
      await autoActivateSeqByName(job.seqName);
      autoSubStatus('✓ Sequence .' + job.idx + ' đang mở · script đã nạp — bấm "AI ngắt câu → Tạo SRT" khi sẵn sàng.');
    } catch (e) {
      autoSubStatus('✗ ' + e.message);
    }
  }

  document.querySelectorAll('.sac-autoSubTab').forEach(function (t) {
    t.addEventListener('click', function () {
      autoSubActiveJob = Number(t.dataset.job);
      autoSubRenderTab();
    });
  });
```

- [ ] **Step 2: Thêm accessor `window.SubtextSetScript` trong IIFE TẠO SUB**

`stSetScript()` nằm trong IIFE khác — gọi trực tiếp là `ReferenceError` lúc chạy (handoff §3.3). Thêm ngay SAU định nghĩa `stSetScript` (`main.js:10919`, kết thúc ở dòng 10924):

```js
  // Cho trang Auto Sub đổ script vào. Ranh giới IIFE: trang Auto không thấy
  // stSetScript trực tiếp, phải đi qua window.*
  window.SubtextSetScript = function (lines) { stSetScript(lines); };
```

- [ ] **Step 3: Xác nhận accessor tồn tại**

```bash
grep -n "window.SubtextSetScript" plugin/main.js
```
Kỳ vọng: **2 dòng** — 1 chỗ định nghĩa, 1 chỗ gọi.

- [ ] **Step 4: Kiểm cú pháp**

```bash
node --check plugin/main.js
```

- [ ] **Step 5: Commit** (chưa kiểm được tới khi Task 11 nối vào luồng)

```bash
git add plugin/main.js
git commit -m "feat(autosub): tab .0/.1/.2 đổi sequence + đổ script của video đó"
```

---

## Task 11: Mở trang Auto Sub sau khi dựng xong + nút Về cut

**Files:**
- Modify: `plugin/main.js` — cuối `autoStage3()` (khoảng dòng 5655)

- [ ] **Step 1: Thêm hàm mở/đóng trang Sub, đặt trước `autoStage3`**

```js
  function autoOpenSub(jobs) {
    autoSubJobs = jobs || [];
    var first = 0;
    for (var i = 0; i < autoSubJobs.length; i++) {
      if (autoSubJobs[i].state === 'built') { first = i; break; }
    }
    autoSubActiveJob = first;
    autoBorrowSub();
    $('sacPanelAuto').style.display = 'none';
    $('sacPanelAutoSub').style.display = 'flex';
    autoSubRenderTab();
  }
  function autoCloseSub() {
    autoReturnSub();
    $('sacPanelAutoSub').style.display = 'none';
    $('sacPanelAuto').style.display = 'flex';
  }
```

- [ ] **Step 2: Gọi ở cuối `autoStage3()`**

Tìm cuối hàm:
```js
    var ok = jobs.filter(function (j) { return j.state === 'built'; });
    var msg = 'Bộ ' + autoSet.setNumber + ': ' + ok.length + '/' + jobs.length + ' timeline xong';
    autoStatus('✓ ' + msg);
    autoNotify('Autocut xong', msg);
  }
```

Thay bằng:
```js
    var ok = jobs.filter(function (j) { return j.state === 'built'; });
    var msg = 'Bộ ' + autoSet.setNumber + ': ' + ok.length + '/' + jobs.length + ' timeline xong';
    autoStatus('✓ ' + msg);
    autoNotify('Autocut xong', msg);
    // Dựng xong thì đi thẳng sang làm phụ đề — script đã có sẵn trong job.
    // Không có timeline nào dựng được thì ở lại trang Auto để còn đọc lỗi.
    if (ok.length) autoOpenSub(jobs);
  }
```

- [ ] **Step 3: Nối nút Về cut, đặt cạnh handler tab ở Task 10**

```js
  var sacAutoSubBackBtn = $('sacAutoSubBack');
  if (sacAutoSubBackBtn) sacAutoSubBackBtn.addEventListener('click', autoCloseSub);
```

- [ ] **Step 4: Kiểm cú pháp**

```bash
node --check plugin/main.js
```

- [ ] **Step 5: [PREMIERE] Kiểm end-to-end — đây là bước quan trọng nhất**

Dùng **bộ nháp 99** để không đụng dữ liệu thật.

1. Trang Auto → bộ 99 → dán script khác nhau vào cả 3 tab .0/.1/.2 → chọn voice từng tab.
2. Bấm "Chạy cả bộ" → modal hiện đủ 9 dòng → bấm Chạy.
3. Chờ hết chặng 2 (gen voice), nghe thử, bấm lần nữa.
4. Chặng 3 chạy: kỳ vọng **không** thấy trang success chen vào.
5. Xong → kỳ vọng tự ra **trang Auto Sub**, tiêu đề là tên sequence .0, ô script đã có script của .0, Premiere đang ở sequence .0.
6. Bấm tab **.1** → Premiere nhảy sang sequence .1, ô script đổi sang script của .1, **chưa chạy gì cả**.
7. Bấm nút **AI ngắt câu → Tạo SRT** → chạy bình thường, phần chẩn đoán ghim đúng dòng script đầu của .1.
8. Bấm **← Về cut** → về trang Auto.
9. Sang tab **TẠO SUB** ở thanh tab chính → kỳ vọng tab này **vẫn dùng được bình thường** (node đã trả về).
10. Về tab Autocut → **Manual** → kỳ vọng bảng script vẫn còn cell, không trống trơn.

Mọi lỗi trong console phải ghi lại — đừng bỏ qua cái nào.

- [ ] **Step 6: Commit**

```bash
git add plugin/main.js
git commit -m "feat(autosub): dựng xong thì mở trang Auto Sub, nút Về cut trả node"
```

---

## Task 12: Cập nhật tài liệu

**Files:**
- Modify: `docs/superpowers/HANDOFF-autocut-auto-page.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Cập nhật handoff**

Sửa các mục sau cho khớp thực tế:
- §2 bảng luồng: thêm bước modal confirm trước chặng 1.
- §3.2: thêm `autoBorrowSub()` / `autoReturnSub()` vào danh sách các thứ được mượn; ghi rõ cả 3 cặp borrow/return đều dùng **placeholder**, không dùng `nextSibling`.
- §4 bẫy UXP: thêm mục "`insertBefore` với ref node là text/comment ném lỗi — dùng placeholder".
- §7 việc còn treo: bỏ mục đã xong, thêm mục mới nếu Task 11 phát hiện vấn đề.

- [ ] **Step 2: Thêm mục CHANGELOG**

Theo đúng định dạng các mục đã có trong `CHANGELOG.md`. Ghi 4 thay đổi: popup confirm, token màu, chặn trang success trong luồng Auto, trang Auto Sub.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/HANDOFF-autocut-auto-page.md CHANGELOG.md
git commit -m "docs: cập nhật handoff + changelog cho trang Auto Sub"
```

---

## Đối chiếu với spec

| Mục spec | Task |
|---|---|
| 1 · Popup confirm thay preview inline | 3, 4, 5 |
| 2 · Token màu thay hex cứng | 2 |
| 3 · Chặn trang success trong luồng Auto | 7 |
| 4 · Trang Auto Sub | 8, 9, 10, 11 |
| 5 · Dọn `autoBorrowVoiceDrop` trùng | 6 |
| Kiểm chứng (harness + Premiere) | 1, và bước [PREMIERE] trong 5, 6, 7, 9, 11 |
