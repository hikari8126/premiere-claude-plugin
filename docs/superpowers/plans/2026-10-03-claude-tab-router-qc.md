# Tab Claude — Điều phối bằng lời + Tạo bộ NAV + Soát lỗi — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mở lại tab Claude dưới dạng một tab nhỏ, nổi bật, đứng đầu trang 1 với nhân vật Clawd. Trong tab, người dùng gõ lệnh để (1) điều phối các tab có sẵn, (2) tạo bộ NAV gồm 3 sequence rỗng đặt sẵn tên chuẩn và nằm trong bin `Sequence / FB / {set}x`, (3) soát lỗi sequence trước khi xuất.

**Architecture:** Claude chỉ làm phần *hiểu ý*: trả về khối ```` ```actions ```` theo một danh sách action cho phép (whitelist). Mọi việc thật do code chắc chắn làm: dựng tên qua `/autoset/names`, tạo sequence bằng `project.createSequence`, chuyển bin bằng `ppMoveToBin`, soát lỗi bằng hàm thuần `qc-core.js`. Action nào làm thay đổi project (tạo sequence, gen voice tốn credit) đều hiện thẻ xem trước kèm nút xác nhận, không tự chạy.

**Lưu ý nền:** QC đợt 2 (`be91431`) đổi thanh tab thành một nút lật trang; R3 (`0025bbb`) đã có bước xem trước và bỏ qua sequence trùng tên ở Resize, nên thẻ NAV nên dùng cùng cách báo trùng.

**Tech Stack:** UXP plugin (JS không dùng module, `main.js` + file riêng có IIFE xuất ra `window` lẫn `module.exports`), bridge Node/Express, test bằng `node` (`cd bridge && npm test`).

**Ngoài phạm vi (plan riêng sau):** các task Resize do AI hỗ trợ, chờ user gửi luồng làm việc. Các action chạy thẳng tab khác (`subtext_run`, `rawcut_export`, `resize_set`) cũng để sang plan đó.

---

## Tiến độ

- ✅ **Phase A (tab Clawd + làm lại giao diện)** — nhánh `feat/claude-tab`. Khác plan gốc: đập đi xây lại cả tab
  (user cho phép): bỏ header / thanh trạng thái / bong bóng chat / **đính-dán ảnh cutsheet** (user bỏ); logic DOM ở
  `plugin/claude-tab.js`, hàm thuần ở `plugin/claude-log.js` (render trả lời, lịch sử 20 lệnh, nhãn sequence) và
  `plugin/clawd-pixel.js` (5 cảnh idle/blink/think/done/fail); `main.js` chỉ còn `ppExecuteAction` +
  `refreshTimeline` → `window.ClaudeTabSetSeq`. Lệnh mẫu ở màn trống chỉ gồm việc đã chạy được (Voice Gen script/SFX,
  Autocut) — thêm "tạo bộ NAV", "soát lỗi" khi Phase C/D xong. Đã chạy thật trong bản DEV (Opus 5.5 → action ✓).
- ✅ Model Opus 5.5 cho mọi lời gọi (`bridge/claude-model.js`), CLI ≥ 2.1.280.
- ✅ Chỉnh UI theo review: Clawd vẽ lại theo dáng gốc Claude Code, 5 cảnh (idle/think/**work**/done/fail);
  nút tab kiểu "Clawd đứng riêng" (không nền, vạch ngăn, vạch cam dưới chân); ô lệnh `[ô][+][gửi]` theo
  kiểu sizer của Voice Gen. **Bài học UXP:** textarea có sẵn margin 6px, không chịu `height`; flex `gap`
  không được hỗ trợ (dùng margin); `background: transparent` / `border: none` trên textarea bị bỏ qua.
- ✅ **Phase B** — `plugin/claude-actions.js` (whitelist: get_timeline_info, open_tab, voicegen_script, voicegen_sfx,
  autocut_load; gen tốn credit → hỏi ngay trong mục lệnh), `bridge/chat-prompt.js` (prompt điều phối tiếng Việt),
  CLI chat `--disallowedTools` (Bash/Edit/Write/Web…), gỡ nhánh cut/move/trim/set_volume/add_marker/add_subtitle.
  `create_set` / `qc_run` CHƯA vào whitelist + prompt — thêm ở C/D (kèm test chat-prompt). Đã chạy thật trên DEV:
  mở tab RAW ✓, "gen luôn" → hỏi → "Chỉ đẩy script" ✓ (không gen), lệnh cắt clip → báo chưa hỗ trợ, không action.
- ⏳ Sửa thẻ gợi ý màn trống (user muốn làm cùng), rồi C (tạo bộ NAV), D (soát lỗi), E (version).
- ➕ Thêm vào Phase E: bộ cài + Bridge app tự nâng Claude CLI khi < 2.1.280 (Opus 5.5 cần); thêm lệnh mẫu
  "tạo bộ NAV" / "soát lỗi" vào màn trống khi C/D xong; claude-tab.js nối `qc_run` / `create_set` vào cảnh
  Clawd `work`.

## Quyết định đã chốt (2026-10-03)

| # | Quyết định |
|---|---|
| D1 | "NAV" = **New Ads Videos**, thuật ngữ quy định của doanh nghiệp, **không** phải mã sản phẩm. Lệnh "tạo bộ NAV 40x" tương đương `create_set {set:"40"}`. `{sp}`, CO, Editor lấy từ cài đặt trang Auto (Autocut). |
| D2 | Bin có cấp con theo bộ: dùng mẫu `seqBinTpl` của trang Auto, mặc định `Sequence / FB / {set}x`. |
| D3 | Sequence tạo **rỗng** (`createSequence`): fps theo mặc định của project, khung hình đặt lại sau khi tạo. |
| D4 | Giữ **tab Claude riêng**, nhỏ, nằm đầu trang 1, Clawd là điểm nhấn. |
| D5 | Làm hướng 1 (điều phối) và hướng 3 (soát lỗi). Bỏ hẳn các action sửa timeline cũ (`move_clip`, `trim_clip`, `set_volume`, `apply_effect`, `add_subtitle`, `cut_clip`, `add_marker`, `cutlist`) vì dùng setter kiểu ExtendScript, không chạy trên UXP. |

## Câu hỏi còn mở, hỏi user trước khi làm task tương ứng

- **Q1 (Task 1):** duyệt mockup tab Clawd (memory "Confirm trước khi sửa UI").
- **Q2 (Task 6):** khung hình của 3 sequence lấy theo ratio từng job của trang Auto (mặc định 9:16), hay một ratio chung chọn trên thẻ? Plan đang làm: thẻ có 1 select chung, giá trị ban đầu là ratio job .0 của trang Auto.
- **Q3 (Task 6):** nếu đã có sequence trùng tên trong project thì **bỏ qua và báo** (plan đang làm vậy), hay tạo thêm bản `(2)`?

## Điều kiện tiên quyết

- Đang có task QC chạy trên `qc/review-features`. **Không làm chung working copy.** Khi QC xong, tạo worktree từ nhánh mới nhất:
  `git worktree add ../premiere-claude-plugin-claude-tab -b feat/claude-tab qc/review-features` (hoặc từ `main` nếu QC đã merge).
- Version: dùng hậu tố `-beta.N` cho `PLUGIN_VERSION` + `BRIDGE_VERSION`, giữ `manifest.json` sạch (memory "Version cho bản chưa release").
- Chạy toàn bộ một mạch trên branch, user chỉ review bản cuối (memory "Chạy toàn bộ, review cuối").
- Test live trong Premiere: `bash dev.sh` (bản DEV ở :3035) và `bash dev.sh eval f.js` để dò API.
- Số dòng trong plan lấy theo `qc/review-features` ngày 2026-10-03. Task QC còn đang sửa `main.js` nên số dòng sẽ lệch: luôn tìm theo tên hàm hoặc comment được nêu, đừng tin số dòng.

## Bản đồ file

| File | Việc | Trách nhiệm |
|---|---|---|
| `plugin/clawd-pixel.js` | Tạo | Hàm thuần dựng khung pixel Clawd (idle/blink/think) thành SVG. Global `CLAWD`. |
| `plugin/claude-actions.js` | Tạo | Hàm thuần: parse khối actions, đối chiếu whitelist, phân loại `auto` / `confirm`. Global `CLA`. |
| `plugin/qc-core.js` | Tạo | Hàm thuần soát lỗi từ snapshot timeline. Global `QCC`. |
| `plugin/claude-tab.js` | Tạo | Phần nối với Premiere/DOM: thẻ tạo bộ NAV, thu snapshot cho QC, thẻ kết quả QC, nhảy playhead. |
| `bridge/chat-prompt.js` | Tạo | `SYSTEM_PROMPT` mới (tách khỏi server.js) để test được. |
| `bridge/autoset-names.js` | Sửa | Thêm `buildSeqNames(cfg, set)`, không cần tên voice. |
| `bridge/server.js` | Sửa | Dùng `chat-prompt.js`; `/autoset/names` nhận `seqOnly`; CLI chat chặn tool. |
| `plugin/main.js` | Sửa | `ppExecuteAction` theo whitelist; tách `ppCreateEmptySequence`; xuất `window.AutoGetSetConfig`, `window.SubtextGetScript`; fallback trang tab bỏ qua Claude. |
| `plugin/index.html` | Sửa | Nút tab Clawd; empty state mới; quick actions mới; nạp script mới. |
| `plugin/styles.css` | Sửa | Style `.tab-btn--claude`, thẻ NAV, thẻ QC. |
| `bridge/test/*.test.js` | Tạo | `clawd-pixel`, `claude-actions`, `qc-core`, `chat-prompt`, bổ sung `autoset-names`. |

Mẫu cho file thuần (giống `plugin/vg-seq.js`): IIFE gán vào `window.X` và `module.exports`, test ở `bridge/test/` bằng `require("../../plugin/x.js")`.

---

## Phase A — Tab Clawd

### Task 1: Mockup tab Clawd, chờ user duyệt (Q1)

**Files:** không sửa code.

- [ ] **Step 1:** Dựng mockup bằng `show_widget`: thanh tab trang 1 gồm `[Clawd] VOICE GEN | AUTOCUT | TẠO SUB | UN-NEST [nút lật trang]`. Tab Clawd rộng khoảng 30px, chỉ có icon Clawd 16px màu cam Claude `#D97757`. Khi active có viền trên màu cam (khác `--accent` của các tab khác), nền cam nhạt 8%. Vẽ 2 trạng thái: thường và active (Clawd chớp mắt). Kèm mockup empty state trong tab: Clawd 48px, dòng "Gõ lệnh cho Premiere", 3 chip gợi ý: "Tạo bộ NAV __x", "Soát lỗi sequence này", "Mở Voice Gen".
- [ ] **Step 2:** Hỏi user OK hay chỉnh. Chưa OK thì không làm Task 3.

### Task 2: `clawd-pixel.js`, khung pixel thuần

**Files:**
- Create: `plugin/clawd-pixel.js`
- Test: `bridge/test/clawd-pixel.test.js`

- [ ] **Step 1: Viết test fail**

```js
// bridge/test/clawd-pixel.test.js — khung pixel Clawd cho tab Claude.
const test = require("node:test");
const assert = require("node:assert");
const CLAWD = require("../../plugin/clawd-pixel.js");

test("mọi khung cùng kích thước 12×9, chỉ dùng ký tự đã khai báo", () => {
  for (const name of ["idle", "blink", "think"]) {
    const frames = CLAWD.frames(name);
    assert.ok(frames.length >= 1, name);
    for (const f of frames) {
      assert.strictEqual(f.length, 9, name + " cao 9");
      for (const row of f) {
        assert.strictEqual(row.length, 12, name + " rộng 12");
        assert.match(row, /^[.OK]+$/);
      }
    }
  }
});

test("blink khác idle ở hàng mắt, think có ≥2 khung (chân bước)", () => {
  const idle = CLAWD.frames("idle")[0], blink = CLAWD.frames("blink")[0];
  assert.notDeepStrictEqual(idle, blink);
  assert.ok(CLAWD.frames("think").length >= 2);
});

test("toSvg gộp pixel theo hàng, có viewBox đúng và màu cam", () => {
  const svg = CLAWD.toSvg(CLAWD.frames("idle")[0], 16);
  assert.match(svg, /^<svg [^>]*viewBox="0 0 12 9"/);
  assert.match(svg, /#D97757/i);
  assert.ok((svg.match(/<rect /g) || []).length < 12 * 9, "đã gộp rect liền nhau");
});

test("tên cảnh lạ → trả idle, không ném", () => {
  assert.deepStrictEqual(CLAWD.frames("??"), CLAWD.frames("idle"));
});
```

- [ ] **Step 2:** Chạy `node bridge/test/clawd-pixel.test.js`. Kỳ vọng: FAIL `Cannot find module`.
- [ ] **Step 3: Viết code**

```js
// plugin/clawd-pixel.js — Clawd (linh vật Claude) dạng pixel 12×9 cho tab Claude (global CLAWD).
// UXP không chạy CSS @keyframes ổn định → JS đổi khung SVG như rawcut-pixel.js.
// O = thân cam, K = mắt (nền tối), . = trong suốt.

var CLAWD = (function () {
  var BODY = '#D97757', EYE = '#1a1a1a';
  var TOP   = '..OOOOOOOO..';
  var EYES  = '..OKOOOOKO..';
  var SHUT  = '..OOOOOOOO..';
  var ARMS  = 'OOOOOOOOOOOO';
  var LOW   = '..OOOOOOOO..';
  var LEG_A = '..O.O..O.O..';
  var LEG_B = '...O.O..O.O.';
  var EMPTY = '............';

  function body(eyes, legs1, legs2) {
    return [EMPTY, TOP, eyes, eyes, ARMS, ARMS, LOW, legs1, legs2];
  }
  var SCENES = {
    idle:  [body(EYES, LEG_A, LEG_A)],
    blink: [body(SHUT, LEG_A, LEG_A)],
    think: [body(EYES, LEG_A, LEG_A), body(EYES, LEG_B, LEG_B)]
  };

  function frames(name) { return SCENES[name] || SCENES.idle; }

  // Gộp các ô cùng màu liền nhau trên một hàng thành một <rect> cho nhẹ DOM.
  function toSvg(frame, size) {
    var out = [];
    for (var y = 0; y < frame.length; y++) {
      var row = frame[y], x = 0;
      while (x < row.length) {
        var c = row.charAt(x), x0 = x;
        while (x < row.length && row.charAt(x) === c) x++;
        if (c === '.') continue;
        out.push('<rect x="' + x0 + '" y="' + y + '" width="' + (x - x0) + '" height="1" fill="' + (c === 'K' ? EYE : BODY) + '"/>');
      }
    }
    var w = size || 16, h = Math.round(w * 9 / 12);
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 9" width="' + w + '" height="' + h + '" shape-rendering="crispEdges">' + out.join('') + '</svg>';
  }

  return { frames: frames, toSvg: toSvg };
})();

(function (root) {
  if (root) { root.CLAWD = CLAWD; }
  if (typeof module !== "undefined" && module.exports) { module.exports = CLAWD; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
```

- [ ] **Step 4:** `node bridge/test/clawd-pixel.test.js`. Kỳ vọng: PASS.
- [ ] **Step 5:** Commit `feat(claude): khung pixel Clawd (clawd-pixel.js)`.

### Task 3: Nút tab Clawd đầu trang 1 (sau khi Q1 OK)

**Files:**
- Modify: `plugin/index.html:31-44` (tab bar), `plugin/index.html:76-109` (empty state + quick actions), `plugin/index.html:~2105` (nạp script)
- Modify: `plugin/styles.css` (sau `.tab-btn.active::before`, khoảng dòng 160)
- Modify: `plugin/main.js:2683-2684` (`tabGoPage` fallback)

- [ ] **Step 1:** Trong tab bar (QC đợt 2 đã bỏ nút ‹, chỉ còn một nút lật trang bên phải), chèn ngay **trước** tab `voicegen`, thay comment cũ "Claude chat tab temporarily hidden" bằng:

```html
  <!-- Tab Claude: nhỏ, chỉ có Clawd, luôn đứng đầu trang 1 -->
  <div class="tab-btn tab-btn--claude" role="button" data-tab="claude" data-page="1" aria-label="Claude"><span id="clawdTabIcon"></span></div>
```

- [ ] **Step 2:** Thay khối `#empty-state` và `#quick-actions`:

```html
      <div id="empty-state">
        <div class="clawd-hero" id="clawdHero"></div>
        <p>Gõ lệnh cho Premiere</p>
        <div class="claude-suggest">
          <button class="quick-btn" data-fill="Tạo bộ NAV x">Tạo bộ NAV __x</button>
          <button class="quick-btn" data-run="qc">Soát lỗi sequence này</button>
          <button class="quick-btn" data-fill="Mở Voice Gen">Mở Voice Gen</button>
        </div>
      </div>
```

```html
      <div id="quick-actions">
        <button class="quick-btn" data-run="qc">✓ Soát lỗi</button>
        <!-- custom shortcuts rendered here by JS -->
        <button class="quick-add-btn" id="add-shortcut-btn">+</button>
      </div>
```

Nạp script, đặt **trước** `main.js` (vì main.js dùng CLA/CLAWD):

```html
<script src="clawd-pixel.js"></script>
<script src="claude-actions.js"></script>
<script src="qc-core.js"></script>
```

và **sau** `rawcut.js`: `<script src="claude-tab.js"></script>`.

- [ ] **Step 3:** CSS (không dùng `position:fixed`, `z-index`, `grid`):

```css
/* Tab Claude: nhỏ, chỉ icon Clawd, màu cam riêng (không theo --accent) */
.tab-btn--claude { flex: 0 0 auto; width: 30px; padding: 0; display: flex; align-items: center; justify-content: center; }
.tab-btn--claude.active { background: rgba(217, 119, 87, 0.08); color: #D97757; box-shadow: 0 -2px 8px rgba(217, 119, 87, 0.25); }
.tab-btn--claude.active::before { background: #D97757; }
.clawd-hero { display: flex; justify-content: center; margin-bottom: 8px; }
.claude-suggest { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 10px; }
```

- [ ] **Step 4:** Trong `tabGoPage` (main.js:2683), fallback không rơi vào tab Claude:

```js
  var btn = (last && document.querySelector('.tab-btn[data-page="' + page + '"][data-tab="' + last + '"]'))
         || document.querySelector('.tab-btn[data-page="' + page + '"]:not([data-tab="claude"])');
```

- [ ] **Step 5:** Viết `plugin/claude-tab.js` (khung, các phase sau nối thêm). Gồm vẽ Clawd, chớp mắt, và chip gợi ý:

```js
// plugin/claude-tab.js — phần nối Premiere/DOM cho tab Claude: Clawd, thẻ tạo bộ NAV, soát lỗi.
// Hàm thuần nằm ở clawd-pixel.js / claude-actions.js / qc-core.js (có test).
(function () {
  var $ = function (id) { return document.getElementById(id); };

  // ── Clawd: icon tab 16px + hero 48px, chớp mắt mỗi ~4s, bước chân khi Claude đang nghĩ ──
  var clawdState = 'idle', thinkTick = 0;
  function drawClawd(scene) {
    var fr = CLAWD.frames(scene);
    var f = fr[thinkTick % fr.length];
    var tab = $('clawdTabIcon'), hero = $('clawdHero');
    if (tab)  tab.innerHTML  = CLAWD.toSvg(f, 16);
    if (hero) hero.innerHTML = CLAWD.toSvg(f, 48);
  }
  setInterval(function () {
    thinkTick++;
    if (clawdState === 'think') return drawClawd('think');
    drawClawd(thinkTick % 16 === 0 ? 'blink' : 'idle');
  }, 250);
  window.ClawdSetThinking = function (on) { clawdState = on ? 'think' : 'idle'; drawClawd(clawdState); };
  drawClawd('idle');

  // ── Chip gợi ý: data-fill điền ô nhập, data-run chạy thẳng ──
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-fill],[data-run]') : null;
    if (!b) return;
    if (b.dataset.fill) {
      var inp = $('message-input');
      inp.value = b.dataset.fill; inp.focus();
    } else if (b.dataset.run === 'qc' && typeof window.ClaudeRunQc === 'function') {
      window.ClaudeRunQc();
    }
  });
})();
```

Trong `sendMessage()` (main.js khoảng 1352) gọi `window.ClawdSetThinking && window.ClawdSetThinking(true)` sau `isStreaming = true`. Trong `resetInput()` gọi `window.ClawdSetThinking && window.ClawdSetThinking(false)`.

Handler "Parse cutsheet" cũ (main.js, ngay dưới comment `// Built-in "Parse cutsheet" button`) đang gắn vào **mọi** `.quick-btn`, nên sẽ ghi `undefined` vào ô nhập khi bấm chip mới. Thu hẹp selector chỉ còn nút có `data-prompt` và sửa comment. Phần custom shortcut giữ nguyên:

