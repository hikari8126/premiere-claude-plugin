# Spec: History voice đã dùng gần đây (Voice Gen)

> Ngày: 2026-09-17 · Branch: `feat/voice-history`
> Chỉ sửa **plugin** (index.html + main.js + styles.css). **Không đụng bridge.**

## Vấn đề

Voice Gen không nhớ những giọng đã dùng. Mỗi lần muốn quay lại một giọng vừa dùng hôm
trước, người dùng phải mở dropdown `vgVoiceDropPanel` và lục trong danh sách hàng chục
voice từ tài khoản ElevenLabs — kể cả khi thực tế họ chỉ xoay vòng giữa 2–3 giọng quen.

Cần một mục **"Gần đây"** nhỏ trên sidebar phải: liệt kê các lần gen gần nhất kèm đoạn
script để nhận ra "lần đó là bài nào", bấm một phát là đổi lại voice.

## Quyết định thiết kế

- **Phạm vi lưu:** một danh sách chung trên máy. Mỗi người cài plugin trên máy riêng nên
  `localStorage` đã tách sẵn theo người.
- **Lọc theo voice dùng được với profile đang active** (sửa ngày 2026-09-17, v5.7.1 — bản
  đầu không lọc gì cả và đó là lỗi). Voice custom/clone gắn chặt với API key của profile
  tạo ra nó, còn 25 voice mặc định thì key nào cũng dùng được. Nên mỗi mục lưu thêm
  `profileId`, và khi render chỉ hiện mục mà voice của nó có trong `VG_VOICES_DATA` hiện
  tại, hoặc do chính profile đang active tạo ra (cần vế sau vì key chỉ có quyền TTS sẽ
  không đọc được danh sách voice custom).
- **Cap 20 tính cho TỪNG profile**, không phải cả list: dùng chung hạn mức thì một profile
  gen nhiều sẽ đẩy bay sạch history của profile khác.
- **Thời điểm ghi:** chỉ khi **generate TTS thành công**. Chọn voice trong dropdown không
  ghi — nếu ghi thì list đầy rác bởi những lần bấm thử rồi đổi ý.
- **Mode:** chỉ **TTS**. SFX/Music không có voice.
- **Chỉ single-speaker.** Multi-speaker (`generateMultiSpeaker`) không ghi: một lần gen sẽ
  đẩy 3–4 mục cùng lúc, lấp sạch 3 slot hiển thị, và script từng speaker không phải thứ
  người dùng cần nhớ lại.
- **Click = đổi voice.** Script đang gõ không bao giờ bị đụng tới trừ khi bấm nút ↺ riêng.
- **Chỉ `localStorage`, không backup vào UXP data folder.** Backup async ở
  `loadSettingsFromFile` tồn tại để không mất API key — history là dữ liệu tiện lợi, mất
  thì chỉ cần gen lại một lần. Ghi sync mỗi lần gen, không có đường async nào.
- **Hiển thị:** section riêng ngay dưới section Profile trên sidebar phải, mặc định 3 mục,
  nút "Xem thêm" giãn tại chỗ tối đa 20 mục (không làm modal — panel đã nhiều lớp, và UXP
  không có `position:fixed` nên modal phải tự tính vị trí như `repositionVoiceDrop`).

## Thay đổi chi tiết

### 1. Dữ liệu — `plugin/main.js`

Key `localStorage`: **`vg_voice_history`**, chứa JSON array, mới nhất đứng đầu, cap **20**.

```js
{ voiceId: '21m00Tcm4TlvDq8ikWAM',
  voiceLabel: 'Rachel',
  script: 'Chào mừng các bạn đến với…',   // cắt còn 200 ký tự
  ts: 1789000000000,
  profileId: 'p_default' }                // profile đang active lúc gen
```

`voiceLabel` được lưu kèm chứ không chỉ `voiceId`: danh sách voice phụ thuộc API key, nên
khi đổi profile hoặc key hết hạn thì `VG_VOICES_DATA` không còn voice đó — vẫn phải hiện
được tên người đọc hiểu được thay vì một chuỗi id.

