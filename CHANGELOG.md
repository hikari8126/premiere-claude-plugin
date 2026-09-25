# CHANGELOG — premiere-claude-plugin

> Mỗi entry ghi rõ: lỗi gì, nguyên nhân, cách fix, API/pattern đã dùng.
> Dùng làm reference khi gặp lại vấn đề tương tự.

## v5.9.1 / bridge app 3.14 (server 1.18.2) — 2026-09-25

> **Cần Bridge app 3.14** — sửa nằm chủ yếu ở bridge.

### 🐛 Sửa — "Tìm trong Watch Folder" chạy mãi không xong, bridge treo
- **Triệu chứng:** thẻ đứng ở "⏳ Đang tìm trên đĩa…" rất lâu; trong lúc đó plugin có thể báo bridge offline.
- **Nguyên nhân:** `find-sources` dùng `scanFolder()` **đồng bộ** (`readdirSync` + `statSync` từng file, tuần tự từng thư mục). Google Drive lần đầu liệt kê thư mục phải hỏi server — đo thật trên ZoeShape: 130 thư mục / 550 file mất **65 giây** (lần sau có cache: 0.03s). Suốt lúc đó event loop bị chặn → `/health`, watch poll đều không trả lời. Plugin lại không có timeout.
- **Fix bridge:** bộ duyệt riêng `walkAsync()` — `fs.promises.readdir` song song 8 thư mục, **không stat** (tìm theo tên không cần size/mtime), hạn **45s** rồi trả phần đã quét kèm `timedOut`. Đo: `/health` trả lời trong 10ms giữa lúc quét. Watch engine vẫn dùng `scanFolder()` (cần size/mtime để chờ file ghi xong).
- **Fix plugin:** đếm giây lúc chờ (từ 8s ghi thêm "Google Drive lần đầu có thể mất tới ~1 phút"), timeout 90s, báo rõ khi chưa quét hết.
- Bỏ qua thêm thư mục `Adobe Premiere Pro Captured and Generated` (tên mới của thư mục captured ở Premiere 25+).

## v5.9.0 — 2026-09-24

> Gộp 3 tính năng/fix. Chỉ sửa plugin. **Không cần bridge mới.**

### 🐛 Fix DỨT ĐIỂM: ô tìm voice clone (Settings ▸ Voice Gen) nuốt chữ khi gõ
- **Nguyên nhân gốc (xác định bằng instrumentation):** `elvFilterRows()` chạy **đồng bộ trong sự kiện `input`** — mỗi phím toggle `display` ~158 dòng `.elv-list`; do `.elv-list` dùng `max-height` nên lọc bớt dòng làm container co lại → reflow layout ngoài → UXP reset selection ô về select-all / rớt keystroke. Không liên quan keyboard-focus (nên các fix trước regress).
- **Cách xử lý (4 lớp):** `.elv-list` **height cố định** (hết reflow ngoài) + **debounce 160ms** + chỉ ghi `display` khi đổi + **khôi phục caret** sau lọc.

### ✅ Autocut: nạp script từ file CSV (nút ＋CSV)
- Bổ sung cạnh cách paste Google Sheet (**giữ nguyên** `parseTSV`/paste).
- Nút **＋CSV** trong header Script → chọn `.csv` → nạp thẳng vào bảng. Map theo tên header: `text_overlay → script`, `shot_start + "-" + shot_end → time (in→out)`, `footage_name → source` (**bỏ đuôi video** .mp4/.mov/.m4v… ở cuối, giữ `[id]`).
- text_overlay nhiều dòng → gộp 1 dòng; ghi đè bảng dùng **arm 2 bước**; thiếu cột bắt buộc → báo lỗi, không nạp.
- Parser thuần `plugin/csv-parse.js` (`csvParse`+`csvRowsToSac`) + node test `bridge/test/csv-import.test.js`; tái dùng `window.AutocutPushRows()`+`expandRows`.

### ✅ Voice Gen: sắp xếp list voice clone (Settings)
- **Hàng 2 nút icon** (thay dropdown): 🕐 **thời gian tạo** + 🔤 **tên**. Bấm nút chiều khác → chuyển sang; bấm nút đang active → đảo chiều (↓ mới/A→Z ↔ ↑ cũ/Z→A). 4 chế độ: Mới nhất (mặc định) / Cũ nhất (theo `created_at_unix`) / Tên A→Z / Z→A; nhớ qua `localStorage['elv_sort_mode']`. Voice thiếu thời gian tạo → xếp cuối. Xoá/search giữ nguyên.
- Hàm so sánh thuần `plugin/elv-sort.js` (`elvSortComparator`) + node test `bridge/test/elv-sort.test.js`; thêm 2 icon SVG (`clock`, `arrow_down_a_z`).

## v5.8.2 / bridge app 3.13 (server 1.18.1) — 2026-09-24

### 🐛 Sửa — "AI không ghép được (model không trả về JSON array)"
- **Nguyên nhân:** phiên OAuth của Claude CLI hết hạn. CLI in `Failed to authenticate: OAuth session expired…` ra STDOUT rồi exit 1, `callLLM` trả nguyên câu đó như câu trả lời của model → mọi chỗ gọi chỉ thấy "không parse được".
- **Fix:** `callLLM` ném lỗi khi CLI exit ≠ 0, kèm cờ `cliAuth` nếu là lỗi đăng nhập. Áp dụng cho **mọi** tính năng AI qua CLI, không riêng ghép bin.

### ✨ Ghép bin theo tên trước, AI sau
- `suggest-bins` đoán bin theo tên thư mục trước khi hỏi model (`guessBin`): bin trùng tên thư mục (`Higg`), không có thì bin trùng thư mục cha (`Sources` → plugin tạo `Sources/Higg`). Trường hợp rõ ràng không còn phụ thuộc CLI/model.
- Model hỏng vẫn trả phần đã ghép theo tên; chỉ thư mục còn lại mới phải chọn tay.

### ✨ Đăng nhập Claude CLI từ plugin
- `GET /auth/status` (đọc `claude auth status`, JSON `loggedIn`) và `POST /auth/login` (mở Terminal chạy `claude auth login`, giống `promptLogin` của Bridge app). `/health` trả thêm `cliLoggedIn` (cache 60s, làm mới ngầm, không chặn request).
- Thanh trạng thái cảnh báo "Claude CLI hết phiên đăng nhập — bấm vào đây"; bảng tìm source có nút "Đăng nhập Claude". Plugin poll `/auth/status` mỗi 3s (tối đa 5 phút), đăng nhập xong tự chạy lại.
- **Vì sao cần:** Bridge app chỉ kiểm tra đăng nhập lúc khởi động — app chạy qua đêm, phiên hết hạn giữa chừng là AI hỏng im lặng.
- Không đăng nhập ngầm được: OAuth bắt buộc bấm trong trình duyệt. Muốn không bao giờ hết phiên thì dùng `ANTHROPIC_API_KEY` trong `bridge/.env`.

### 🔧 UI
- Checkbox cùng dòng với tên file (bảng tìm source + bảng Đối chiếu). UXP vẽ checkbox thành khối riêng nên phải ép flex.

## v5.8.1 / bridge app 3.12 (server 1.18.0) — 2026-09-24

> **Cần Bridge app 3.12 (server ≥1.18.0)** cho cả hai tính năng Watch/Autocut dưới đây.
> Bridge cũ vẫn chạy: Đối chiếu ghi nhật ký là không có bước xem lại; nút tìm source
> báo "cần Bridge ≥1.18.0" thay vì lỗi `Unexpected token '<'`.

### ✨ Mới — Autocut: tìm source thiếu trong Watch Folder
- Validate báo thiếu source → hiện **thẻ cảnh báo** (số source thiếu, tên, nút "Tìm trong Watch Folder", dòng tiến trình/lỗi). Bản nháp đầu là một nút lẻ ở góc phải — lọt thỏm, không ai biết nó liên quan tới dòng "thiếu source".
- `POST /watch/find-sources`: bridge quét thư mục sản phẩm (cấp cha của thư mục chứa `.prproj`, sâu 6 cấp) **và thư mục các watch đang có** (có thể ở ổ ngoài), gom kết quả theo thư mục, trả kèm số file đã quét.
- `POST /watch/suggest-bins`: model (`callLLM` — API key hoặc Claude CLI) ghép mỗi thư mục với **một bin có thật** trong project. Bin model trả về bị ép khớp lại với chuỗi thật; sai hẳn thì để trống cho người dùng chọn tay, không tin bừa (bin bịa sẽ đẻ folder rỗng).
- Bảng duyệt: đổi được bin, tick từng file. Khớp gõ-sai không tick sẵn — import nhầm clip lọt qua validate, tệ hơn thiếu. Xác nhận → tạo watch (lưu vào config như watch thường), import theo mẻ, validate lại.

### 🐛 Sửa — khớp tên phải giống hệt validate
- **Triệu chứng:** "Higg 30…36" báo *không thấy file nào khớp* dù `Sources/Higg/30.mp4…36.mp4` nằm ngay đó — trông như chưa tìm đã trả lời.
- **Nguyên nhân:** bản đầu chỉ so tên file. Cutsheet dùng quy ước `<thư mục> <số clip>` mà `sacMatchBinItem` hiểu ở lượt 3.
- **Fix:** bridge chép lại **đủ 4 lượt** của `sacMatchBinItem` (trùng tên → tiền tố + ranh giới → thư mục + clip → gõ sai với dãy số phải khớp tuyệt đối). Lệch nhau là hỏng cả tính năng: bridge "thấy" mà import xong validate vẫn báo thiếu.
- Clip khớp kiểu thư mục + số phải nằm trong bin **lá** có tên chứa phần thư mục, nên nếu bin được chọn không mang tên đó thì import vào bin con đặt theo tên thư mục (`Sources` → `Sources/Higg`). Model được dặn ưu tiên bin đã mang tên thư mục.
- Danh sách bin gửi cho model/dropdown dùng đường dẫn đầy đủ — bản đầu ghép `parent` (chỉ là tên lá) nên ra đường dẫn cụt.

