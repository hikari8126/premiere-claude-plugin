# Spec: Sắp xếp list voice clone (Settings ▸ Voice Gen)

> Ngày: 2026-09-24 · Branch: `feat/voicegen-sort-voices`
> Chỉ sửa **plugin** (index.html + main.js + styles.css). **Không đụng bridge.**

## Mục tiêu

Thêm tuỳ chọn **sắp xếp** danh sách voice clone trong Settings ▸ Voice Gen. Chức năng xoá
(checkbox + "Xoá đã chọn") **đã có sẵn, không đụng**.

## Kiểu sắp xếp

`<select>` với 4 lựa chọn:
- `newest` — **Mới nhất** (thời gian tạo giảm dần) — **mặc định**
- `oldest` — Cũ nhất (thời gian tạo tăng dần)
- `name_az` — Tên A→Z
- `name_za` — Tên Z→A

## Dữ liệu

Hiện `elvFetchState` (main.js ~10719) map mỗi voice thành `{id, name, category}` và **bỏ mất
thời gian tạo**. Sửa map để giữ thêm:
- `created`: `typeof v.created_at_unix === 'number' ? v.created_at_unix : null`
  (`created_at_unix` là field ElevenLabs trả trong `/v1/voices`; `null` nếu không có).

## Logic sắp xếp

- **`elvSortVoices()`** (trong main.js) = `elvVoices.sort(elvSortComparator(elvSortMode()))`.
  `elvSortComparator(mode)` là **hàm thuần** (tách ra `plugin/elv-sort.js`, test bằng node) trả
  về một hàm so sánh `(a,b)=>number` cho `Array.sort`. Quy tắc theo `mode`:
  - `newest`: theo `created` giảm dần; voice có `created == null` xếp **cuối**.
  - `oldest`: theo `created` tăng dần; `created == null` xếp **cuối**.
  - `name_az`: `a.name.localeCompare(b.name)` (không phân biệt hoa/thường, dùng
    `localeCompare` với `{sensitivity:'base'}`).
  - `name_za`: ngược `name_az`.
  - Sort phải **ổn định về mặt kết quả**: dùng so sánh phụ theo `name` khi `created` bằng nhau
    (newest/oldest) để thứ tự không nhảy lung tung.
- **`elvSortMode()`** — đọc `localStorage['elv_sort_mode']`; giá trị hợp lệ ∈ 4 mã trên;
  không có/không hợp lệ → `'newest'`.
- `elvRenderList()` (main.js ~10753) gọi `elvSortVoices()` **ở đầu**, trước khi dựng rows →
  list luôn hiển thị đúng thứ tự. Sau khi dựng vẫn áp filter tìm kiếm như hiện tại
  (`elvFilterRows` — giữ nguyên).

## UI (index.html + styles.css)

- Thêm `<select id="elvSortSel" class="elv-sortSel">` **ngay sau** ô `#elvVoiceSearch`
  (index.html ~dòng 227), trước `#elvVoiceList`:
  ```html
  <select id="elvSortSel" class="elv-sortSel">
    <option value="newest">Mới nhất</option>
    <option value="oldest">Cũ nhất</option>
    <option value="name_az">Tên A→Z</option>
    <option value="name_za">Tên Z→A</option>
  </select>
  ```
- CSS `.elv-sortSel`: nhỏ gọn, full-width, cùng tông với `.vg-settingInput`/`.vg-select`
  sẵn có (nền tối, viền `--border`, bo góc, font ~11px, margin-top 4px). Không dùng
  `position:fixed`/`z-index`/`display:grid` (ràng buộc UXP).

## Wiring & persist

- Trong `elvWire()` (nơi gắn event cho `elvRefresh`/`elvVoiceSearch`, main.js ~10810):
  - Khi khởi tạo: `var ss = $('elvSortSel'); if (ss) ss.value = elvSortMode();`
  - `ss.addEventListener('change', function () { localStorage.setItem('elv_sort_mode', ss.value); elvRenderList(); });`
- Key `localStorage`: **`elv_sort_mode`**, mặc định `'newest'`.

## Không làm (YAGNI)

- Không đụng logic xoá, search, slot-count.
- Không gọi thêm API (dùng `created_at_unix` có sẵn trong response `/v1/voices`).
- Không sort các voice mặc định/premade (list này vốn chỉ có clone của user).

## Rủi ro / kiểm thử

**Rủi ro:** nếu `/v1/voices` **không** trả `created_at_unix` cho tài khoản đang dùng →
`created` toàn `null` → `newest`/`oldest` giữ nguyên thứ tự API (không sai, chỉ không sắp theo
giờ); sort theo Tên vẫn chạy. Cần kiểm bằng test thủ công.

**Kiểm thử tự động (node, thuần):** tách hàm so sánh thuần `elvSortComparator(mode)` (không
đụng DOM) ra `plugin/elv-sort.js` (expose global + `module.exports`), test bằng node:
- `newest`: `[{created:100},{created:300},{created:null},{created:200}]` → thứ tự created
  300,200,100 rồi null cuối.
- `oldest`: đảo lại, null vẫn cuối.
- `name_az`/`name_za`: `['Beta','alpha','Gamma']` → a,B,G và ngược lại (không phân biệt hoa/thường).
- created bằng nhau → tie-break theo name ổn định.

**Kiểm thử thủ công (Premiere, UXP không headless):**
- Mở Settings ▸ Voice Gen → có `<select>` sort dưới ô tìm; mặc định "Mới nhất".
- Đổi sang Cũ nhất / Tên A→Z / Z→A → list đảo thứ tự đúng.
- Đóng/mở lại settings (hoặc reload) → select nhớ lựa chọn.
- Xoá 1 voice → list vẫn giữ đúng sort. Search vẫn lọc đúng trên thứ tự đã sort.

## Version

- Bump `PLUGIN_VERSION` (main.js) + `manifest.json` + entry `CHANGELOG.md` lên **5.9.1**.
  (Đang có nhiều branch mở song song — nếu số 5.9.1 bị chiếm lúc merge thì dùng số minor kế
  tiếp còn trống; hoà giải version ở thời điểm merge như các branch trước.) Không cần bridge mới.
