# Spec: Toggle "Auto-save SRT" trong VO Setting

> Ngày: 2026-09-09 · Branch: `feat/srt-autosave-toggle`
> Chỉ sửa **plugin** (index.html + main.js). **Không đụng bridge.**

## Vấn đề

Ở bản 5.6.1, sau khi tạo sub xong, file `.srt` được **tự động lưu** cạnh file VO (thư mục lấy
từ media path clip đang chọn), tên đặt theo version của sequence — xem `stResolveOutputPath()`
trong `plugin/main.js`. Người dùng không được chọn nơi lưu.

Cần một option **bật/tắt auto-save** trong VO Setting. Khi **tắt**, sau khi tạo xong plugin
mở hộp thoại để người dùng **tự chọn nơi lưu** thay vì tự tìm.

## Quyết định thiết kế

- **Kiểu chọn khi tắt:** hộp thoại **Save file** (`getFileForSaving`) — chọn được cả thư mục
  lẫn tên, gợi ý sẵn tên theo version sequence (vd `v21.0.srt`).
- **Mặc định:** **BẬT** auto-save (giữ nguyên hành vi 5.6.1) cho lần đầu chưa từng đặt.
- **Ghi nhớ:** trạng thái toggle được persist qua `localStorage`, áp dụng cho các lần sau.
- **Không đổi bridge:** bridge vẫn nhận `outputPath` và `fs.writeFileSync` như cũ.

## Thay đổi chi tiết

### 1. UI — `plugin/index.html`

Trong panel settings `data-stab="voicegen"`, khu **Output Folder** (quanh dòng 294–306),
thêm một hàng toggle dùng đúng mẫu switch có sẵn (`vg-toggleRow` + `vg-switch`, tham chiếu
`vgLangOverride` ở dòng 256–261):

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

### 2. Persist + wiring — `plugin/main.js`

- Key localStorage: **`st_srt_autosave`** — `'1'` (bật) / `'0'` (tắt).
- Helper đọc trạng thái (mặc định BẬT khi chưa đặt):
  ```js
  function stSrtAutoSaveOn() {
    var v = localStorage.getItem('st_srt_autosave');
    return v == null ? true : v === '1';
  }
  ```
- Khi khởi tạo UI (nơi wiring các control voicegen settings): set `checkbox.checked` theo
  `stSrtAutoSaveOn()`; thêm listener `change` ghi `'1'`/`'0'` xuống localStorage.

### 3. Logic lưu — sửa `stResolveOutputPath(forcePrompt)` trong `plugin/main.js`

Thêm nhánh **đầu hàm**, trước logic auto hiện tại:

```js
async function stResolveOutputPath(forcePrompt) {
  var base = await stOutputBasename();

  // Auto-save TẮT → luôn mở hộp thoại Save cho user chọn thư mục + tên.
  if (!stSrtAutoSaveOn()) {
    try {
      var lfs = require('uxp').storage.localFileSystem;
      var file = await lfs.getFileForSaving(base + '.srt');
      if (!file) return null;                    // user Cancel → huỷ
      var p = file.nativePath || file.path || '';
      if (p) {
        localStorage.setItem('vg_last_save_folder',
          p.replace(/[\/\\][^\/\\]*$/, ''));      // nhớ thư mục cho lần sau
        return p;
      }
    } catch (e) { throw new Error('Không chọn được nơi lưu: ' + e.message); }
    return null;
  }

  // Auto-save BẬT → giữ NGUYÊN logic cũ (VO folder → last folder → getFolder).
  ...
}
```

- Khi BẬT: hành vi + nhánh retry `forcePrompt` (ghi hỏng do NAS chỉ-đọc) **không đổi**.
- Khi TẮT: user Cancel → `null` → `stFinalize()` báo "Đã huỷ — chưa chọn thư mục lưu."
  (đã có sẵn). Nếu bridge báo ghi hỏng, retry gọi lại `stResolveOutputPath(true)` → với
  auto-save tắt vẫn mở lại Save dialog (nhánh trên bỏ qua `forcePrompt`), đúng ý.

## Phạm vi & không làm

- Chỉ 2 file: `plugin/index.html` (~10 dòng), `plugin/main.js` (1 helper + sửa 1 hàm + wiring).
- Bump `PLUGIN_VERSION` + manifest + CHANGELOG.
- Không đổi bridge, không đổi cách đặt tên file (`stOutputBasename` giữ nguyên, dùng làm
  suggested name của Save dialog).

## Kiểm thử (thủ công trong Premiere)

1. **Mặc định (chưa đặt key):** tạo sub → `.srt` lưu cạnh VO như 5.6.1. Checkbox hiển thị bật.
2. **Tắt → tạo sub:** hiện hộp thoại Save, gợi ý tên `vNN.N.srt`, đổi thư mục + tên rồi lưu →
   file nằm đúng chỗ đã chọn, import vào project OK.
3. **Tắt → Cancel dialog:** báo "Đã huỷ", không tạo file.
4. **Persist:** tắt toggle, đóng/mở lại settings (hoặc reload plugin) → toggle vẫn tắt.
5. **Bật lại:** quay về hành vi tự lưu cạnh VO.