Ba hàm mới, đặt cạnh `vgRememberSavedName` (`plugin/main.js:8462`) để các helper "recents"
nằm chung một chỗ:

```js
var VG_HIST_KEY = 'vg_voice_history';
var VG_HIST_CAP = 20;
var VG_HIST_SNIP = 200;

function vgHistGet() {
  try {
    var a = JSON.parse(localStorage.getItem(VG_HIST_KEY) || '[]');
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}

function vgHistPush(voiceId, voiceLabel, script) {
  if (!voiceId) return;
  var snip = String(script || '').trim().slice(0, VG_HIST_SNIP);
  var list = vgHistGet().filter(function (h) {
    return !(h.voiceId === voiceId && h.script === snip);   // trùng cả hai → gộp lên đầu
  });
  list.unshift({ voiceId: voiceId, voiceLabel: voiceLabel || voiceId, script: snip, ts: Date.now() });
  if (list.length > VG_HIST_CAP) list = list.slice(0, VG_HIST_CAP);
  try { localStorage.setItem(VG_HIST_KEY, JSON.stringify(list)); } catch (e) {}
  vgRenderHistory();
}
```

Ghi ở nhánh thành công của `generate()` (`plugin/main.js:7997–8006`), ngay sau
`setStatus('✓ Generated …')`, và chỉ khi `currentMode === 'tts'`. `voiceId` / `text` đã có
sẵn trong scope từ nhánh dựng body (`plugin/main.js:7935–7940`); nhãn lấy bằng
`vgVoiceName(voiceId)` — **không** dùng `selectedIndex`, vì UXP không cập nhật
`selectedIndex` khi `.value` được set bằng dropdown tuỳ biến (đúng cái bẫy đã ghi chú ở
`plugin/main.js:7942`).

### 2. UI — `plugin/index.html`

Thêm ngay **sau** `.vg-profileSection` (đóng ở `plugin/index.html:796`), trước
`<div class="vg-modeContent" data-mode="tts">`:

```html
<!-- Voice đã dùng gần đây. Chỉ mode TTS — SFX/Music không có voice. -->
<div class="vg-sg vg-histSection" id="vgHistSection" hidden>
  <div class="vg-sl">Gần đây</div>
  <div id="vgHistList"></div>
  <div class="vg-histMore" id="vgHistMore" role="button" hidden></div>
</div>
```

Section nằm **ngoài** `.vg-modeContent` (giống section Profile) và được ẩn/hiện bằng JS
trong `switchMode()`, vì `.vg-modeContent` chỉ có đúng một khối `data-mode="tts"` và việc
nhét vào đó sẽ trộn history với ô chọn voice thành một nhóm.

### 3. Render — `plugin/main.js`

```js
var vgHistExpanded = false;

function vgRenderHistory() { … }
```

Dựng bằng DOM API, không `innerHTML` cho từng mục (giữ đúng lối của `renderVoiceDrop`).
Mỗi mục là một `div.vg-histItem` chứa:

- `div.vg-histName` — `h.voiceLabel`
- `div.vg-histScript` — `h.script`, một dòng, `text-overflow: ellipsis`
- `div.vg-histReload[role="button"]` — icon `rotate_left` qua `piMakeButton`/`piSetBtn`

**Không dùng attribute `title=""`** để làm tooltip cho script — UXP không hỗ trợ; đó chính
là lý do script hiện thẳng thành dòng thứ hai thay vì nấp trong tooltip.

Số mục hiện = `vgHistExpanded ? 20 : 3`. Nút "Xem thêm (n)" chỉ hiện khi
`list.length > 3`, đổi chữ thành "Thu gọn" khi đang mở. `vgHistSection.hidden` bật khi
`list.length === 0` hoặc `currentMode !== 'tts'`.