### 🐛 Sửa — Watch: Đối chiếu import thẳng, từng file một
- **Triệu chứng:** bấm Đối chiếu là import luôn không hỏi; Premiere nhảy dialog liên tục, chiếm màn hình, chậm.
- **Nguyên nhân:** `scan-now` đẩy cả thư mục vào hàng đợi, vòng poll `importFiles([1 file])` lặp lại.
- **Fix:** `scan-now` nhận `{preview:true}` — chỉ liệt kê, không đụng hàng đợi. Plugin so với project, mở bảng tick chọn file còn thiếu (nhóm theo bin), rồi import **một `importFiles` cho mỗi bin đích**. Phần import tách thành `wfImportPicked()` dùng chung cho Autocut.

### 🔧 Voice Gen
- Thanh "Lần gen i/N" ở khu kết quả chỉ đếm các lần gen **trong phiên** (tắt/mở Premiere về 0). History "Gần đây" không đổi; mở lại một mục cũ thì mục đó nhập vào danh sách điều hướng của phiên để chỉ số không trỏ nhầm.

## v5.8.0 / bridge app 3.11 (server 1.16.0) — 2026-09-17

> Hai mảng lớn trong một bản: **tab Watch** (theo dõi thư mục, tự import vào bin)
> và **history theo lần gen** cho Voice Gen. **Cần bridge ≥1.16.0** cho tab Watch;
> phần Voice Gen không cần bridge mới.
> `manifest.json` cố tình giữ `5.8.0` không hậu tố: Adobe CC báo error -4 khi cài
> `.ccx` có pre-release suffix (xem commit 60bdac4).

# ══ Tab Watch Folder ══

### ✨ Mới
- **Tab Watch Folder.** Nhiều thư mục cùng lúc, mỗi thư mục có bin đích riêng, lọc theo loại file + regex, mirror subfolder thành bin con tương ứng.
- **Bridge quét theo chu kỳ thay vì `fs.watch`.** `fs.watch`/chokidar hay câm trên SMB/NAS, và dù dùng cách nào vẫn phải tự viết logic chờ file render xong — nên phần khó nhất không tiết kiệm được gì. Quét `readdir` + `stat` mỗi 3s, giãn lên 10s sau 2 phút không có gì, 15s nếu thư mục vượt 20.000 file.
- **Không quét khi không cần.** Bridge chỉ quét trong lúc panel mở; đóng panel thì quét lượt cuối rồi ghi snapshot và dừng hẳn. Mở lại quét bù so với snapshot nên file rơi vào lúc Premiere đóng vẫn được import — mà lúc nghỉ tốn 0% CPU.
- **Chờ file ghi xong mới import.** File chỉ vào hàng đợi khi `size` + `mtime` không đổi qua 2 lượt quét liên tiếp; file 0 byte luôn bị hoãn. Vì vậy mỗi file mất 6–9 giây từ lúc render xong tới lúc vào bin — đánh đổi có chủ ý.
- **Chọn thư mục mở sẵn ở thư mục sản phẩm.** Bấm "Chọn thư mục" ra bảng duyệt trong plugin, đứng sẵn ở cấp cha của thư mục chứa `.prproj` (bố cục quen thuộc `SanPham/Project/abc.prproj` + `SanPham/Footage`), có ô lọc, nút lên cấp trên, và "Duyệt thủ công…" để trỏ ra ngoài cây project. Không dùng hộp thoại hệ thống vì **UXP `getFolder()` chỉ nhận `initialDomain`, không nhận đường dẫn** — không ép được nó mở đúng chỗ. Plugin không tự đọc đĩa; danh sách thư mục do bridge cấp qua `GET /watch/browse`.
- **Nút Đối chiếu trên mỗi watch.** So thư mục với project và import những file còn thiếu — dùng cho file đã nằm sẵn trước khi tạo watch, hoặc clip lỡ bị xoá khỏi project. Chỉ đụng tới file đã thấy ở lượt quét trước (chắc chắn không phải đang render dở); file mới toanh vẫn đi qua đường chờ-ổn-định như thường.
- **Bỏ qua file đã có trong project**, so theo đường dẫn media chứ không theo tên, vì hai thư mục khác nhau hoàn toàn có thể chứa file trùng tên.

### 🧠 Quyết định đáng nhớ
- **Regex lọc soi tên file KHÔNG kèm đuôi.** Luật quen thuộc nhất (`_proxy$`) mà soi cả đuôi thì không khớp `a_proxy.mp4` — test bắt được ngay khi viết.
- **"Quét ngay" chạy sớm một lượt quét là nút chết.** Một lượt tick không bao giờ đẩy được file nào vì file phải ổn định qua 2 lượt — nút bấm vào không có gì xảy ra. Đổi hẳn ngữ nghĩa thành "Đối chiếu" mới có tác dụng thật.
- **Plugin ack chứ không để bridge tự đánh dấu xong.** File chỉ coi là đã import khi `importFiles()` thành công thật; Premiere từ chối codec hay panel reload giữa chừng thì file quay lại hàng đợi, retry 3 lần rồi mới bỏ.
- **Dùng lại `ppGetOrCreateBin`/`ppMoveToBin` của main.js.** `importFiles()` không nhận bin đích và không trả về ProjectItem; phần cast `FolderItem` + transaction đã được giải quyết ở `autoImportVoice`, viết lại chỉ để dính lại đúng những cái bẫy cũ.
- **Watch lưu theo từng `.prproj`.** Bin đích của project này không tồn tại ở project khác, nên config toàn cục sẽ hỏng ngay khi mở project thứ hai.

### 🧪 Test
- Không nâng `REQUIRED_BRIDGE` của plugin: chỉ tab Watch cần bridge 1.16.0, nâng ngưỡng chung sẽ chặn cả plugin với cảnh báo "bridge quá cũ" cho người chỉ dùng Autocut/VoiceGen. Tab Watch tự báo khi endpoint `/watch/*` trả 404.
- 5 file test mới cho bridge (`npm test` trong `bridge/`): luật lọc, quét thư mục, lưu trữ, engine, endpoint. Toàn bộ logic quét chạy được không cần Premiere.

# ══ Voice Gen — history theo lần gen ══

### ✨ Mới
- **History theo lần gen.** Trước đây một mục = một cặp voice+script và bị gộp trùng, nên gen lại cùng script là mất đường vào output cũ — dù file mp3 vẫn nằm nguyên trên đĩa, chỉ là `lastVariations` bị ghi đè.
- **Mỗi mục có 4 nút**: ▶ nghe ngay trong sidebar, **Import** vào project, **Mở lại** đưa nguyên lần gen lên khu kết quả (đủ Import / Timeline / Autocut), **Nạp script** như cũ.
- **History lưu TRỌN script.** v5.7.0 cắt còn 200 ký tự vì script khi đó chỉ dùng để nhận ra mục; từ khi có nút "Nạp script" thì cắt = nạp thiếu chữ. Giờ lưu đủ (trần 20k ký tự), chỉ cắt khi hiển thị. Mục tạo trước bản này đã mất phần đuôi, không khôi phục được. Kèm theo: hết quota localStorage thì bỏ bớt mục cũ rồi thử lại, và báo lên status nếu vẫn không lưu được — trước đây lỗi bị nuốt nên history âm thầm ngừng lưu.
- **Đánh số lượt.** Trùng cả voice lẫn script thì hiện `Adam · lần 3` thay vì gộp làm một.
- **Thanh điều hướng `◀ Lần gen 3/12 ▶`** ở khu kết quả, lật qua lại giữa các lần gen của mode đang mở.
- **Multi-speaker và Voice Changer cũng vào history** — cả hai đều ghi đè `lastVariations` nên trước đây cũng mất output y hệt.

### 🧠 Quyết định đáng nhớ
- **Không kiểm tra file còn tồn tại lúc vẽ danh sách.** Mỗi mục một lệnh đọc đĩa, nhân 20 mục mỗi lần render là quá đắt cho thứ hiếm khi xảy ra. Bấm ▶ mà file đã bị dọn thì mới báo, và tô đỏ đúng mục đó.
- **"Mở lại" một lần gen SFX/Music tự chuyển mode.** Không chuyển thì khu kết quả hiện output của mode khác, rất dễ nhầm là gen hỏng.
- **`vgPlayPath` vốn đã huỷ lượt phát trước**, nên nghe ở sidebar tự dừng player ở khu kết quả — không phải viết thêm gì.
- **Mục history cũ (chưa có `outputs`) vẫn đọc được**, chỉ là nút Play/Import mờ đi. Không cần migration localStorage.
- **Selector nút phải kèm `[role="button"]`** mới thắng luật chung `div[role="button"]{...}` — class đơn (0-1-0) thua attribute selector (0-1-1).

### 🎨 Giao diện
- **Gập/mở cả section "Gần đây"** bằng cách bấm vào tiêu đề; nhớ trạng thái qua localStorage (`vg_hist_folded`). Khác với "Xem thêm" bên dưới — cái đó giãn 3 → 20 mục, cái này ẩn cả khối. Tiêu đề hiện thêm tổng số mục.
- Mục history thành 2 dòng (voice + script ở trên, hàng nút ở dưới); sidebar phải nới 232→260px (chế độ hẹp 168→184px) để 4 nút không vỡ dòng.

## v5.7.1 / bridge app 3.10 (server 1.15.0) — 2026-09-17

> Sửa history "Gần đây" hiện cả voice không dùng được ở profile đang mở. **Không cần bridge mới.**