```js
// Nút có sẵn prompt (data-prompt) → điền ô nhập. Chip data-fill/data-run do claude-tab.js xử lý.
document.querySelectorAll('.quick-btn[data-prompt]').forEach(function(btn) {
```

- [ ] **Step 6:** Kiểm cú pháp: `node -e "new (require('vm').Script)(require('fs').readFileSync('plugin/claude-tab.js','utf8'))"` và tương tự với `plugin/main.js`.
- [ ] **Step 7:** `bash dev.sh`, mở panel "Claude AI DEV": tab Clawd đứng đầu trang 1, bấm vào mở chat, Clawd chớp mắt, chip "Tạo bộ NAV __x" điền ô nhập; lật trang không tự nhảy vào tab Claude.
- [ ] **Step 8:** Commit `feat(claude): mở lại tab Claude — tab Clawd nhỏ đầu trang 1`.

---

## Phase B — Bộ điều phối (whitelist action + prompt mới)

### Task 4: `claude-actions.js`, parse + whitelist + phân loại

**Files:**
- Create: `plugin/claude-actions.js`
- Test: `bridge/test/claude-actions.test.js`

- [ ] **Step 1: Viết test fail**

```js
// bridge/test/claude-actions.test.js — whitelist action của tab Claude.
const test = require("node:test");
const assert = require("node:assert");
const CLA = require("../../plugin/claude-actions.js");

test("parse nhiều khối ```actions, bỏ khối JSON hỏng", () => {
  const t = 'a\n```actions\n[{"action":"open_tab","tab":"voicegen"}]\n```\nb\n```actions\n{oops\n```\n```actions\n{"action":"qc_run"}\n```';
  assert.deepStrictEqual(CLA.parse(t).map(a => a.action), ["open_tab", "qc_run"]);
});

