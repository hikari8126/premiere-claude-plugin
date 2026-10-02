# QC fixes — Run 1 (chạy hẹn giờ 2026-10-03 ~01:04)

> **For agentic workers:** làm inline theo thứ tự, mỗi mục: đọc code thật → sửa tối thiểu → test (Node test nếu là logic thuần, nếu không thì `node -e new vm.Script` cho syntax) → commit riêng. Không đổi giao diện (không thêm/bớt nút, không đổi luồng bấm); chỉ chặn / sửa hành vi sai và thêm thông báo chữ ở chỗ đã có ô trạng thái. Thay đổi UI để dành cho danh sách đề xuất cuối.

Nguồn: `docs/qc/2026-10-03-qc-review.md` (mã lỗi S*, A*, F*, VG*, ST*, UN*, W*, R*).
Nhánh: `qc/review-features` (đã chứa fix AE `/Volumes/<ổ>` ở commit d25e82b). Không push, không ship.
Version: plugin `v5.15.1-beta.1` (manifest `5.15.1`), bridge `1.22.1-beta.1` (đã đặt), Bridge app sẽ lên 3.19 khi ship (S1, S3 sửa main.swift).

## Bước 0 — chuẩn bị
- `git checkout qc/review-features`, `git status` sạch.
- `cd bridge && npm test` (watchfolder-find chập chờn từ trước — chạy lại riêng nếu fail).

## Đợt khẩn (an toàn dữ liệu)

1. **S1 — "Khởi động lại Bridge" giết Premiere** — `bridge-app/main.swift:487, 587`.
   Thay `lsof -ti :PORT | xargs kill -9` bằng: lấy PID đang LISTEN (`lsof -nP -t -iTCP:PORT -sTCP:LISTEN`), chỉ kill PID có lệnh `node … server.js` (`ps -o command= -p PID`); SIGTERM trước, chờ ~1s, còn sống mới SIGKILL. Viết thành một hàm shell dùng chung cho cả 2 chỗ. Build thử: `swiftc` theo cách `bridge-app/build-app.sh` compile (hoặc chạy build-app.sh rồi kiểm "Swift compiled"). Kiểm: `lsof -nP -t -iTCP:3030 -sTCP:LISTEN` không ra PID Premiere.
2. **UN1 — Un-nest disable mọi clip đang chọn** — `plugin/main.js:13707, 14325, 14343-14361`.
   Chỉ disable `detected[i].item` (+ item linked của nó) khi `expandViaClone` của nested đó trả > 0. Clip không phải nested không bao giờ bị disable. Gộp các disable vào MỘT transaction (một phần của UN3).
3. **W2 — Watch fallback theo tên** — `plugin/watch.js:427-431`.
   Bỏ `|| after.filter(x => x.name === name)[0]`. Tìm item theo media path; dùng snapshot trước/sau mẻ import (`ppSnapshotBinKeys` / `ppPickImportedByPath` ở main.js đã có). Không tìm thấy → ack `failed` kèm lý do, không `done`.
4. **W6 — bảng duyệt tick lại file đã bỏ tick** — `plugin/watch.js:362`: `box.checked = r.checked !== false;`.
5. **F3 — Autocut chạy trùng** — `plugin/main.js:5677-5680, 7401`.
   Cờ `sacRunBusy`; khi đang chạy: bỏ qua click, thêm class `is-disabled` cho `#sacCutThis` + `#sacCutNew`, status "Đang dựng…"; reset trong `finally`. Trang Auto gọi `sacRunAutoCut` tuần tự — không được chặn nhầm luồng đó (cờ chỉ chặn lượt chồng).
6. **ST1 — Tạo Sub đổi sequence giữa chừng** — `plugin/main.js:12904-12916, 12879-12891, 13030, 13051`.
   Chụp `{seq, seqName, basename, voFolder}` ngay khi bấm (trước Whisper); `stFinalize`/`stResolveOutputPath` dùng bản chụp, không gọi lại `getActiveSequence`. Sequence đang mở khác lúc ghi → vẫn ghi theo bản chụp, status ghi rõ tên sequence.

## P1 sửa logic (không đổi UI)