### 🔧 Sửa
- **History hiện voice của profile khác → bấm vào là gen lỗi.** Voice custom/clone gắn chặt với API key của profile tạo ra nó; v5.7.0 lưu chung một list và không lọc gì cả. Giờ mỗi mục lưu thêm `profileId`, khi render chỉ hiện mục mà voice của nó **có trong `VG_VOICES_DATA` hiện tại** (bao trọn 25 voice mặc định — key nào cũng dùng được) **hoặc** do chính profile đang active tạo ra. Vế sau là cần thiết: key chỉ có quyền TTS không đọc được danh sách voice custom, thiếu vế này thì chính profile đó cũng mất history của mình.
- **Cap 20 giờ tính cho TỪNG profile.** Dùng chung một hạn mức thì một profile gen nhiều sẽ đẩy bay sạch history của profile khác.
- Gọi lại `vgRenderHistory()` khi `loadVoices()` xong (lúc đó `VG_VOICES_DATA` mới là của profile mới) và khi đổi sang profile chưa có key (không ai nạp voice nên phải tự render).

### 📌 Lưu ý
- Mục history tạo ở v5.7.0 chưa có `profileId`: voice mặc định vẫn hiện bình thường, voice custom thì ẩn đi. Gen lại một lần là có lại.

## v5.7.0 / bridge app 3.10 (server 1.15.0) — 2026-09-17

> Voice Gen nhớ những giọng đã dùng gần đây. **Không cần bridge mới** — thuần plugin.

### ✨ Mới
- **Section "Gần đây" trên sidebar phải** (ngay dưới Profile, chỉ hiện ở mode TTS): 3 lần gen gần nhất, mỗi mục là tên voice + đoạn đầu script để nhận ra "lần đó là bài nào". Nút **"Xem thêm"** giãn tại chỗ tối đa 20 mục.
- **Click vào dòng = đổi lại voice đó.** Script đang soạn không bị đụng tới.
- **Nút "Nạp script"** nạp lại script của lần gen đó. Ô đang có bài khác thì phải bấm hai lần (lần một nút đổi thành **"Ghi đè?"**, có 4 giây để bấm tiếp) — tránh đè mất bài đang viết.
- **Nhãn Profile nằm cùng hàng với chip đổi profile**, tiết kiệm một dòng trên sidebar vốn đã hẹp.

### 🔧 Kỹ thuật
- Lưu ở `localStorage` key `vg_voice_history`: mảng `{voiceId, voiceLabel, script, ts}`, mới nhất đầu, cap 20, script cắt còn 200 ký tự. Trùng **cả** voiceId lẫn script thì gộp lên đầu thay vì sinh mục trùng. Ghi ở nhánh thành công của `generate()` khi `currentMode === 'tts'`, đọc `body.voiceId`/`body.text` (chính payload vừa gửi bridge) nên chắc chắn khớp audio vừa tạo.
- **Lưu `voiceLabel` kèm `voiceId`, không chỉ id:** danh sách voice phụ thuộc API key, đổi profile hoặc key hết hạn thì `VG_VOICES_DATA` không còn voice đó — vẫn phải hiện tên đọc được thay vì một chuỗi id.
- Multi-speaker **không** ghi history: một lần gen sẽ đẩy 3–4 mục, lấp sạch 3 slot hiển thị.

### 🪤 Bẫy UXP gặp phải (nút "Nạp script" ban đầu bấm không ăn)
- **Nút trong hàng phải có hộp kích thước tường minh.** Chỉ `flex: 0 0 auto` với nội dung là `<span>` inline bọc SVG thì UXP co nút lại gần 0 → gần như không có vùng bấm. Mẫu đúng là `.vg-dropItemPrev` (`width/height` + `display:inline-flex`).
- **Không lồng `role="button"` trong `role="button"`.** Đặt lên cả hàng cha lẫn nút con thì sự kiện của cái bên trong bị nuốt. Mẫu `.vg-dropItem` để cha là div trơn.
- **Không dùng `confirm()` native** — cả plugin chỉ có đúng 1 chỗ dùng và nằm ở đường ít đi qua, độ tin cậy trong UXP chưa rõ. Dùng xác nhận 2 bước `is-armed` như `elvArmed` (xoá voice) và `stDisarmClear` (xoá session) đã làm.
- Biến CSS `--text-muted` được dùng 6 chỗ trong `styles.css` nhưng **chưa bao giờ được định nghĩa** (`.vg-dropItemPrev` là một trong số đó) — code mới tránh dùng; lỗi cũ chưa sửa.

## v5.6.5 / bridge app 3.10 (server 1.15.0) — 2026-09-15

> Sửa 4 lỗi làm tính năng đính voice trong Autocut chết hẳn, trong đó có 1 lỗi khiến Bridge app treo cứng.

**Đính voice từ folder báo `whisper exit 1` rồi kẹt mãi ở "Đang xử lý voice".** Ba lỗi độc lập cộng dồn.

### 🔧 Sửa
- **Whisper crash lúc import Python** (`FileNotFoundError: [Errno 2]` trong `inspect.py` → `os.path.abspath`). Nguyên nhân: `spawn(WHISPER_BIN, args, { env })` không set `cwd` nên kế thừa cwd của tiến trình cha; nếu thư mục đó đã bị di chuyển/xoá, Python chết ngay khi resolve đường dẫn module tương đối. Fix: `cwd: outDir` (thư mục tạm vừa `mkdtempSync`, luôn tồn tại).
- **Cờ `sacVoiceBusy` kẹt `true` vĩnh viễn.** Nhánh `if (!d.ok) { ...; return; }` trong `sacAlignVoice()` thoát mà không reset cờ → mọi thao tác voice sau đó bị chặn bằng "⏳ Đang xử lý voice, đợi chút...", kể cả nút chọn folder. Fix: chuyển reset vào `finally` để mọi đường thoát đều nhả cờ.
- **Bundle Bridge app thiếu `autoset-names.js`** → `MODULE_NOT_FOUND`, bridge trong app chết ngay khi boot (chạy `node server.js` từ `bridge/` thì bình thường, nên lỗi chỉ hiện ở bản đóng gói). Nguyên nhân: `build-app.sh` copy từng file một và bỏ sót. Fix: `cp bridge/*.js`, cộng 2 cửa kiểm trong build — quét mọi `require('./x')` đối chiếu bundle, và **chạy thật** server.js đã đóng gói 4s, gặp `MODULE_NOT_FOUND`/`SyntaxError` là fail build.
- **Bridge app treo khi bấm "Khởi động lại Bridge".** Hệ quả của lỗi trên: bridge chết tức thì → auto-restart không giới hạn, mỗi vòng chạy `curl --max-time 2` + `lsof | xargs kill` + `Thread.sleep` **ngay trên main thread** → menu mở được nhưng handler của nút restart không bao giờ tới lượt. Xác nhận bằng `sample`: main thread lặp trong `startBridge()`, kẹt ở `waitUntilExit`/`nanosleep`.

### 🔧 Kỹ thuật (bridge-app/main.swift → 3.10)
- `startBridge()` tách phần chậm sang `DispatchQueue.global()`, dùng `shTimeout` thay `sh()` (bản cũ **không có timeout** — `lsof` kẹt là treo app vĩnh viễn); phần `Process.run()` hop về main qua `launchBridgeProcess()`.
- `restartBridge()` cũng bỏ `sh()` + `Thread.sleep` khỏi main thread.
- Auto-restart **cap 5 lần** (`maxAutoRestarts`), hết thì dừng và báo `❌ Bridge lỗi liên tục — xem Log (⌘L)`.
- Thêm **watchdog 15s** (`healthCheck()`): bridge được "adopt" (không do app spawn) thì không có `terminationHandler`, chết là không ai biết — trước đây tray vẫn xanh trong khi plugin báo offline. Cờ `startPending` chặn watchdog đua với backoff timer.

## v5.6.4 / bridge 3.9 (server 1.15.0) — 2026-09-14

> Bridge không đổi. Sửa chỗ đặt chip quick switch của v5.6.3.

**Chip đổi nhanh profile thành section riêng.** v5.6.3 đặt chip ở cuối `vg-modeBar` cạnh Create — hàng đó chia đều cho 4 nút mode nên chip bị bóp còn mỗi icon + 1 ký tự tên, đọc không ra profile nào.

### 🔧 Sửa
- Chip chuyển sang **section "Profile" trên cùng sidebar phải** (`.vg-rightScroll`), đặt ngoài `.vg-modeContent` vì API key dùng chung cho cả 4 mode.
- Đổi kiểu: nút full-width có viền, tên dài bị ellipsis thay vì cắt cụt.

## v5.6.3 / bridge 3.9 (server 1.15.0) — 2026-09-14

> Bridge không đổi (Bridge app 3.9, server 1.15.0). Chỉ sửa plugin.

**Voice Gen: quick switch profile + nút ⚙ theo tab.** Đổi profile API key ElevenLabs không cần mở Settings nữa.

### ✅ Thêm mới
- **Chip quick switch** ở cuối `vg-modeBar` (cạnh Create): hiện tên profile đang dùng, bấm một phát là xoay sang profile kế tiếp.
- Chỉ xoay qua **profile có API key**; còn <2 profile dùng được thì chip mờ (`is-disabled`) và không phản hồi.
- **Nút ⚙ trên thanh trên cùng mở thẳng settings của tab đang mở**: `autocut` → Autocut, `voicegen` → Voice Gen, `subtext` → General (chưa có panel riêng).

### 🔧 Kỹ thuật
- Tách `vgActivateProfile(id)` từ handler `change` của `vgProfileSelect` — dropdown trong Settings và chip dùng chung một đường, không còn hai bản logic song song.
- `vgRenderProfiles()` gọi thêm `vgRenderProfileChip()` nên nhãn chip tự đúng khi thêm/sửa/xoá profile.
- `settingsTabForActivePanel()` map `.tab-btn.active[data-tab]` → `data-stab`, mặc định `general`.

## v5.6.2 — 2026-09-09