Gọi `vgRenderHistory()` ở: cuối `initVoiceGen` (lần đầu nạp), trong `switchMode()` (ẩn/hiện
theo mode), và trong `vgHistPush()`.

### 4. Tương tác

**Click vào dòng** → đổi voice, đúng cách `vgDropSelect` (`plugin/main.js:7671`) đang làm,
để các listener `change` hiện có đều chạy:

```js
vgSetVoice(h.voiceId);
var evt = document.createEvent('Event');
evt.initEvent('change', true, true);
if (els.voiceSelect) els.voiceSelect.dispatchEvent(evt);
```

Voice không còn trong `VG_VOICES_DATA` (do đổi key) vẫn click được: `vgSetVoice` chấp nhận
voiceId lạ và nhãn rơi về chính voiceId. Nếu ElevenLabs từ chối lúc gen thì lỗi hiện qua
`setStatus('✗ …')` như mọi lỗi gen khác — không cần xử lý riêng.

**Nút ↺** → nạp `h.script` vào `els.script` (`vgScript`). Nếu ô đang có nội dung **khác**
với script sắp nạp thì `confirm('Thay script đang soạn bằng script của lần gen này?')`
trước — đây là thao tác phá huỷ. Sau khi nạp phải gọi `vgAutoResize` + `vgReflowSoon`
(xem `plugin/main.js:2384–2387`) và `updateCharCount()`, nếu không thì textarea giữ nguyên
chiều cao cũ và bộ đếm ký tự hiển thị sai. `e.stopPropagation()` trong handler của nút để
không kích hoạt luôn click-đổi-voice của dòng cha.

### 5. CSS — `plugin/styles.css`

Thêm cạnh `.vg-profileSection` (`plugin/styles.css:2196–2219`), mượn nguyên bảng token và
lối trình bày của `.vg-profileChip`:

```css
.vg-histItem {
  display: flex; align-items: center; min-width: 0;
  background: rgba(255,255,255,0.05);
  border: 1px solid var(--border); border-radius: 4px;
  padding: 5px 7px; margin-bottom: 4px; cursor: pointer;
}
.vg-histItem:hover { border-color: var(--accent); }
.vg-histName   { font-size: 11px; font-weight: 600; color: var(--text); }
.vg-histScript {
  font-size: 10px; opacity: 0.6;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.vg-histMore { font-size: 10px; color: var(--accent); text-align: center; cursor: pointer; }
```

Cột trái (tên + script) dùng `flex: 1 1 0; min-width: 0` để `ellipsis` hoạt động; nút ↺
dùng `flex: 0 0 auto`. Không `display: grid`, không `position: fixed`, không `z-index` —
ba thứ UXP không hỗ trợ.

## Kiểm thử thủ công

1. Gen TTS với Rachel → section "Gần đây" hiện ra, một mục "Rachel" + đầu script.
2. Gen tiếp với Adam → Adam lên đầu, Rachel xuống dưới.
3. Gen lại Rachel với **đúng script cũ** → vẫn 2 mục, Rachel lên đầu (không sinh mục trùng).
4. Gen lại Rachel với script **khác** → thành 3 mục.
5. Gen đủ hơn 3 lần → hiện nút "Xem thêm (n)"; bấm → giãn ra; bấm lại → thu về 3.
6. Bấm vào một dòng → nhãn dropdown voice đổi theo, script đang gõ **không đổi**.
7. Bấm ↺ khi ô script đang có bài khác → hiện confirm; đồng ý → script được thay, textarea
   giãn đúng chiều cao, bộ đếm ký tự cập nhật; từ chối → không đổi gì.
8. Đổi sang mode SFX/Music → section biến mất; quay lại TTS → hiện lại.
9. Đổi profile sang key khác (voice cũ không còn trong danh sách) → mục cũ vẫn hiện tên,
   click vẫn đặt được voice.
10. Reload plugin trong UXP Developer Tool → history còn nguyên.
11. Gen multi-speaker (thêm speaker thứ 2) → history **không** thêm mục nào.