7. **A2 — `sacRunAutoCut` nuốt lỗi** — `main.js:7685-7688, 7529-7533, 6755-6766`. Trả `{ok, error, placed, failed, voiceOk}`; `autoStage3` chỉ đánh `built` khi `ok && voiceOk`, còn lại `warn` + `job.error` (tổng kết hiện lỗi ở A7 là UI — để danh sách đề xuất, nhưng ghi `job.error` ngay).
8. **F1 — ambiguous lọt skip-gate** — `main.js:4511-4529`. Gate coi source có `srcBaseKind==='ambiguous'` chưa bind là chưa resolved (đồng bộ với `sacValidateAll` 5108-5112).
9. **F2 — bind tay khớp lại theo tên** — `main.js:4386-4395, 3990, 2879-2899`. Lưu thêm media path khi bind; validate: override có media path → resolve theo path trước, không khớp lại theo tên. Giữ tương thích bind cũ (chỉ có nhãn).
10. **VG2 — lỗi giữa chừng bỏ phần đã gen** — `bridge/server.js:1075-1129` (variation 2 lỗi → vẫn trả variation 1 + `errors`), `main.js:8656-8692` (multi-speaker: render + đẩy history phần đã có rồi mới báo lỗi). Có test cho bridge nếu tách được hàm.
11. **VG1 — timeout 2 phút** — `main.js:8604, 8613`: timeout riêng 10 phút cho `/music/generate`, `/voice/change`, `/tts/generate` (giữ 2 phút cho call ngắn). Không đổi kiến trúc job.
12. **ST3 — cờ Tạo Sub không gắn với script** — `main.js:13056, 13125-13127, 13281-13287, 12856`. Lưu hash nội dung ô script khi set `stSplitReady/stOrganized/stTimedCues`; lúc bấm nếu hash khác → reset cờ, chạy full pipeline. `SubtextSetScript` reset cờ.
13. **ST2 — "AI ngắt câu → Tạo Sub" không cảnh báo sai script** — `main.js:13092-13106`: đánh giá `stDiagText(d.diag)`; `warn`/`matchPct<40` → status đỏ "⛔ SCRIPT KHÔNG KHỚP" như `stOrganize` (cùng ô status, không thêm UI).
14. **W1 — đổi project mất snapshot/hàng đợi** — `bridge/watchfolder.js:46-70`, `watchfolder-store.js`. State theo project: `byProject[prproj] = {byWatch, queue, dead}`; migrate file state cũ. Test bằng engine + store giả (đã có mẫu trong `bridge/test/watchfolder-engine.test.js`).
15. **S3 — Bridge không khởi động khi chưa đăng nhập Claude** — `bridge-app/main.swift:331-458`. Luôn `startBridge()` trước; kiểm đăng nhập chạy song song, chỉ hiện trạng thái/popup, không chặn.

## Việc riêng (chỉ khi điều kiện đúng)
- **Cứu FX.aep**: nếu `isAeRunning()` = false: backup `…/AeriSoft/Videos/Editing File/FX.aep` vào `~/Library/Application Support/ClaudeBridge/rename/aep-backup/manual-<ts>/`, rồi `relinkAepFile(file, buildMap(pairs), backupDir)` (bridge/aep-relink.js, cần fix d25e82b) với cặp đã chuẩn bị ở `~/Library/Application Support/ClaudeBridge/rename/fx-aep-repair-pairs.json` (9 file → kỳ vọng `replaced: 11`). Kiểm từng `newPath` còn tồn tại trước khi ghi. Kiểm đọc lại: không còn footage offline trong `AeriSoft_Senyue_Raw Footage_20250825` và `Studio 2/OUTPUT`. AE đang mở → bỏ qua, ghi vào báo cáo.

## Kết thúc
- `cd bridge && npm test`; `bash dev.sh` dựng lại bản DEV (chỉ kiểm panel nạp được, không chạy thao tác sửa project thật).
- Bump `PLUGIN_VERSION 'v5.15.1-beta.1'` + manifest `5.15.1`; CHANGELOG mục `v5.15.1-beta.1` liệt kê mã lỗi đã sửa.
- Cập nhật `docs/qc/2026-10-03-qc-review.md`: đánh dấu ✅ mục đã sửa.
- Báo cáo cho user (tiếng Việt): đã sửa gì, test gì, gì cần user kiểm trong Premiere (UN1, F3, ST1, W2, A2 không chạy thật được), và **danh sách đề xuất UI cần duyệt** cho đợt 2: S2 (trạng thái bridge lên version bar), S4 (banner "cần Bridge ≥ X"), S5 (Settings Save/Cancel), S11 (chữ bridge offline thống nhất), A7/A9/A10, F12, VG6/VG8, ST4/ST7, UN4, W5/W9, R3.