> Bridge không đổi (vẫn 1.15.0). Chỉ sửa plugin.

**Tạo Sub: option bật/tắt tự động lưu SRT.** Thêm toggle "Tự động lưu SRT" trong Settings ▸ Voice Gen.

### ✅ Thêm mới
- **Toggle "Tự động lưu SRT"** (Settings ▸ Voice Gen) — mặc định BẬT, nhớ trạng thái qua localStorage (`st_srt_autosave`).
- **BẬT** (như 5.6.1): `.srt` tự lưu cạnh file VO, tên theo version sequence.
- **TẮT**: sau khi tạo xong mở hộp thoại **Save** (`getFileForSaving`) — chọn được cả thư mục lẫn tên, gợi ý sẵn tên theo version. Cancel → huỷ, không tạo file.

### 🔧 Kỹ thuật
- `stResolveOutputPath()` rẽ nhánh theo `stSrtAutoSaveOn()`; nhánh tắt dùng `localFileSystem.getFileForSaving(base + '.srt')`, nhớ thư mục vào `vg_last_save_folder`. Bridge (`fs.writeFileSync`) không đổi.

## v5.6.1 — 2026-08-26

> Bridge không đổi (vẫn 1.15.0).

**Autocut trang Auto: gọn UI + trang Auto Sub + loạt fix state dùng chung.** Bấm chạy không còn thấy Blocks nhảy sang video khác; dựng xong đi thẳng sang làm phụ đề với script đã nạp sẵn.

### ✅ Thêm mới
- **Popup confirm trước khi chạy** — liệt kê đủ **cả 3 video**: tên sequence + bin + đường dẫn voice. Thay khối preview inline (vốn chỉ hiện voice của 1 video). Tên là deliverable giao cho CO nên đây là điểm dừng bắt buộc duy nhất chắc chắn có người đọc.
- **Trang Auto Sub** thay trang success cho luồng Auto — mượn nguyên node `.st-app` của tab TẠO SUB, có tab `.0/.1/.2`: bấm tab nào thì `openSequence` + `setActiveSequence` sang sequence đó và tự đổ script của đúng video vào ô script. Nút ← Về cut trả node về chỗ cũ.
- **Nút Huỷ** — dừng ở **ranh giới giữa 2 video**, không cắt ngang. Giữa chừng là đang gen voice (ElevenLabs), align (Whisper) hoặc dựng timeline (Premiere API); cắt ngang để lại file voice dở, sequence dở, và chạm sequence sai lúc là nguồn crash quen thuộc.
- **Nút Xoá sạch cả bộ** — xoá 3 job + số bộ + `AUTO_SET_KEY` trong localStorage, **giữ lại** cấu hình project (Sản phẩm/CO/Editor/mẫu bin). Có bước xác nhận vì không hoàn tác được.
- **Tab bám theo video pipeline đang xử lý** — trong lúc chạy chỉ một tab sáng và đó là video đang được vẽ Blocks, hết cảnh "tab nói .0 mà Blocks là .2".

### 🐛 Sửa lỗi
- **Panel Manual trống trơn khi chuyển Manual ↔ Auto** — `insertBefore(node, nextSibling)` ném lỗi khi ref là text/comment node (rất hay gặp trong UXP), làm `autoClose()` đứt giữa chừng và panel kẹt trong slot đang `display:none`. Cả 3 cặp borrow/return chuyển sang **placeholder**.
- **`autoNormalizeJobs` bị xoá nhầm** trong một refactor trước, chỗ gọi vẫn còn → `ReferenceError` ngay sau khi mượn panel, nên bảng không có dòng nào.
- **Timeline dựng ra không có hình** — `sacJobContext` không lưu `sacSourceMap`; map toàn cục này bị `sacValidateSources` reset mỗi lần validate nên tới chặng 3 chỉ còn của job cuối. Nay lưu/khôi phục theo từng job (cả `window.sacSourceMap`).
- **Cả 3 video bị ghi đè thành nội dung video cuối** — đổi tab hoặc rời trang giữa lúc pipeline chạy làm `autoCaptureRows`/`autoStashJobState` chép state của video pipeline đang xử lý đè lên tab đang rời, rồi `autoSaveState()` ghi xuống localStorage (hỏng vĩnh viễn, reload không chữa). Nay chặn đổi tab khi đang chạy và bỏ qua chụp state trong `autoClose()`/`autoSaveState()`.
- **Blocks không đổi theo tab** — `renderBlocks()` vẽ vào `#sacBlockList` dùng chung mà `autoRenderTab()` không gọi lại. Nay cất/khôi phục `parsedBlocks` + `sacSourceMap` theo job.
- **Validate lỗi thì chạy tiếp, không sửa được** — nay **dừng hẳn** và tự nhảy về tab video hỏng với đúng bảng + Blocks để bind source thiếu. Đảo lại quyết định "không chặn 2 video kia" của bản trước: chạy tiếp chỉ tốn credit ElevenLabs cho một bộ chắc chắn phải làm lại.
- **Trang success chen vào giữa lúc chạy bộ 3 video** — `sacRunAutoCut()` được gọi 3 lần trong chặng 3; nay chặn bằng cờ `autoRunning` (luồng Manual giữ nguyên trang success).
- **Trang Auto không theo màu chủ đề** — khối CSS hardcode hex nên đổi accent thì trang Auto đứng im. Nay dùng token `--accent*`/`--surface2`/`--text-dim`.

### 🗑 Gỡ bỏ
- **Parse cutsheet rối bằng AI** — gỡ khỏi plugin lẫn endpoint `POST /superautocut/parse-cutsheet` ở bridge.

### 🔧 Kỹ thuật / Approach
- **Bẫy UXP mới ghi nhận:** `insertBefore` với ref là text/comment node ném lỗi → dùng placeholder; `white-space: pre-line` **gộp khoảng trắng đầu dòng** (cần thụt lề thì `pre-wrap`); `JSON.stringify` gặp ProjectItem sẽ ném lỗi, mà `autoSaveState()` bọc `try/catch` rỗng nên state **âm thầm ngừng được lưu** — mọi khoá tiền tố `_` bị lược khi serialize.
- **Log chẩn đoán `AUTO_DBG`** (tắt mặc định, bật bằng `localStorage.setItem('sac_auto_dbg','1')`) — in mỗi lần `renderBlocks` kèm stack, mỗi lần cất/nạp state theo job, và mốc chuyển tab. Đây là cách tìm ra 2 lỗi khó nhất của tính năng này.
- **`projectItem.getSequence` KHÔNG tồn tại** trên Premiere 25.6.x — không có đường tra ngược từ tên sequence ra object Sequence. Luồng cut không vướng vì `project.createSequence()` trả về object luôn; trang Auto Sub phải **giữ object từ lúc dựng** (`job._seq`). `autoResolveSeq()` thử 3 đường (object đã giữ → `project.getSequences()` → `projectItem.getSequence()`), và nếu object hết hạn thì vứt đi thử lại thay vì báo lỗi.

## v5.6.0 / bridge 3.9 (server 1.15.0) — 2026-08-25

> ⚠ **Bắt buộc bridge ≥ 1.15.0** (Bridge app 3.9).

**Autocut: Trang Auto cho bộ 3 video** — Một form duy nhất nhập số bộ + voice + ratio + 3 ô TSV → xử lý cả 3 video liền mạch: validate → gen voice (thông báo macOS) → dựng timeline (dừng cho nghe thử). Plugin tự suy ra tên sequence/bin/voice theo config project. Job lỗi không chặn 2 job còn lại.

### ✅ Thêm mới
- **Trang Auto** trong tab Autocut — form tập trung cho cả bộ 3 video (set), ghi một lần thay vì lặp 3 lần.
- **Tự suy ra tên** — sequence `[c.ha.ttdo] [user]`, bin `Sequence / {channel} / {set}x`, voice file `Voice Over/{set}x/{set}.{i} - {voice_name}.mp3` theo cấu hình project.
- **Thông báo macOS** — plugin không chặn UI lúc bridge gen voice, bấm "Đợi" rồi làm việc khác, macOS notify khi xong hoặc lỗi.
- **Job resilience** — validate/gen/build 3 timeline song song; lỗi ở video này không dừng 2 video còn lại. Báo chi tiết: video nào, lỗi gì (VO file missing, timeline build failed).

### 🔧 Kỹ thuật / Approach
- Bridge POST `/autoset/names` → tên cho 3 video + 3 bin từ 1 call (tránh gọi 3 lần); POST `/autoset/voicedir` → tìm/tạo thư mục cạnh `.prproj`.
- Plugin tích hợp `window.requestIdleCallback` + `Promise.allSettled` → gen/build không chặn UI; thông báo qua POST `/notify` (osascript).
- Trữ lại "bộ cuối" (set number) trong localStorage → mở lại plugin mở sẵn set vừa làm.

## v5.5.0 / bridge 3.9 (server 1.14.0) — 2026-08-24

> ⚠ **Bắt buộc bridge ≥ 1.14.0** (Bridge app 3.9). Plugin cảnh báo đỏ + chặn Tạo SRT nếu bridge cũ.

Gộp nhánh **Voice Changer** vào main cùng đợt **sub-fix**. Cấp version đè cả hai (trước đó hai nhánh vô tình cùng đánh bridge 1.13.0 / app 3.8). Chi tiết từng phần ở các entry bên dưới:
- **Voice Changer (ElevenLabs STS)** + render đúng vùng chọn — xem v5.4.0 → v5.4.2.
- **Tạo Sub** — fix ghép audio (clip đổi tốc độ, trộn đúng lớp track), Clear session, chống nhầm script cũ, menu bar app đơn sắc + "Kiểm tra thành phần" — xem "Tạo Sub" ngay dưới.

## Tạo Sub — fix ghép audio + menu bar (phần của v5.5.0)