test("create_set: chuẩn hoá số bộ, cần xác nhận", () => {
  const r = CLA.check({ action: "create_set", set: "040x" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.action.set, "40");
  assert.strictEqual(r.mode, "confirm");
});

test("create_set thiếu/sai số bộ → lỗi rõ", () => {
  assert.match(CLA.check({ action: "create_set" }).error, /số bộ/);
  assert.match(CLA.check({ action: "create_set", set: "NAV" }).error, /số bộ/);
});

test("voicegen_script autoGenerate=true → confirm (tốn credit), false → auto", () => {
  assert.strictEqual(CLA.check({ action: "voicegen_script", text: "hi", autoGenerate: true }).mode, "confirm");
  assert.strictEqual(CLA.check({ action: "voicegen_script", text: "hi" }).mode, "auto");
});

test("open_tab chỉ nhận tab có thật", () => {
  assert.strictEqual(CLA.check({ action: "open_tab", tab: "rawcut" }).ok, true);
  assert.match(CLA.check({ action: "open_tab", tab: "photoshop" }).error, /tab/);
});

test("action cũ sửa timeline bị chặn", () => {
  for (const a of ["move_clip", "trim_clip", "set_volume", "apply_effect", "cut_clip", "cutlist", "add_subtitle", "add_marker"]) {
    assert.match(CLA.check({ action: a }).error, /không hỗ trợ/, a);
  }
});
```

- [ ] **Step 2:** `node bridge/test/claude-actions.test.js`. Kỳ vọng: FAIL.
- [ ] **Step 3: Viết code**

```js
// plugin/claude-actions.js — whitelist action Claude được phép gọi (global CLA).
// Claude chỉ "hiểu ý" → action; mode 'confirm' = hiện thẻ + nút trước khi làm.

var CLA = (function () {
  var TABS = ['claude', 'voicegen', 'autocut', 'subtext', 'unnest', 'watch', 'resize', 'rawcut'];

  function parse(text) {
    var out = [], re = /```actions\s*([\s\S]*?)```/g, m;
    while ((m = re.exec(String(text || ''))) !== null) {
      try {
        var p = JSON.parse(m[1].trim());
        out = out.concat(Array.isArray(p) ? p : [p]);
      } catch (e) { /* khối hỏng → bỏ */ }
    }
    return out;
  }

  function normSet(v) {
    var s = String(v == null ? '' : v).trim().replace(/x$/i, '');
    if (!/^\d+$/.test(s)) return null;
    return s.replace(/^0+(?=\d)/, '');
  }

  var RULES = {
    get_timeline_info: function () { return { mode: 'auto' }; },
    open_tab: function (a) {
      if (TABS.indexOf(a.tab) < 0) return { error: 'không có tab "' + a.tab + '"' };
      return { mode: 'auto' };
    },
    voicegen_script: function (a) {
      if (!a.text) return { error: 'thiếu text' };
      return { mode: a.autoGenerate ? 'confirm' : 'auto' };
    },
    voicegen_sfx: function (a) {
      if (!a.text) return { error: 'thiếu text' };
      return { mode: a.autoGenerate ? 'confirm' : 'auto' };
    },
    autocut_load: function (a) {
      if (!Array.isArray(a.rows) || !a.rows.length) return { error: 'thiếu rows' };
      return { mode: 'auto' };
    },
    create_set: function (a) {
      var s = normSet(a.set);
      if (s === null) return { error: 'số bộ không hợp lệ: "' + (a.set == null ? '' : a.set) + '"' };
      a.set = s;
      return { mode: 'confirm' };
    },
    qc_run: function () { return { mode: 'auto' }; }
  };

  function check(action) {
    var a = Object.assign({}, action || {});
    var rule = RULES[a.action];
    if (!rule) return { ok: false, error: 'action "' + a.action + '" không hỗ trợ' };
    var r = rule(a);
    if (r.error) return { ok: false, error: r.error };
    return { ok: true, mode: r.mode, action: a };
  }

  return { parse: parse, check: check, TABS: TABS };
})();

(function (root) {
  if (root) { root.CLA = CLA; }
  if (typeof module !== "undefined" && module.exports) { module.exports = CLA; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
```

- [ ] **Step 4:** `node bridge/test/claude-actions.test.js`. Kỳ vọng: PASS.
- [ ] **Step 5:** Commit `feat(claude): whitelist action + phân loại auto/confirm (claude-actions.js)`.

### Task 5: Prompt mới + CLI chặn tool

**Files:**
- Create: `bridge/chat-prompt.js`
- Test: `bridge/test/chat-prompt.test.js`
- Modify: `bridge/server.js:88-191` (xoá `SYSTEM_PROMPT` cũ, require file mới), `bridge/server.js:~340` (tham số spawn)

- [ ] **Step 1: Viết test fail**

```js
// bridge/test/chat-prompt.test.js — prompt tab Claude khớp whitelist plugin.
const test = require("node:test");
const assert = require("node:assert");
const { SYSTEM_PROMPT } = require("../chat-prompt.js");
const CLA = require("../../plugin/claude-actions.js");

test("prompt nhắc đủ action whitelist", () => {
  for (const a of ["open_tab", "voicegen_script", "voicegen_sfx", "autocut_load", "create_set", "qc_run"]) {
    assert.ok(SYSTEM_PROMPT.includes(a), a);
  }
});

test("prompt không còn action cũ bị chặn", () => {
  for (const a of ["move_clip", "trim_clip", "set_volume", "apply_effect", "cutlist", "cut_clip"]) {
    assert.ok(!SYSTEM_PROMPT.includes(a), a);
    assert.strictEqual(CLA.check({ action: a }).ok, false);
  }
});

test("prompt giải thích NAV = New Ads Videos, không phải sản phẩm", () => {
  assert.match(SYSTEM_PROMPT, /NAV/);
  assert.match(SYSTEM_PROMPT, /New Ads Videos/);
});
```

- [ ] **Step 2:** `node bridge/test/chat-prompt.test.js`. Kỳ vọng: FAIL.
- [ ] **Step 3: Viết `bridge/chat-prompt.js`**

```js
// bridge/chat-prompt.js — system prompt tab Claude. Danh sách action phải khớp
// plugin/claude-actions.js (test chat-prompt.test.js kiểm hai chiều).
const SYSTEM_PROMPT = `Bạn là trợ lý điều phối nằm trong plugin Premiere Pro của team dựng video ads.
Người dùng nhắn tiếng Việt, ngắn. Việc của bạn: HIỂU Ý rồi trả về action. Bạn KHÔNG tự cắt/ghép
timeline — các tab của plugin làm việc đó. Trả lời tiếng Việt, 1–2 câu, kèm khối action.

Khi cần làm gì, chèn đúng một khối:
\`\`\`actions
[{"action": "...", ...}]
\`\`\`

ACTION ĐƯỢC PHÉP (ngoài danh sách này plugin sẽ từ chối):
- open_tab        {tab}  tab ∈ voicegen | autocut | subtext | unnest | watch | resize | rawcut
- voicegen_script {text, voiceId?, autoGenerate?}   đẩy script sang Voice Gen. Chỉ đặt autoGenerate:true khi user bảo "gen luôn".
- voicegen_sfx    {text, autoGenerate?}             đẩy prompt SFX sang Voice Gen.
- autocut_load    {rows:[{script, source, time}]}  sắp script/cutsheet lộn xộn thành bảng Autocut. time dạng "0:02-0:08".
- create_set      {set}  tạo bộ 3 sequence rỗng tên chuẩn trong bin của bộ. Plugin tự dựng tên + hỏi xác nhận.
- qc_run          {}     soát lỗi sequence đang mở (khoảng đen, media offline, flash frame, thiếu tiếng…).
- get_timeline_info {}   đọc lại timeline.

THUẬT NGỮ CỦA TEAM:
- "NAV" = New Ads Videos (quy định của công ty), KHÔNG phải tên sản phẩm.
  "tạo bộ NAV 40x", "NAV 40", "tạo bộ 40", "bộ 40x" → {"action":"create_set","set":"40"}.
- Một "bộ" = 3 video .0/.1/.2 (vd vid40.0, vid40.1, vid40.2). Tên sản phẩm/CO/Editor plugin tự lấy
  từ cài đặt — bạn KHÔNG tự đặt tên sequence.
- "soát lỗi", "check lỗi", "QC", "kiểm tra trước khi xuất" → qc_run.

Khi user gửi danh sách lỗi QC (JSON) kèm script để nhờ nhận xét: KHÔNG gọi action. Viết gọn:
lỗi nào cần sửa trước, và soát script (chính tả, câu lặp, thiếu CTA, câu quá dài cho sub).

Không chắc ý → hỏi lại 1 câu, không đoán action.`;

module.exports = { SYSTEM_PROMPT };
```

- [ ] **Step 4:** Trong `server.js` xoá khối `const SYSTEM_PROMPT = \`…\`;` (dòng 88-191), thay bằng:

```js
// ── System prompt (tab Claude) — xem chat-prompt.js ─────────────────────────
const { SYSTEM_PROMPT } = require('./chat-prompt.js');
```

- [ ] **Step 5:** Chặn tool ở CLI chat: router không cần đọc file hay chạy lệnh, chặn đi cho nhanh và an toàn. Trước hết kiểm cờ có tồn tại: `claude --help | grep -i -E 'disallowedTools|--tools'`. Có `--disallowedTools` thì thêm vào mảng spawn trong `chatViaCLI`, ngay sau `'--permission-mode', 'bypassPermissions',`:

```js
      '--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task',
```

Giữ `Read`, vì ảnh đính kèm được đọc qua `@path`.

- [ ] **Step 6:** Kiểm thử Step 5 thật: `cd bridge && node server.js` (port dev), rồi `curl -sN -X POST localhost:3030/chat -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"tạo bộ NAV 40x"}]}'`. Kỳ vọng: stream có khối `"action":"create_set","set":"40"`.
- [ ] **Step 7:** `cd bridge && npm test`. Kỳ vọng: `ALL TESTS PASSED`.
- [ ] **Step 8:** Commit `feat(bridge): prompt tab Claude mới (chat-prompt.js), CLI chat chặn tool ghi/chạy lệnh`.

### Task 6: `ppExecuteAction` theo whitelist + thẻ xác nhận

**Files:**
- Modify: `plugin/main.js:689-891` (`ppExecuteAction`), `plugin/main.js:1520-1575` (`finishStreaming`, `parseActions`, `executeActions`)
- Modify: `plugin/claude-tab.js` (thêm `ClaudeRenderConfirm`)

- [ ] **Step 1:** Viết lại `ppExecuteAction`. Giữ nguyên nhánh `voicegen_script`, `voicegen_sfx`, `autocut_load` và `get_timeline_info`. **Xoá** các nhánh `cut_clip`, `add_marker`, `add_subtitle`, `set_volume`, `move_clip`, `trim_clip`. Thêm:

```js
    if (action === 'open_tab') {
      window.tabOpen(actionObj.tab);
      return { ok: true, data: { message: 'Đã mở tab ' + actionObj.tab } };
    }
    if (action === 'create_set') return await window.ClaudeCreateSet(actionObj.set);
    if (action === 'qc_run')     return await window.ClaudeRunQc();
```

- [ ] **Step 2:** `parseActions` gọi `CLA.parse`. `executeActions` kiểm từng action:

```js
function parseActions(text) { return CLA.parse(text); }

async function executeActions(actions, parentEl) {
  var bubbleEl = parentEl.querySelector('.bubble') || parentEl;
  for (var i = 0; i < actions.length; i++) {
    var chk  = CLA.check(actions[i]);
    var chip = document.createElement('div');
    chip.className = 'action-result';
    bubbleEl.appendChild(chip);
    if (!chk.ok) { chip.className += ' error'; chip.textContent = '✗ ' + chk.error; continue; }
    if (chk.mode === 'confirm') { chip.remove(); window.ClaudeRenderConfirm(bubbleEl, chk.action); continue; }
    chip.textContent = '⚙ ' + chk.action.action + '…';
    var result = await ppExecuteAction(chk.action);
    if (result.ok) chip.textContent = '✓ ' + ((result.data && result.data.message) || chk.action.action);
    else { chip.className += ' error'; chip.textContent = '✗ ' + chk.action.action + ': ' + result.error; }
    chatArea.scrollTop = chatArea.scrollHeight;
  }
}
```

- [ ] **Step 3:** Trong `claude-tab.js` thêm thẻ xác nhận dùng chung. `create_set` có thẻ riêng (Task 8), các action confirm khác dùng thẻ đơn giản:

```js
  // ── Thẻ xác nhận cho action mode 'confirm' ──
  window.ClaudeRenderConfirm = function (host, action) {
    if (action.action === 'create_set') return window.ClaudeRenderSetCard(host, action.set);
    var card = document.createElement('div');
    card.className = 'cl-card';
    var what = action.action === 'voicegen_sfx' ? 'Gen SFX' : 'Gen voice';
    card.innerHTML = '<div class="cl-card-title">' + what + ' ngay? (tốn credit ElevenLabs)</div>'
      + '<div class="cl-card-body"></div>'
      + '<div class="cl-card-actions"><button class="cl-btn cl-btn--primary">Gen</button><button class="cl-btn">Chỉ đẩy script</button></div>';
    card.querySelector('.cl-card-body').textContent = action.text;
    var btns = card.querySelectorAll('button');
    function run(auto) {
      btns.forEach(function (b) { b.disabled = true; });
      var a = Object.assign({}, action, { autoGenerate: auto });
      ppExecuteAction(a).then(function (r) {
        card.querySelector('.cl-card-actions').textContent = r.ok ? '✓ ' + r.data.message : '✗ ' + r.error;
      });
    }
    btns[0].addEventListener('click', function () { run(true); });
    btns[1].addEventListener('click', function () { run(false); });
    host.appendChild(card);
  };
```

CSS cho `.cl-card` (styles.css):

```css
.cl-card { margin-top: 8px; padding: 8px 10px; border: 1px solid rgba(217,119,87,0.4); border-radius: 8px; background: rgba(217,119,87,0.05); }
.cl-card-title { font-weight: 600; margin-bottom: 6px; }
.cl-card-body { font-size: 11px; color: var(--text-dim); white-space: pre-wrap; }
.cl-card-actions { display: flex; gap: 6px; margin-top: 8px; }
.cl-btn { font-size: 11px; padding: 3px 10px; }
.cl-btn--primary { background: #D97757; color: #fff; border-color: #D97757; }
```

- [ ] **Step 4:** Kiểm cú pháp `main.js` + `claude-tab.js` bằng `vm.Script` như Task 3 Step 6.
- [ ] **Step 5:** `bash dev.sh`, gõ "mở tab RAW" (ra chip ✓, nhảy sang trang 2 tab RAW) và "gen voice đọc: xin chào, gen luôn" (ra thẻ xác nhận, bấm "Chỉ đẩy script" thì script sang Voice Gen, không gen).
- [ ] **Step 6:** Commit `feat(claude): action theo whitelist, thẻ xác nhận cho việc tốn credit; gỡ action sửa timeline cũ`.

---

## Phase C — Tạo bộ NAV

### Task 7: `buildSeqNames` + `/autoset/names` nhận `seqOnly`

**Files:**
- Modify: `bridge/autoset-names.js`
- Modify: `bridge/server.js:3151-3160`
- Test: `bridge/test/autoset-names.test.js` (thêm cuối file)

- [ ] **Step 1: Viết test fail** (thêm cuối file):

```js
// 31. buildSeqNames: chỉ tên sequence + bin, không cần voice (tab Claude "tạo bộ NAV")
const { buildSeqNames } = require('../autoset-names.js');
const sq = buildSeqNames(cfg, '040');
assert.strictEqual(sq.length, 3);
assert.strictEqual(sq[0].seqName, 'SonaShape vid40.0 [c.ha.ttdo] [hoang.vietnguyen]');
assert.strictEqual(sq[2].seqName, 'SonaShape vid40.2 [c.ha.ttdo] [hoang.vietnguyen]');
assert.strictEqual(sq[1].seqBin, 'Sequence / FB / 40x');
assert.strictEqual(sq[0].voiceFile, undefined, 'không dựng tên voice');
assert.throws(() => buildSeqNames(cfg, 'NAV'), /số bộ/i);
assert.throws(() => buildSeqNames(Object.assign({}, cfg, { product: '' }), 40), /sp/, 'thiếu sản phẩm thì ném');
console.log('  ✓ buildSeqNames');
```

- [ ] **Step 2:** `node bridge/test/autoset-names.test.js`. Kỳ vọng: FAIL `buildSeqNames is not a function`.
- [ ] **Step 3:** Thêm vào `autoset-names.js`, trên dòng `module.exports`:

```js
// Chỉ tên sequence + bin cho cả bộ — tab Claude "tạo bộ NAV 40x" tạo sequence
// rỗng trước khi có voice, nên không đi qua safeVoiceName.
function buildSeqNames(cfg, setNumber) {
  var set = String(setNumber).trim();
  if (!/^\d+$/.test(set)) throw new Error('số bộ không hợp lệ: "' + setNumber + '"');
  set = set.replace(/^0+(?=\d)/, '');
  var jobs = [];
  for (var idx = 0; idx < 3; idx++) {
    var vars = { sp: cfg.product, set: set, idx: idx, CO: cfg.co, Editor: cfg.editor };
    jobs.push({ idx: idx, seqName: renderTemplate(cfg.seqNameTpl, vars), seqBin: renderTemplate(cfg.seqBinTpl, vars) });
  }
  return jobs;
}
```

Đổi export thành `module.exports = { renderTemplate, safeVoiceName, buildSetNames, buildSeqNames, findVoiceOverDir };`.

- [ ] **Step 4:** Endpoint, trong `/autoset/names`:

```js
    const { config, setNumber, ext, voiceName, seqOnly } = req.body || {};
    if (!config) return res.status(400).json({ ok: false, error: 'thiếu config' });
    const jobs = seqOnly ? autosetNames.buildSeqNames(config, setNumber)
                         : autosetNames.buildSetNames(config, setNumber, ext, voiceName);
```

- [ ] **Step 5:** `cd bridge && npm test`. Kỳ vọng: PASS.
- [ ] **Step 6:** Commit `feat(bridge): /autoset/names seqOnly — tên bộ không cần voice (buildSeqNames)`.

### Task 8: Tạo sequence rỗng dùng chung + thẻ NAV

**Files:**
- Modify: `plugin/main.js:7593-7655` (tách hàm từ nhánh `seqMode === 'new'` của `sacRunAutoCut`)
- Modify: `plugin/main.js` trong closure trang Auto (gần `autoBuildCfg`, khoảng dòng 6300): xuất `window.AutoGetSetConfig`
- Modify: `plugin/claude-tab.js`

- [ ] **Step 1:** Tách hàm global `ppCreateEmptySequence(project, seqName, ratio)` ngay trên `sacRunAutoCut`. Thân hàm là **nguyên văn** đoạn main.js:7603-7652 hiện tại (createSequence → chờ 700ms → `createSetNameAction` → đổi khung nếu `ratio !== 'match'`), trả `seq`. Không open/activate (việc đó caller tự làm). Sau đó nhánh `'new'` của `sacRunAutoCut` gọi lại:

```js
async function ppCreateEmptySequence(project, seqName, ratio) {
  var seq = null;
  if (typeof project.createSequence === 'function') seq = await project.createSequence(seqName);
  if (!seq) throw new Error('Không tạo được sequence mới (createSequence)');
  await new Promise(function (r) { setTimeout(r, 700); });
  try {
    var pit = (seq.getProjectItem && seq.getProjectItem()) || seq.projectItem || null;
    if (pit && typeof pit.then === 'function') pit = await pit;
    var renameTarget = (pit && typeof pit.createSetNameAction === 'function') ? pit
                     : (typeof seq.createSetNameAction === 'function' ? seq : null);
    if (renameTarget) await sacCommitTx(project, function (ca) { ca.addAction(renameTarget.createSetNameAction(seqName)); }, 'Rename seq');
  } catch (eRn) { console.warn('[seq] rename failed:', eRn && eRn.message); }
  if (ratio && ratio !== 'match') {
    try {
      var parts = ratio.split('x'), w = parseInt(parts[0]), h = parseInt(parts[1]);
      var settings = await seq.getSettings();
      if (settings && w && h) {
        var frameRect = await settings.getVideoFrameRect();
        frameRect.width = w; frameRect.height = h;
        await settings.setVideoFrameRect(frameRect);
        await sacCommitTx(project, function (ca) { ca.addAction(seq.createSetSettingsAction(settings)); }, 'Set frame size');
      }
    } catch (es) { console.warn('[seq] frame size failed:', es.message); }
  }
  return seq;
}
```

Trong `sacRunAutoCut`, thay đoạn từ `if (typeof project.createSequence === 'function') {` đến hết khối `if (ratio !== 'match') {…}` bằng `seq = await ppCreateEmptySequence(project, seqName, ratio);`. Phần open/activate và chờ 900ms giữ nguyên.

- [ ] **Step 2:** Trong closure trang Auto, ngay sau `autoBuildCfg`, xuất cấu hình cho tab Claude:

```js
  // Tab Claude "tạo bộ NAV" dùng chung cấu hình tên + ratio job .0 của trang Auto.
  window.AutoGetSetConfig = function () {
    return { config: autoBuildCfg(), ratio: (autoSet.jobs[0] && autoSet.jobs[0].ratio) || '1080x1920' };
  };
```

`sacCollectBinItems` và `ppMoveToBin` là global; nếu `sacCollectBinItems` đang nằm trong closure thì thêm `window.sacCollectBinItems = sacCollectBinItems;` ở cuối khai báo của nó.

- [ ] **Step 3:** Trong `claude-tab.js` thêm thẻ NAV và luồng tạo:

```js
  // ── Tạo bộ NAV: xem trước 3 tên + bin + khung → bấm Tạo ──
  var RATIOS = [['1080x1920', '9:16'], ['1080x1350', '4:5'], ['1080x1080', '1:1'], ['1920x1080', '16:9']];

  async function fetchSetNames(set) {
    var c = window.AutoGetSetConfig();
    var res = await fetch(BRIDGE_URL + '/autoset/names', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: c.config, setNumber: set, seqOnly: true })
    });
    var j = await res.json();
    if (!j.ok) throw new Error(j.error || 'bridge lỗi');
    return { jobs: j.jobs, ratio: c.ratio };
  }

  async function existingNames() {
    var proj = await getActiveProject();
    var root = typeof proj.getRootItem === 'function' ? proj.getRootItem() : proj.rootItem;
    if (root && typeof root.then === 'function') root = await root;
    var all = await sacCollectBinItems(root);
    var set = {};
    all.forEach(function (it) { set[it.name] = it; });
    return set;
  }

  window.ClaudeRenderSetCard = async function (host, set) {
    var card = document.createElement('div');
    card.className = 'cl-card';
    card.innerHTML = '<div class="cl-card-title">Tạo bộ NAV ' + set + 'x</div><div class="cl-card-body">Đang dựng tên…</div>';
    host.appendChild(card);
    var body = card.querySelector('.cl-card-body');
    try {
      var r = await fetchSetNames(set), have = await existingNames();
      var lines = r.jobs.map(function (j) { return (have[j.seqName] ? '⚠ đã có — bỏ qua: ' : '• ') + j.seqName; });
      body.textContent = lines.join('\n') + '\n→ Bin: ' + r.jobs[0].seqBin;
      var opts = RATIOS.map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === r.ratio ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('');
      var act = document.createElement('div');
      act.className = 'cl-card-actions';
      act.innerHTML = '<select class="cl-ratio">' + opts + '</select><button class="cl-btn cl-btn--primary">Tạo</button>';
      card.appendChild(act);
      var todo = r.jobs.filter(function (j) { return !have[j.seqName]; });
      var btn = act.querySelector('button');
      if (!todo.length) { btn.disabled = true; btn.textContent = 'Đủ cả 3 rồi'; return; }
      btn.addEventListener('click', async function () {
        btn.disabled = true;
        var ratio = act.querySelector('select').value;
        var res = await window.ClaudeCreateSetJobs(todo, ratio, function (msg) { btn.textContent = msg; });
        act.textContent = res.ok ? '✓ ' + res.data.message : '✗ ' + res.error;
      });
    } catch (e) { body.textContent = '✗ ' + e.message; }
  };

  // Gọi từ action create_set (đi qua thẻ) và từ test eval. Tuần tự, mỗi sequence một lượt.
  window.ClaudeCreateSetJobs = async function (jobs, ratio, onStep) {
    var project = await getActiveProject(), done = [], failed = [];
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      if (onStep) onStep('Đang tạo ' + (i + 1) + '/' + jobs.length + '…');
      try {
        await ppCreateEmptySequence(project, j.seqName, ratio);
        var have = await existingNames();
        var hit = have[j.seqName];
        if (!hit) throw new Error('tạo xong nhưng không thấy trong project');
        var mv = await ppMoveToBin(hit.item, project, j.seqBin);   // thứ tự (item, proj, bin)
        if (!mv.ok) throw new Error('chuyển bin: ' + mv.error);
        done.push(j.seqName);
      } catch (e) { failed.push(j.seqName + ' — ' + e.message); }
    }
    if (failed.length) return { ok: false, error: 'Tạo được ' + done.length + '/' + jobs.length + '. Lỗi: ' + failed.join('; ') };
    return { ok: true, data: { message: 'Đã tạo ' + done.length + ' sequence trong ' + jobs[0].seqBin } };
  };

  // Action create_set đi qua mode 'confirm' → thẻ ở trên. Hàm này cho trường hợp gọi thẳng.
  window.ClaudeCreateSet = async function (set) {
    var r = await fetchSetNames(set);
    return window.ClaudeCreateSetJobs(r.jobs, r.ratio);
  };
```

- [ ] **Step 4:** Kiểm cú pháp `main.js` + `claude-tab.js`.
- [ ] **Step 5:** Test live (`bash dev.sh`), trên một project thử:
  1. Gõ "tạo bộ NAV 40x". Thẻ phải hiện 3 tên `… vid40.0/1/2 [c.CO] [Editor]` và `→ Bin: Sequence / FB / 40x`.
  2. Bấm Tạo. Project panel phải có `Sequence/FB/40x` chứa đúng 3 sequence, khung đúng ratio đã chọn (Sequence Settings).
  3. Gõ lại lệnh. Thẻ phải báo "⚠ đã có — bỏ qua" cả 3 và nút "Đủ cả 3 rồi".
  4. Chạy lại trang Auto của Autocut với chế độ sequence mới để chắc `sacRunAutoCut` vẫn tạo sequence đúng sau khi tách hàm.
- [ ] **Step 6:** Commit `feat(claude): tạo bộ NAV — 3 sequence rỗng tên chuẩn vào bin Sequence/FB/{set}x`.

---

## Phase D — Soát lỗi trước khi xuất

### Task 9: Dò API cần cho QC (trước khi code)

**Files:** `/private/tmp/…/scratchpad/qc-probe.js` (không commit)

- [ ] **Step 1:** Viết file eval dò 3 API trên sequence đang mở: `TrackItem.isDisabled`, `ClipProjectItem.isOffline`, `Sequence.setPlayerPosition`:

```js
(async () => {
  const ppro = require('premierepro');
  const proj = await ppro.Project.getActiveProject();
  const seq = await proj.getActiveSequence();
  const vt = await seq.getVideoTrack(0);
  const items = await vt.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  const it = items[0];
  const pi = await it.getProjectItem();
  const cpi = ppro.ClipProjectItem.cast(pi);
  return {
    isDisabled: typeof it.isDisabled, disabledVal: typeof it.isDisabled === 'function' ? await it.isDisabled() : null,
    isOffline: typeof cpi.isOffline, offlineVal: typeof cpi.isOffline === 'function' ? await cpi.isOffline() : null,
    setPlayerPosition: typeof seq.setPlayerPosition,
    tickFromSec: typeof (ppro.TickTime && ppro.TickTime.createWithSeconds)
  };
})()
```

- [ ] **Step 2:** `bash dev.sh eval <file>`. Ghi kết quả vào đầu `claude-tab.js` (comment "ĐÃ XÁC MINH 2026-…"). API nào **không có** thì bỏ phép kiểm tương ứng ở Task 11 (snapshot để `offline: false`, `disabled: false`) và ghi trong CHANGELOG là chưa hỗ trợ.

### Task 10: `qc-core.js`, các phép kiểm thuần

**Files:**
- Create: `plugin/qc-core.js`
- Test: `bridge/test/qc-core.test.js`

Snapshot vào: `{ seqName, durationSec, fps, clips: [{ trackType:'video'|'audio', trackIndex, name, startSec, endSec, disabled, offline }] }`.
Kết quả: mảng `{ kind, severity:'error'|'warn'|'info', at, len?, msg }` sắp theo `at`, cùng `at` thì error đứng trước.

- [ ] **Step 1: Viết test fail**

```js
// bridge/test/qc-core.test.js — soát lỗi timeline trước khi xuất (tab Claude).
const test = require("node:test");
const assert = require("node:assert");
const QCC = require("../../plugin/qc-core.js");

const v = (s, e, extra) => Object.assign({ trackType: "video", trackIndex: 0, name: "c", startSec: s, endSec: e, disabled: false, offline: false }, extra || {});
const a = (s, e, extra) => Object.assign({ trackType: "audio", trackIndex: 0, name: "vo", startSec: s, endSec: e, disabled: false, offline: false }, extra || {});
const snap = (clips, dur) => ({ seqName: "X vid40.0 [c.a] [b]", durationSec: dur, fps: 30, clips });
const kinds = r => r.map(f => f.kind);

test("timeline sạch → không lỗi", () => {
  assert.deepStrictEqual(QCC.run(snap([v(0, 5), v(5, 10), a(0, 10)], 10)), []);
});

test("khoảng đen giữa 2 clip, đầu timeline; clip ở track trên che được", () => {
  const r = QCC.run(snap([v(0.5, 3), v(4, 10), a(0, 10)], 10));
  assert.deepStrictEqual(kinds(r), ["gap", "gap"]);
  assert.strictEqual(r[0].at, 0);
  assert.ok(Math.abs(r[1].at - 3) < 1e-6 && Math.abs(r[1].len - 1) < 1e-6);
  assert.deepStrictEqual(QCC.run(snap([v(0, 3), v(4, 10), v(2, 5, { trackIndex: 1 }), a(0, 10)], 10)), []);
});

test("khe nhỏ hơn 1 frame bỏ qua", () => {
  assert.deepStrictEqual(QCC.run(snap([v(0, 5), v(5.01, 10), a(0, 10)], 10)), []);
});

test("clip disabled không tính là che hình", () => {
  assert.deepStrictEqual(kinds(QCC.run(snap([v(0, 5), v(5, 10, { disabled: true }), a(0, 10)], 10))), ["gap"]);
});

test("media offline → error tại vị trí clip", () => {
  const r = QCC.run(snap([v(0, 5), v(5, 10, { offline: true, name: "Senyue 41" }), a(0, 10)], 10));
  assert.deepStrictEqual(kinds(r), ["offline"]);
  assert.strictEqual(r[0].severity, "error");
  assert.match(r[0].msg, /Senyue 41/);
});

test("flash frame: clip video < 3 frame → warn", () => {
  const r = QCC.run(snap([v(0, 5), v(5, 5.05), v(5.05, 10), a(0, 10)], 10));
  assert.deepStrictEqual(kinds(r), ["flash"]);
});

test("không có tiếng → error; voice hết sớm > 0.5s → warn", () => {
  assert.deepStrictEqual(kinds(QCC.run(snap([v(0, 10)], 10))), ["no_audio"]);
  const r = QCC.run(snap([v(0, 10), a(0, 8)], 10));
  assert.deepStrictEqual(kinds(r), ["audio_short"]);
  assert.strictEqual(r[0].at, 8);
});

test("tên sequence không theo vid{set}.{idx} → info", () => {
  const s = snap([v(0, 10), a(0, 10)], 10); s.seqName = "Sequence 01";
  const r = QCC.run(s);
  assert.deepStrictEqual(kinds(r), ["name"]);
  assert.strictEqual(r[0].severity, "info");
});

test("thứ tự: theo thời gian, cùng thời điểm error trước warn", () => {
  // V1: flash 0–0.05 (warn); V2: clip offline phủ cả timeline (error) — cùng at=0.
  const r = QCC.run(snap([v(0, 0.05), v(0, 10, { trackIndex: 1, offline: true }), a(0, 10)], 10));
  assert.deepStrictEqual(r.map(f => f.kind), ["offline", "flash"]);
});
```

- [ ] **Step 2:** `node bridge/test/qc-core.test.js`. Kỳ vọng: FAIL.
- [ ] **Step 3: Viết code**

```js
// plugin/qc-core.js — soát lỗi timeline trước khi xuất (global QCC). Thuần: nhận
// snapshot, trả danh sách lỗi. Thu snapshot từ Premiere ở claude-tab.js.

var QCC = (function () {
  var SEV = { error: 0, warn: 1, info: 2 };

  function fmt(sec) {
    var m = Math.floor(sec / 60), s = sec - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  // Khoảng [0, dur] không có clip video bật nào che → khoảng đen.
  function gaps(clips, dur, frame) {
    var iv = clips.filter(function (c) { return c.trackType === 'video' && !c.disabled; })
      .map(function (c) { return [c.startSec, c.endSec]; })
      .sort(function (p, q) { return p[0] - q[0]; });
    var out = [], cur = 0;
    iv.forEach(function (p) {
      if (p[0] - cur >= frame) out.push({ at: cur, len: p[0] - cur });
      if (p[1] > cur) cur = p[1];
    });
    if (dur - cur >= frame) out.push({ at: cur, len: dur - cur });
    return out;
  }

  function run(snap) {
    var fps = snap.fps || 30, frame = 1 / fps, dur = snap.durationSec || 0;
    var clips = snap.clips || [], out = [];

    gaps(clips, dur, frame).forEach(function (g) {
      out.push({ kind: 'gap', severity: 'error', at: g.at, len: g.len, msg: 'Khoảng đen ' + g.len.toFixed(2) + 's tại ' + fmt(g.at) });
    });
    clips.forEach(function (c) {
      if (c.disabled) return;
      if (c.offline) out.push({ kind: 'offline', severity: 'error', at: c.startSec, msg: 'Media offline: ' + c.name + ' (' + c.trackType + ' ' + (c.trackIndex + 1) + ')' });
      else if (c.trackType === 'video' && (c.endSec - c.startSec) < 3 * frame - 1e-6)
        out.push({ kind: 'flash', severity: 'warn', at: c.startSec, msg: 'Flash frame: ' + c.name + ' chỉ ' + Math.round((c.endSec - c.startSec) * fps) + ' frame' });
    });

    var audio = clips.filter(function (c) { return c.trackType === 'audio' && !c.disabled; });
    if (!audio.length) out.push({ kind: 'no_audio', severity: 'error', at: 0, msg: 'Timeline không có tiếng (thiếu voice?)' });
    else {
      var aEnd = Math.max.apply(null, audio.map(function (c) { return c.endSec; }));
      if (dur - aEnd > 0.5) out.push({ kind: 'audio_short', severity: 'warn', at: aEnd, msg: 'Tiếng hết sớm ' + (dur - aEnd).toFixed(1) + 's trước cuối video' });
    }

    if (!/vid\s*\d+\.\d+/i.test(snap.seqName || ''))
      out.push({ kind: 'name', severity: 'info', at: 0, msg: 'Tên sequence không theo mẫu vid{bộ}.{số} — Voice Gen/RAW sẽ không tự nhận bộ' });

    return out.sort(function (p, q) { return (p.at - q.at) || (SEV[p.severity] - SEV[q.severity]); });
  }

  return { run: run, fmt: fmt };
})();

(function (root) {
  if (root) { root.QCC = QCC; }
  if (typeof module !== "undefined" && module.exports) { module.exports = QCC; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
```

- [ ] **Step 4:** `node bridge/test/qc-core.test.js`. Kỳ vọng: PASS. (Clip offline không báo thêm flash vì dùng `else if`: một clip chỉ báo lỗi nặng nhất.)
- [ ] **Step 5:** Commit `feat(claude): qc-core — khoảng đen, offline, flash frame, thiếu tiếng, tên sequence`.

### Task 11: Thu snapshot + thẻ QC + nhờ Claude nhận xét

**Files:**
- Modify: `plugin/claude-tab.js`
- Modify: `plugin/main.js` trong closure Tạo Sub (cạnh `window.SubtextSetScript`, dòng 13144): xuất getter script

- [ ] **Step 1:** Xuất script của tab Tạo Sub, đặt ngay trên `window.SubtextSetScript = function` (ô script là `<textarea id="stScript">`, index.html:1542):

```js
  window.SubtextGetScript = function () {
    var el = document.getElementById('stScript');
    return el ? String(el.value || '') : '';
  };
```

- [ ] **Step 2:** Trong `claude-tab.js` thu snapshot. Dùng các API đã xác minh ở Task 9; API nào không có thì trả false:

```js
  // ── Soát lỗi: snapshot timeline → QCC.run → thẻ kết quả ──
  async function qcSnapshot() {
    var info = await ppGetTimelineInfo();
    if (!info.ok) throw new Error('Không có sequence đang mở');
    var seq = await getActiveSequence(), d = info.data, clips = [];
    var kinds = [['video', d.videoTrackCount, 'getVideoTrack'], ['audio', d.audioTrackCount, 'getAudioTrack']];
    for (var k = 0; k < kinds.length; k++) {
      for (var t = 0; t < kinds[k][1]; t++) {
        var track = await seq[kinds[k][2]](t);
        var items = await getClipItems(track);
        for (var i = 0; i < items.length; i++) {
          var tmp = [];
          await pushClip(tmp, items[i], t, kinds[k][0], i);
          var c = tmp[0];
          c.disabled = false; c.offline = false;
          try { if (typeof items[i].isDisabled === 'function') c.disabled = !!(await items[i].isDisabled()); } catch (e) {}
          try {
            var pi = await items[i].getProjectItem();
            var cpi = ppro.ClipProjectItem.cast(pi);
            if (cpi && typeof cpi.isOffline === 'function') c.offline = !!(await cpi.isOffline());
          } catch (e) {}
          clips.push(c);
        }
      }
    }
    var fps = 30;
    try { var tb = await seq.getTimebase(); if (tb) fps = Math.round(254016000000 / Number(tb)); } catch (e) {}
    return { seqName: d.sequenceName, durationSec: d.durationSec, fps: fps, clips: clips };
  }

  async function jumpTo(sec) {
    try {
      var seq = await getActiveSequence();
      await seq.setPlayerPosition(ppro.TickTime.createWithSeconds(sec));
    } catch (e) { console.warn('[qc] jump failed:', e.message); }
  }

  window.ClaudeRunQc = async function () {
    window.tabOpen('claude');
    var host = document.getElementById('chat-area');
    document.getElementById('empty-state').style.display = 'none';
    var card = document.createElement('div');
    card.className = 'cl-card';
    card.innerHTML = '<div class="cl-card-title">Soát lỗi…</div>';
    host.appendChild(card);
    try {
      var snap = await qcSnapshot(), found = QCC.run(snap);
      var title = card.querySelector('.cl-card-title');
      title.textContent = (found.length ? '⚠ ' + found.length + ' điểm cần xem' : '✓ Không thấy lỗi') + ' — ' + snap.seqName;
      found.forEach(function (f) {
        var row = document.createElement('div');
        row.className = 'cl-qc-row cl-qc-' + f.severity;
        row.textContent = QCC.fmt(f.at) + '  ' + f.msg;
        row.addEventListener('click', function () { jumpTo(f.at); });
        card.appendChild(row);
      });
      var act = document.createElement('div');
      act.className = 'cl-card-actions';
      act.innerHTML = '<button class="cl-btn">✦ Nhờ Claude nhận xét + soát script</button>';
      act.querySelector('button').addEventListener('click', function () {
        var script = typeof window.SubtextGetScript === 'function' ? window.SubtextGetScript() : '';
        var inp = document.getElementById('message-input');
        inp.value = 'Nhận xét kết quả soát lỗi ' + snap.seqName + ':\n' + JSON.stringify(found)
          + (script ? '\n\nScript:\n' + script : '\n\n(không có script trong tab Tạo Sub)');
        sendMessage();
      });
      card.appendChild(act);
      return { ok: true, data: { message: 'Soát xong: ' + found.length + ' điểm' } };
    } catch (e) {
      card.querySelector('.cl-card-title').textContent = '✗ ' + e.message;
      return { ok: false, error: e.message };
    }
  };
```

CSS:

```css
.cl-qc-row { font-size: 11px; padding: 3px 4px; border-radius: 4px; cursor: pointer; font-family: Menlo, monospace; }
.cl-qc-row:hover { background: rgba(255,255,255,0.05); }
.cl-qc-error { color: var(--error); }
.cl-qc-warn  { color: #e0b050; }
.cl-qc-info  { color: var(--text-dim); }
```

- [ ] **Step 3:** Kiểm cú pháp `main.js` + `claude-tab.js`.
- [ ] **Step 4:** Test live trên sequence thử, cố tình tạo lỗi:
  1. Kéo hở một khe 1s giữa 2 clip V1.
  2. Tắt (disable) một clip.
  3. Cắt một clip còn 2 frame.
  4. Đổi tên file gốc của một clip cho offline.
  5. Kéo voice ngắn hơn video.

  Bấm "✓ Soát lỗi": phải ra đúng 5 dòng, bấm dòng nào playhead nhảy tới đó. Gõ "soát lỗi giúp tôi" cũng ra cùng thẻ (qua `qc_run`). Bấm "Nhờ Claude nhận xét": Claude trả lời tiếng Việt, ưu tiên lỗi, có soát script nếu tab Tạo Sub có script.
- [ ] **Step 5:** Commit `feat(claude): soát lỗi trước khi xuất — thẻ kết quả, bấm nhảy playhead, nhờ Claude nhận xét script`.

---

## Phase E — Hoàn tất

### Task 12: Version, CHANGELOG, CLAUDE.md

**Files:** `plugin/main.js:949` (`PLUGIN_VERSION`), `bridge/server.js:3018` (`BRIDGE_VERSION`), `CHANGELOG.md`, `CLAUDE.md` (mục Tổng quan + bảng endpoint `/autoset/names`)

- [ ] **Step 1:** Lên minor: plugin `v5.17.0-beta.1` (manifest `5.17.0`), bridge `1.24.0-beta.1` (QC đợt 2 đã dùng 5.16.0 / 1.23.0), ghi chú phiên bản bằng tiếng Việt, cho người dùng đọc: tab Clawd, tạo bộ NAV, soát lỗi, "CẦN BRIDGE ≥1.24.0" (vì prompt + `seqOnly`).
- [ ] **Step 2:** CHANGELOG thêm mục 5.17.0. CLAUDE.md: thêm "Claude (tab Clawd)" vào Tổng quan; bảng endpoint ghi `/autoset/names` nhận `seqOnly`.
- [ ] **Step 3:** `cd bridge && npm test` → `ALL TESTS PASSED`; `bash dev.sh` chạy lại toàn bộ bước kiểm live của Task 3/6/8/11.
- [ ] **Step 4:** Commit `chore(version): v5.17.0-beta.1 — tab Claude (Clawd): điều phối, tạo bộ NAV, soát lỗi`. **Không push, không ship.** Báo user review bản DEV.

---

## Backlog (plan sau)

- **Resize có AI hỗ trợ:** chờ user gửi luồng làm việc, rồi viết plan riêng (có thể thêm action `resize_set {set, ratios}`, nối với `plugin/resize.js`).
- Action chạy thẳng: `subtext_run`, `rawcut_export {seqs}`, `watch_scan`.
- QC mở rộng: đọc text MOGRT/caption để soát chính tả trên hình (cần dò API trước), giới hạn thời lượng theo nền tảng.