### 🐛 Bugs đã fix
- **Tạo Sub — clip bị đổi tốc độ (speed) ghép sai audio** — Phụ đề mất đầu câu và dính cả câu đã trim bỏ. Nguyên nhân: `trackItem.getInPoint()/getOutPoint()` của Premiere trả về theo **đơn vị timeline** (= giây trên nguồn ÷ speed), không phải giây nguồn; bridge đưa thẳng cho `ffmpeg -ss` nên cửa sổ cắt vừa **trễ** vừa **dài quá**. Ca thật đo được: clip speed 85.3%, Premiere hiện in 7:20 / out 10:05 (=7.667→10.167s nguồn) nhưng API trả 8.99→11.92 → cắt trễ 1.32s (mất "You can actually pick exactly") và thừa 1.75s (lấy sang "I'm obsessed!" đã trim). Cách fix: `resolveClipWindow()` xác định speed (API `getSpeed` → `getDuration/tlDur` → `(out−in)/tlDur`), nhận diện in/out đang theo đơn vị timeline hay nguồn, **nhân lại in-point + span với speed**, rồi `atempo` (chain nhiều tầng cho speed ngoài 0.5–2×) đưa đoạn về đúng độ dài trên timeline. `cursor` chạy theo độ dài timeline thay vì `(out−in)`.
- **Tạo Sub — clip ở nhiều track bị NỐI ĐUÔI thay vì trộn theo lớp** — Quên bỏ tick track nhạc thì nhạc nền dài 52s bị chèn vào **giữa** lời và đẩy toàn bộ phần sau lệch 52 giây (audio 51.6s → 107.6s). Nguyên nhân: `subtextConcatClips` sắp theo `start` rồi nối đuôi + chèn im lặng cho khoảng hở — model chỉ đúng khi clip không bao giờ chồng nhau. Cách fix: bỏ concat demuxer, mỗi đoạn `adelay` về đúng giây trên timeline rồi `amix=normalize=0` cộng lại (voice không bị nhỏ đi khi có nhạc chồng lên). Báo rõ số clip chồng nhau + gợi ý bỏ tick track nhạc/SFX.
- **Tạo Sub — vẫn dùng script cũ dù đã dán script mới** — Sau khi canh giờ, plugin **ghi đè ô script** bằng các cue vừa ngắt; script sai vì thế dính lại làm nội dung của ô cho mọi lần chạy sau, và nếu dán script mới trong lúc Whisper chạy (10s–2 phút) thì bản dán bị nuốt im lặng. Cách fix: chụp snapshot ô script lúc bắt đầu, nội dung đổi trong lúc chạy thì **không ghi đè** mà báo để chạy lại; dòng chẩn đoán ghim luôn script đang dùng; khớp <40% thì cảnh báo đỏ "script của video khác".
- **`-to` sau `-i` cắt cụt khi có filter** — `-to` là output option nên áp SAU `atempo`: đoạn 12.5s bị cắt còn 10.0s. Chuyển sang input-seek `-ss/-t` đặt trước `-i` (đo lại: chính xác trên wav/mp3/m4a/mp4 có start_time lệch).

### ✅ Thêm mới / Cải tiến
- **Nút Clear session** (tab Tạo Sub) — xoá script, timing đã canh, kết quả lần trước, huỷ việc đang chạy và quét lại track. Bấm 2 lần để xác nhận (4s tự huỷ).
- **Cảnh báo đỏ bridge cũ** — banner đỏ trong tab Tạo Sub + chặn bấm Tạo SRT khi bridge < 1.13.0, kèm hướng dẫn cập nhật.
- **Report auto sub đầy đủ hơn** — bảng bản đồ clip có thêm cột **track**, **NGUỒN cắt thật**, **speed %**, cờ `chồng Xs với #n`, và mục "Whisper nghe được TỪNG clip" (gán từ về clip ngắn nhất chứa nó nên nhạc nền không nuốt hết chữ).

### 🔧 Kỹ thuật / Approach
- Suy ra speed 3 đường độc lập (in-point, out-point, span) khớp đến 4 chữ số → đủ chắc để sửa mà không cần API speed; vẫn ưu tiên `getSpeed` khi Premiere có.
- `amix` phải dùng `normalize=0`, mặc định chia cho số input làm voice nhỏ đi khi có nhạc chồng lên.
- `atempo` chỉ nhận 0.5–100 → `atempoChain()` tách thành nhiều tầng nhân với nhau.
- Plugin gửi kèm `endTime`, `speed`, `srcDuration`, `track`, `name` + `probe` (dump các API thời gian của track item / project item) để chẩn đoán được từ report mà không cần mở Premiere.

## v5.4.2 — 2026-08-20  (bridge app 3.8 / bridge server 1.13.0)

### ✅ Fix (Voice Changer — render vùng chọn)
- **Chỉ render track chứa clip đã chọn.** `exportSequence` render toàn bộ mix nên
  bản gộp lẫn cả BGM/SFX. Nay trước khi export, plugin map clip đã chọn → track
  (khoá start(2 chữ số)|tên file), **mute mọi audio track không có clip chọn**,
  export xong **khôi phục** trạng thái mute. Loại BGM/SFX khỏi bản gộp.
- Giới hạn: mute theo track — nếu track VO còn clip KHÔNG chọn trong vùng in/out
  thì clip đó vẫn lọt (hiếm với VO). Khi cần chính xác tuyệt đối phải tạo
  sub-sequence tạm chỉ chứa clip chọn.

## v5.4.1 — 2026-08-20

### ✅ Cải tiến / Fix (Voice Changer — "Lấy clip đang chọn")
- **Render đúng audio timeline thay vì nối in/out nguồn.** Cách cũ (nối khoảng
  in/out từng clip từ file gốc) tái tạo SAI với VO dựng từ nhiều take: lặp đoạn,
  thiếu đoạn, sai thứ tự — vì không phản ánh những gì timeline thực sự PHÁT (mix
  nhiều track, khoảng trống, đúng trim của editor; take thô còn chứa câu nói vấp).
- **Cách mới:** span vùng chọn (min getStartTime → max getEndTime) → đặt in/out
  sequence → `EncoderManager.exportSequence(seq, ExportType.IMMEDIATELY, outFile,
  presetWAV, exportFull=false)` (preset WAV mono 48k của Premiere; bridge tìm giúp
  qua `GET /media/audio-preset`) → khôi phục in/out cũ → bridge trích audio
  (`POST /media/extract-audio`). Verified khớp bản export chuẩn (transcript + thời
  lượng trùng).
- **Nút "Nghe thử bản gộp"** — phát thử audio nguồn trước khi đổi giọng (afplay).
- Nối in/out nguồn giữ lại làm **dự phòng** (khi export lỗi) kèm cảnh báo ⚠.
- API note: `exportSequence` cần `presetFile` là string hợp lệ (`undefined` →
  "Illegal Parameter type"; `''` → "Invalid parameter"). `concat-from-sequence`
  đổi trích đoạn sang `-ss` trước `-i` + `-t` (không mơ hồ).

## v5.4.0 — 2026-08-20

### ✅ Thêm mới
- **Voice Changer (Đổi giọng)** — card thứ 3 trong tab Create. Lấy audio từ clip
  đang chọn trên timeline (gộp nhiều clip qua ffmpeg) hoặc upload file → đổi sang
  giọng đích ElevenLabs (Speech-to-Speech). Settings: model STS, Stability/
  Similarity/Style, khử tiếng ồn nền. Kết quả dùng chung khu Lưu/Import của tab Voice.
- **Bridge `POST /voice/change`** — đọc file local → multipart STS → lưu output.


## bridge 3.7 — 2026-08-20

### ✅ Thêm mới / Cải tiến
- **Log auto sub (Whisper vs script)** — Mỗi lần tạo phụ đề, bridge ghi 1 report `.md` vào `~/Documents/Claude Bridge Logs/autosub/` (giữ 60 lần gần nhất) + 1 dòng tóm tắt trong `autosub-history.log`. Report gồm: transcript Whisper nghe được; **diff theo từ (LCS)** giữa script và Whisper kèm mốc thời gian (nhãn *hụt* / *thêm chữ*); các đoạn script **bị nội suy timing** (nguyên nhân chính khiến caption trôi); khoảng lặng ≥2s; danh sách cue cuối cùng. Mục đích: có dữ liệu thật để tìm hướng cải thiện độ chính xác.
- **`/superautocut/subtext-finalize` giờ trả `diag`** — Trước đây bước finalize (cũng chạy Whisper) không trả chẩn đoán nào; nay tính đủ matchPct / gaps / silentTail như `/subtext`.
- **`GET /autosub/logs`** — Liệt kê 20 report gần nhất; `?reveal=1` mở thư mục trong Finder. Tray app có menu **📄 Log Auto Sub**.
- **Icon menu bar mới** — Emoji `⚡`/`🔴` render màu nên lạc giữa các icon đơn sắc của macOS. Thay bằng **template `NSImage` tự vẽ** (tia sáng 8 cánh): tự đảo màu theo light/dark và khi menu mở; đang chạy = đậm, đã dừng = mờ 35%; thêm tooltip trạng thái.

### 🔧 Kỹ thuật / Approach
- `subtextAssignTimes` set thêm `s.hit` cho mỗi từ script khớp thật với 1 từ Whisper → phân biệt được timing **thật** vs **nội suy** khi ghi report.
- Diff dùng LCS DP `Uint32Array` (chặn ở 6M cặp, quá ngưỡng thì bỏ diff chi tiết) — script/whisper cỡ vài nghìn từ vẫn nhanh.
- Report tách sang `bridge/autosub-log.js`, `writeReport()` **không bao giờ throw** ra endpoint (log lỗi rồi trả `null`) để không làm hỏng luồng tạo SRT.
- `bridge-app/build-app.sh` + `pack.sh` copy thêm `bridge/autosub-log.js` vào bundle/zip.

## v4.9.4 — 2026-07-10

### ✅ Thêm mới / Cải tiến
- **Lưu file VO thông minh** — Dialog "Lưu audio" (Voice Gen) giờ tự gợi ý tên theo dạng `v{version} - {tên voice}` (vd `v14.3 - Rachel`): version nhớ chính xác từ lần lưu trước, tên voice tự điền từ voice đang chọn.
- **Lịch sử + preset tên file** — Nút "Gần đây" xổ 5 tên lưu gần nhất; nút "Preset" xổ các tên đã lưu (bấm × để xoá); nút "Lưu preset" lưu tên hiện tại.
- **Lịch sử + bookmark thư mục** — Dưới ô "Thư mục lưu" có nút "Gần đây" (5 thư mục gần nhất) và "Bookmark" (thư mục đã đánh dấu). Icon 💾 cạnh đường dẫn để lưu/bỏ lưu nhanh thư mục hiện tại (sáng xanh khi đã bookmark).
- **Un-nest — giới hạn phần tràn ±2s** — Sau khi bung, mỗi element chỉ được dài tối đa **2 giây** trước/sau vùng in-out của sequence (thay vì giữ nguyên độ dài gốc quá dài). Nếu sequence nằm sát đầu timeline (<2s), phần đầu được cắt ngay tại mốc 0 để **giữ alignment** với các element khác, không bị đẩy lệch.
- **Un-nest — loại trừ item khi bung** — Trong Settings → Un-nest có ô tìm kiếm để **chọn các item không muốn bung** (giữ lại trong nest). Danh sách lưu **theo từng project**, có popup xem/xoá riêng, search theo tên để không bị danh sách dài.
- **Voice Clone — chọn track audio nguồn** — Khi clone giọng "From Timeline", có dropdown chọn **track audio bất kỳ** (chỉ hiện track có clip, kèm số lượng) thay vì mặc định luôn A1.
- **Quản lý voice clone ElevenLabs** — Trong Settings → Voice Gen có mục **"Voice clone (ElevenLabs)"**: hiển thị **số slot clone đã dùng / giới hạn** của tài khoản API hiện tại (đỏ + "ĐẦY" khi hết slot), và cho phép **tìm kiếm + tick nhiều + xoá** các voice clone ngay trong plugin (xoá 2 bước arm→xác nhận). Danh sách cập nhật ngay sau khi xoá.
- **Ô "Thư mục lưu" — xem & sửa path dễ hơn** — Đường dẫn giờ hiển thị **phần đuôi** (thư mục sâu nhất luôn thấy thay vì bị cắt đầu); **cuộn ngang** được (thanh scroll mảnh hoặc **lăn chuột**) để xem cả path; **hover** hiện tooltip **full path**; **double-click** vào ô để **gõ/dán path** trực tiếp (Enter lưu, Esc huỷ). Ô cao & rõ hơn, chữ căn giữa.

### 🐛 Bugs đã fix
- **Un-nest không cắt bớt element quá dài** — Element bung ra giữ nguyên độ dài, tràn dài quá vùng sequence. Nguyên nhân: dùng sai API trim (`createSetInOutPointsAction`/`createMoveTrackItemAction` không tồn tại trên track item của bản Premiere này) + không định vị được clone (khớp theo thời điểm start hỏng với ảnh tĩnh, clip trùng start, offset âm) + không quét track mới tạo (V11+). Cách fix: trim bằng `createSetStartAction`/`createSetEndAction`; định vị clone bằng **snapshot-diff toàn bộ track trước/sau clone** (bắt được cả clone trên track mới tạo); truyền **offset clone âm thật** thay vì kẹp về 0 để giữ alignment khi nest sát đầu timeline.
- **"Move to Voice Over bin" bỏ qua checkbox** — Nguyên nhân: luồng import của AutoCut (`sacFindOrImportFile`) gọi `ppMoveToVOBin` vô điều kiện, không đọc trạng thái checkbox — nên dù tick hay bỏ tick clip vẫn luôn bị chuyển vào bin "Voice Over". Cách fix: gom toàn bộ điểm gọi về 1 helper `ppMoveToVOBinIfEnabled()` (kiểm tra `ppShouldMoveToVOBin()` trước khi move), đảm bảo mọi luồng import (Import / Import to timeline / AutoCut) đều tôn trọng checkbox.
- **Un-nest — ô tìm "item loại trừ" nuốt chữ** — Gõ vào ô search bị nuốt chữ, không gõ tiếp được (sót sau lần fix trước). Nguyên nhân: ô input nằm CHUNG hộp `overflow-y:auto` với danh sách kết quả → mỗi keystroke toggle `display` làm hộp reflow → UXP reset vùng chọn input về select-all → phím kế ghi đè. Cách fix: cho `#unExcludeAddPanel` thành **flex column**, input là header `flex:0 0 auto` **tách khỏi vùng cuộn**, chỉ danh sách cuộn riêng — đúng khuôn dropdown chọn voice (vốn chạy tốt).

### 🔧 Kỹ thuật / Approach
- UXP flexbox **không hỗ trợ `gap`** → thay bằng `margin` tường minh; căn thẳng hàng các nút bằng `box-sizing: border-box` + `flex: 1` + `:last-child { margin-right: 0 }`.
- Dropdown dùng **custom toggle-panel** (không dùng `<select>` native vì render không ổn định và đè xuyên modal trong UXP).
- Lưu trữ bằng `localStorage`: `vg_last_version`, `vg_recent_names`, `vg_name_presets`, `vg_recent_folders`, `vg_folder_bookmarks`. Path thư mục tái dùng trực tiếp qua bridge nên không cần UXP folder token.
- **Un-nest trim**: cắt bằng `createSetStartAction`/`createSetEndAction` (track item bản này không có `createSetInOutPointsAction`/`createMoveTrackItemAction`); định vị clone bằng snapshot-diff toàn bộ track theo `getVideoTrackCount()` sau clone (co giãn theo số track, không hardcode); `TickTime.createWithSeconds(offset)` cho phép offset âm.
- **Loại trừ item**: match theo **project-item id** (`getProjectItem().getId()`), lưu `{id,name}` per-project trong `localStorage['unnest_exclude_v1']`; fail-open nếu không đọc được id. Dropdown search **pre-render một lần, lọc bằng display toggle** (không rebuild innerHTML mỗi keystroke) để không nuốt chữ tiếng Việt và không đóng modal khi click.
- **Voice Clone track**: `vcSelectedTrackIdx` (0-based) áp cho cả 2 path `trackGroup.getTrack()` và `getAudioTrack()`; dropdown custom toggle-panel liệt kê track có clip.
- **ElevenLabs manager**: plugin gọi thẳng `api.elevenlabs.io` (thêm domain vào `manifest.json`, **không sửa bridge → không cần re-sign app**); `GET /v1/voices` + `DELETE /v1/voices/{id}`; đọc `voice_limit` từ `/v1/user/subscription` (không bắt buộc — key thiếu quyền User thì hiện "X / ?"). Đếm slot lọc voice **của mình** (`category≠premade && !sharing`) để không tính nhầm voice thư viện. Xoá cập nhật lạc quan (ElevenLabs eventually-consistent nên không re-fetch ngay).
- **Ô path (Lưu VO)**: phần hiển thị là `<div>` cuộn (`overflow-x:auto` + `scrollbar-width:thin` + `::-webkit-scrollbar{height:3px}`) — KHÔNG dùng `<input>` để hiển thị vì input UXP không vẽ thanh scroll và selection **nhảy** khi re-focus. Gõ/paste path qua `<input>` riêng chỉ hiện khi double-click; `claimKeyboard()` gọi **1 lần** lúc vào edit (KHÔNG gọi trên `onfocus` — phantom focus của UXP sẽ re-select → nhảy). Hiện đuôi: `scrollLeft=scrollWidth`; lăn chuột: `onwheel → scrollLeft += deltaY`; tooltip full path tái dùng `.un-hkTip` (float `position:absolute`, append `body`, định vị bằng `getBoundingClientRect`).
- **Lưu ý build/test**: Premiere nạp bản plugin **đã cài** ở `~/Library/Application Support/Adobe/UXP/Plugins/External/com.claudeai.premiere-assistant_<ver>/`, KHÔNG phải folder source → sửa source phải **sync** vào đó (hoặc **dev-load** qua UXP Developer Tool) mới thấy thay đổi.

---

## v4.8.10 — 2026-06-30

### 🐛 Bugs đã fix
- **Lệch thời gian khi ô time nhiều dòng có "Giây …"**: Ô time kiểu `6-9 / Giây 11 / 30-32 / 3-5` bị lệch — "Giây 11" (và "Giây 24, 26") **bị rớt** nên các dòng còn lại dồn lên, ghép sai với source. Nguyên nhân: bộ lọc dòng time trong `splitTimes()` chỉ giữ dòng **bắt đầu bằng chữ số** (`/^\d/`), loại mọi dòng mở đầu bằng "Giây". Cách fix: cho phép tiền tố giây (`/^(?:gi[aâ]y|giay|s)?\s*\d/i`) — parser vốn đã tự bỏ tiền tố này. Dòng mô tả thật (vd "lặp liên tục với 3 màu") vẫn bị loại đúng.

---

## v4.8.9 — 2026-06-30

### 🐛 Bugs đã fix
- **Popup "gen voice?" — "lần sau không hỏi nữa" không nhớ**: Nguyên nhân: cờ `sacGenVoiceAsk` bị gán lại `true` mỗi lần cut mới/clear và không lưu đâu → lựa chọn skip mất ngay. Cách fix: bỏ cờ session + checkbox, thay bằng **setting bền vững**.

### ✅ Thêm mới / Cải tiến
- **Đưa lựa chọn vào Settings**: **Settings → "Autocut — Chuẩn hoá & gen voice khi Validate"** với 3 chế độ: **Hỏi mỗi lần** (mặc định) / **Tự gen voice** / **Chỉ validate**. Lưu ngay khi đổi (`localStorage['sac_genvoice_mode']`), bền qua reload/cut mới. Bỏ checkbox "Lần sau không hỏi nữa" trong popup.

### 🔧 Kỹ thuật / Approach
- `sacGetGenVoiceMode()` đọc `sac_genvoice_mode` (ask|auto|never); `sacAskGenVoice()` resolve thẳng cho auto/never, chỉ hiện modal khi ask. Gỡ 2 dòng reset `sacGenVoiceAsk = true`. Dropdown `#sacGenVoiceMode` wire độc lập nút Save (đổi là lưu).

---

## v4.8.8 — 2026-06-30

### ✅ Thêm mới / Cải tiến
- **Hợp nhất 2 prompt "Organize"**: nút **Organize** (Voice Gen) và **Gen voice** (Autocut) nay dùng **chung 1 prompt** (`buildOrganizePrompt()`) → cùng input cho **kết quả tương đồng**, không còn lệch luật giữa 2 nơi. Prompt hợp nhất là superset: nối câu vụn, bung viết tắt/ký hiệu, bỏ emoji, thẻ [emotion], sửa chính tả rõ ràng, giữ nguyên ngôn ngữ gốc — vẫn không đổi/thêm từ, không thêm chủ ngữ.
- **Nhấn mạnh = ALL CAPS**: luật viết hoa nay rõ ràng là **viết hoa TOÀN BỘ chữ** (mọi ký tự, vd `one goal` → `ONE GOAL`), không phải chỉ chữ cái đầu — để ElevenLabs nhấn đúng.

### 🔧 Kỹ thuật / Approach
- `server.js`: gộp nhánh `mode:'paragraph'` và nhánh mặc định của `/superautocut/normalize-script` về 1 luồng gọi `buildOrganizePrompt(rawText)`; `mode` vẫn nhận để tương thích ngược nhưng không đổi xử lý. `maxTokens` thống nhất 4096.
- Voice-align vẫn map block↔audio qua `block.texts` nên số dòng output khác block count không ảnh hưởng.
- Bump: Bridge app **2.35 → 2.36**, server API **1.7.3 → 1.7.4** (prompt nằm trong server.js → cần bridge update để team nhận). Plugin bump theo (không đổi logic plugin).

---

## v4.8.7 — 2026-06-30

### ✅ Thêm mới / Cải tiến
- **Autocut timestamp — nhận diện chữ "và"**: một ô time như `0:02-0:08 và 0:10-0:15` nay được hiểu là **2 timestamp khác nhau** (tách thành 2 cut riêng). Hỗ trợ cả `and`, và các ký hiệu `&` `+` `,` như trước.
- **Badge time hiển thị timecode chuẩn**: ô time thô như `giây số 5` / `giây 18-19` nay hiện gọn thành `0:05` / `0:18-0:19`. Chỉ đổi **hiển thị** — `s.time` (nguồn cut) giữ nguyên nên cut chạy y hệt.

### 🔧 Kỹ thuật / Approach
- Thêm split trên connector `\s+(?:và|and)\s+` (cần khoảng trắng 2 bên để không khớp nhầm trong tên) ở cả `splitTimes()` (expandRows — tách ô time thành nhiều dòng) lẫn `srcEntries()` (1 source nhiều range → nhiều clip entry).
- `.normalize('NFC')` trước khi split để "và" dạng decomposed (v + a + dấu huyền tổ hợp) vẫn khớp.
- `sacFmtTimeBadge()`: tái dùng cùng regex token (`\d+(?::\d+){0,2}(?:\.\d+)?`) của `parseSourceTime`, format `M:SS` / `H:MM:SS` (1 điểm → không cộng +3s mặc định); text không có time → trả nguyên gốc. Gọi tại render badge trong `renderBlocks`, không sửa dữ liệu cut.

---

## v4.8.6 — 2026-06-30

### ✅ Thêm mới / Cải tiến
- **Autocut bind — nhớ bind theo project**: bind source nay được lưu `localStorage` theo **tên project đang mở**. Cắt xong task 1, sang task 2 (cutsheet mới) cùng project → các source đã bind tự nhận lại, không phải bind lại từ đầu.
- **Autocut bind — 1 source nhiều lần tự lan**: cùng một source dùng ở nhiều block/time, chỉ cần bind **1 lần** → mọi block còn lại cùng tên gốc tự cập nhật (cả khi bind lẫn unbind). Trước đây phải bind từng dòng.
- **Popup bind — sắp xếp ổn định**: danh sách source nay xếp **natural A→Z, 1→99** ("Clip 2" trước "Clip 10"), giữ clip khớp nhất trên đầu.

### 🐛 Bugs đã fix
- **Tên dài khớp 100% vẫn "không thấy trong bin"** — Nguyên nhân: macOS lưu tên file **NFD** (decomposed) còn text cutsheet paste là **NFC** (composed) → `"43. Entry diễn tả mesh"` từ bin ≠ từ sheet ở mức byte dù nhìn giống hệt. Cách fix: thêm `.normalize('NFC')` ngay đầu `sacNorm()` để thống nhất 2 dạng Unicode trước mọi so khớp.

### 🔧 Kỹ thuật / Approach
- Binds persist: `SAC_BINDS_LS = 'sac_binds_v1'` → `{ projKey: { normOrigName: label } }`; `sacLoadProjectBinds()` merge vào `sacBindOverrides` đầu `sacValidateAll` (sau khi lấy `sacCurrentProjectKey()` từ `getActiveProject().name`).
- Propagate: `bindTo`/`sacUnbindSource` lặp `parsedBlocks` theo `sacNorm(_orig)` rồi cập nhật mọi `.sac-blockSrc` row khớp; tách helper `sacApplyBoundVisual()` (bind) + `restoreRow()` (unbind) để DOM mutation đồng nhất.
- Sort: `sacNatCmp()` so khớp từng chunk số/chữ; áp trong `renderSources` sau khi giữ `base[0]` (điểm relevance cao nhất) lên đầu.

---

## v4.8.5 — 2026-06-25

### ✅ Thêm mới / Cải tiến
- **Autocut — hiện đường dẫn source khi match**: mỗi source khớp clip trong bin nay hiện dòng nhỏ `📁 …/folder/clip` (folder chứa nó / tên clip) để xác nhận đúng clip. Áp dụng cho cả validate thường, bind tay (modal 📁) và unbind.
- **Autocut — nút "Về block" sau khi cut xong**: đổi tên "Back to script" → "Về block"; bấm nay trả về **block view** (script editor vẫn thu gọn) thay vì bung lại bảng script.
- **Voice Gen — redesign Create Voice**: bỏ dropdown Method, thay bằng **2 thẻ** Clone Voice / Design Voice (có mô tả). Luồng Clone chia **3 bước progressive**: ① chọn nguồn + Extract/Browse → ② có audio mới hiện nút "Clone this voice" → ③ bấm mới hiện Voice Name + Description + Create.

### 🔧 Kỹ thuật / Approach
- Matched path lookup: dò `sacBinItems` (flat scan có `.parent`/`.name`/`.item`) tìm record có `.item === matchedItem` → label `…/parent/name`; helper `sacMatchedPathLabel()` + `sacSetMatchMsg()` dùng chung cho 3 nhánh "found ✓".
- Clone step machine: `vcRefreshCloneSteps()` reveal/collapse Step 2/3 theo `vcSelectedFilePath`; gọi sau extract/browse (finally) và reset khi đổi tab nguồn. Chỉ dùng attribute `hidden` (tránh `position:fixed`/`grid`/`new Audio()` theo ràng buộc UXP).
- Method picker chuyển từ `<select>` sang 2 `div.vc-choiceCard role=button` + `classList.toggle('is-active')`; segmented tabs = radio ẩn (`display:none`) + `input:checked + span`.

---

## v4.7.1 — 2026-06-16

### ✅ Thêm mới / Cải tiến
- **Autocut — preset thứ tự cột cutsheet**: dropdown cạnh tiêu đề "Script input" cho chọn 1 trong 6 hoán vị thứ tự cột (Script / In→Out / Source). Thứ tự lưu `localStorage` (`sac_col_order`), khôi phục khi mở lại. Paste khối nhiều cột map theo đúng thứ tự đang hiển thị.

### 🐛 Bugs đã fix
- **Đổi preset không cập nhật UI, phải hover chuột mới đổi** — Nguyên nhân: UXP defer **paint** của thay đổi CSS flex `order` (reflow ≠ repaint), chỉ vẽ lại khi vùng bị invalidate (hover/scroll). Cách fix: bỏ `style.order`, **di chuyển cell thật trong DOM** bằng `appendChild` theo `SAC_COL_ORDER` (`sacOrderCells`) — DOM mutation buộc UXP render lại ngay.

### 🔧 Kỹ thuật / Approach
- Đọc input theo **semantic** qua `dataset.colIdx` (`sacInputBySem`) bằng single-class selector `.sac-input` (descendant combinator `.sac-col-x .sac-input` flaky trong UXP) → `parseBlocks`/validate/run/paste đúng cột bất kể vị trí vật lý.
- Reorder cả header lẫn từng row qua cùng `sacOrderCells(container)`; action cell luôn `appendChild` cuối.

---

## v4.2.0-beta.22 — 2026-05-30

### ✅ Thêm mới / Cải tiến
- **SAC Phase 5 Assembly**: Thêm voice panel dưới block list — nút "⚡ Gen voice → Voice Gen", file picker, progress player (play/pause + progress bar + timestamp)
- **`autocut_load` action**: Claude có thể đẩy cutsheet đã tổ chức thẳng vào spreadsheet Autocut (tự switch tab). Nhận `rows[]` dạng SAC-native hoặc cutlist-style (`script/source/sourceIn/sourceOut`)
- **Bin traversal + fuzzy matching**: 3-pass lookup — (1) exact (tolerant extension), (2) prefix word-boundary, (3) folder+clip split ("Senyue 62" → folder "Senyue" / clip "62"). BFS walk toàn project tree qua `ppro.FolderItem.cast()`
- **Folder hint button (📁)**: Mỗi ô Source có nút gợi ý folder từ bin scan gần nhất, reset gate validate khi sửa
- **Unified Run gate**: `sacActionBtn` chỉ hiện khi CẢ HAI pass — structure validated (`sacValidatePassed`) VÀ voice aligned (`sacVoiceReady`)
- **Multi-time zip mode**: Time cell nhiều dòng nay hỗ trợ B1 (zip src theo từng time) lẫn B2 (carry cùng một src cho tất cả times)
- **Collapsible UI**: Spreadsheet section có toggle ▾/▸; Block cards có collapse/expand theo click header
- **Block voice badge**: Mỗi block card có `sac-blockVoiceBadge` (điền sau khi align voice)
- **VoiceGen ⚙ panel**: API Key Profiles + Output Format gom vào panel collapsible (nút ⚙), thay vì luôn hiển thị. Thêm nút "→ Autocut" trên từng variation
- **Screenshot panel**: Thay `<canvas>` + nút "Chọn file ảnh" bằng `<img>` + drop zone clickable toàn bộ
- **`POST /superautocut/voice-align`**: Bridge endpoint mới — Whisper transcribe 1 file audio → align từng block's text → trả `{start, end, duration, matched, status}` per block
- **`push.sh`**: Script build + push tự động lên GitHub (134 lines)
- Bridge version bump: `1.5.0-beta.1` → `1.5.0-beta.3`

### 🐛 Bugs đã fix
- **EL_PROFILES rỗng sau load settings** — Nguyên nhân: migration path cũ không khởi tạo profile nếu `elevenlabsKey` undefined. Cách fix: thêm guard sau `applySettings()` — nếu `EL_PROFILES.length === 0` thì tạo profile Default với `ELEVENLABS_KEY`
- **Multi-time B2: src bị xóa ở row > 0** — Nguyên nhân: logic cũ luôn dùng `i === 0 ? src : ''`. Cách fix: detect `zipSrc = srcLines.length === times.length`, nếu false thì carry `src` cho tất cả rows

### 🔧 Kỹ thuật / Approach
- Bin traversal dùng `ppro.FolderItem.cast(item)` — trả `null` cho clip/sequence (không phải folder), tránh infinite loop; BFS với guard `< 10000`
- `sacNorm()` collapse toàn bộ whitespace (`\s+` → `' '`) — xử lý NBSP và double-space trong tên bin
- `sacCountBinMatches()` đếm distinct matches Pass 1+2 để phát hiện tên ambiguous trước khi validate
- Voice player dùng UXP `uxp.storage` path + `HTMLMediaElement` (không dùng `new Audio()` — unsupported trong UXP)
- `autocut_load` handler trong `ppExecuteAction()` gọi `window.AutocutPushRows()` (exposed từ IIFE SAC module) — tránh coupling trực tiếp vào closure

---

---

## v4.2.0-beta.22 — 2026-05-30

### ✅ Thêm mới
- **Phase 5 Assembly** (`sacRunAutoCut`): ghép source clips lên V1 và voice lên A1 tự động

### 🔧 Kỹ thuật / Approach
- `parseSourceTime("0:02-0:08")` → `{inSec:2, outSec:8}`. Single timestamp (vd `"0:04"`) → default 3s duration
- `sacMakeTime(seconds)` — tạo TickTime cho UXP: thử `ppro.TickTime.fromSeconds()` → fallback `new ppro.TickTime(ticks)` → fallback plain object `{seconds, ticks}`. Cần thiết vì UXP TickTime constructor không nhất quán giữa Premiere versions
- `sacGetSequenceEnd(seq)` — traverse V1 track items với `getClipItems()`, lấy `max(getEnd())` để cursor bắt đầu ngay sau content hiện có, tránh ghi đè
- `sacImportFile(path)` — gọi `project.importFiles([path])` rồi BFS toàn bộ project bin với `sacCollectBinItems()` để tìm lại ProjectItem vừa import (import API không trả về item trực tiếp)
- `sacSetItemPoints(item, inSec, outSec)` — gọi `item.setInPoint(tickTime, 0)` + `item.setOutPoint(tickTime, 0)` với quality=0 (loose) trước mỗi `overwriteClip`. Pattern: set → insert → set → insert cho cùng một source clip nhưng khác in/out
- `sacInsertClipAt(seq, item, atSec, vIdx, aIdx)` — thử `seq.overwriteClip` trước (phổ biến hơn trong UXP), fallback sang `seq.insertClip`. Track index: 0-based, -1 = bỏ qua track loại đó
- Block duration = `max(srcTotal, voiceDuration)` — nếu voice dài hơn video, cursor nhảy đến hết voice (không bỏ sót audio)

---

## v4.2.0-beta.19 — 2026-05-xx

### ✅ Thêm mới
- **Phase 4a Voice Pipeline**: file picker + transcribe/align + mini player + cross-tab VoiceGen→Autocut
- **Phase 3 Source Validation**: bin search 3-pass, sacSourceMap, folder/clip matching
- **Phase 2 Screenshot Parser**: bridge endpoint `/superautocut/parse-image` (Claude Vision)

### 🔧 Kỹ thuật / Approach
- Voice align: POST `/superautocut/voice-align` với `{audioPath, blocks:[{texts}]}` → bridge chạy Whisper + match text → trả `alignments[i].{start, end, duration, status}`
- Bin search 3-pass: (1) exact match ext-tolerant, (2) prefix + boundary char `[\s._-]`, (3) folder+clip split — xử lý case cutsheet "Senyue 70" = folder "Studio Senyue" + clip "70.MOV"
- UXP audio playback: không dùng `new Audio()` (unsupported) — dùng bridge endpoint `/tts/play` (afplay) + DOM timer để update progress bar
- Cross-tab: `window.AutocutPushVoice(path)` và `window.VoiceGenPushScript(text)` — expose qua `window` vì các module là separate IIFE, không share scope

### 🐛 Bugs fixed
- **`.hidden` attribute không hoạt động trong UXP** — Nguyên nhân: UXP Chromium không hỗ trợ HTML `hidden` attribute trên custom elements. Cách fix: thay bằng `el.style.display = 'none'/'flex'`
- **TSV paste multi-line cells** — Nguyên nhân: Google Sheets wrap cell có `\n` trong double-quotes, naive split('\n') phá vỡ. Cách fix: viết parser TSV đầy đủ theo spec (state machine: inQ flag, escaped quote `""`)
- **Block section không scroll được** — Nguyên nhân: UXP flex container cần `flex:1 1 0; min-height:0; overflow-y:auto` trên *inner child*, không phải container. Cách fix: thêm wrapper div với đúng pattern

---

## v4.1.39 — 2026-05-xx

### ✅ Thêm mới
- Phase 1 SAC: Spreadsheet UI + block parsing, TSV paste từ Google Sheets

### 🔧 Kỹ thuật
- Multi-row paste: intercept `paste` event trên bất kỳ input nào trong bảng, detect `\n` trong clipboard → parse toàn bộ, clear bảng, re-render
- Expand rows: multi-line text cell → split thành nhiều rows (first row giữ time+src); multi-timestamp cell (`"0:04 0:07 0:13"`) → split thành rows riêng, mang theo src name

---

## v4.1.38 — 2026-05-xx

### ✅ Thêm mới
- Manual "Check for updates" button trong Settings
- Plugin auto-update via Creative Cloud (CCX format)
- Bridge app kiểm tra cả Bridge + Plugin updates đồng thời

### 🔧 Kỹ thuật
- Update check: fetch Gist JSON `{version, downloadUrl, bridgeVersion, bridgeDownloadUrl}`, so sánh với version đang chạy
- CCX install: download → spawn `open file.ccx` → macOS tự mở Creative Cloud installer
- `update-gist.sh`: dùng `jq` để build JSON payload tránh double-encoding khi push lên GitHub Gist

---

## v4.1.36 — 2026-05-xx

### ✅ Thêm mới
- Voice Clone: lấy audio từ A1 track trong sequence → extract qua ffmpeg → clone voice qua ElevenLabs

### 🔧 Kỹ thuật
- Đọc A1 track: thử Path A `seq.trackGroup(MEDIATYPE_AUDIO).getTrack(0)` trước, fallback Path B `seq.getAudioTrack(0)` (Premiere version compatibility)
- Extract audio segments: `getInPoint()`/`getOutPoint()` → ffmpeg `-ss {in} -to {out} -c copy` cho từng clip → concat với filter_complex
- `vcGetTrackItemFilePath`: thử `getProjectItem()` → `ClipProjectItem.cast()` → `getMediaFilePath()`, 3 fallback paths vì UXP API không nhất quán

---

## v4.1.x — earlier

### 🔧 UXP Constraints đã học được
- `position:fixed` → không hoạt động, dùng flex layout
- `display:grid` → không hoạt động, dùng flex
- `window.innerWidth` → không hoạt động
- `title=""` attribute → không render tooltip
- `new Audio()` → không hoạt động, dùng bridge `/tts/play`
- `keypress` event → không fire, dùng `keydown`
- `textarea rows/cols` → bị ignore, dùng CSS height
- Scrolling: `overflow-y:auto` phải đặt trên inner child với `flex:1 1 0; min-height:0`, không phải flex container
- Tất cả Premiere API async: `getStart()`, `getEnd()`, clip name, track count đều phải `await`
- Keyboard focus: `window.claimKeyboard()` / `window.releaseKeyboard()` trên focus/blur của mọi input
- ES Modules: không dùng — `main.js` là non-module script

---
