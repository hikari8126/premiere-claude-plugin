# Batch Rename + Relink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tab WATCH đổi tên hàng loạt file source trên đĩa, relink clip Premiere + đổi tên hiển thị, relink `.aep` trong thư mục sản phẩm, có hoàn tác.

**Architecture:** Logic thuần ở `plugin/rename-core.js` (global `RNC`, ES5, test bằng Node). Bridge giữ mọi thao tác đĩa: `bridge/rename-ops.js` (kiểm tra tên, đổi tên 2 pha, nhật ký) và `bridge/aep-relink.js` (đọc/ghi RIFX). Plugin `plugin/rename.js` lấy selection, gọi bridge, relink bằng `changeMediaFilePath` + `createSetNameAction`.

**Tech Stack:** UXP classic script (ES5 trong core, async/await trong rename.js như resize.js), Node ≥18 + Express, `node:test`/`assert`.

Spec: `docs/superpowers/specs/2026-10-02-batch-rename-relink-design.md`

---

## File map

| File | Trách nhiệm |
|---|---|
| `plugin/rename-core.js` (mới) | `splitExt`, `natCmp`, `padWidth`, `renderName`, `nameError`, `groupByPath`, `sortRows`, `moveRow`, `buildPreview` |
| `plugin/rename.js` (mới) | mục trong tab Watch + modal `#rnModal`, selection → rows, gọi bridge, relink/đổi tên, hoàn tác |
| `bridge/rename-ops.js` (mới) | `nameError`, `planRows`, `applyRenames`, nhật ký (`loadJournal`/`saveJournal`/`clearJournal`) |
| `bridge/aep-relink.js` (mới) | `rewriteAep`, `countAepMatches`, `findAepFiles`, `relinkAepFile`, `isAeRunning` |
| `bridge/server.js` | 6 route `/rename/*`, BRIDGE_VERSION |
| `plugin/index.html`, `plugin/styles.css` | mục gập/mở + modal + nạp script |
| `plugin/main.js` | PLUGIN_VERSION beta |
| `bridge/test/rename-core.test.js`, `rename-ops.test.js`, `aep-relink.test.js`, `rename-endpoints.test.js` (mới) | test |
| `CLAUDE.md`, `CHANGELOG.md` | bảng endpoint, changelog |

## Interfaces chốt

```
RNC.splitExt('a.b.MOV') → {base:'a.b', ext:'.MOV'};  splitExt('.x') → {base:'.x', ext:''}
RNC.padWidth(start, count) → max(2, digits(start+count-1))
RNC.renderName(tpl, {bin, n, name}, width) → string (đã trim, n đệm 0)
RNC.nameError(fileName) → '' | lý do
RNC.groupByPath(entries[{path, bin, item, name}]) → rows[{path, oldName, bin, items[]}]
RNC.sortRows(rows) → bản sao đã sắp natCmp theo oldName
RNC.moveRow(rows, i, dir) → bản sao đổi chỗ i với i+dir
RNC.buildPreview(rows, tpl, start) → [{path, oldName, newName, error, same}]  // trùng lượt so lowercase

ops.planRows(rows[{oldPath,newName}]) → [{oldPath,newPath,newName,error,same}]
ops.applyRenames(pairs[{oldPath,newPath}]) → {ok, error?}   // 2 pha, lỗi → tự đổi về
ops.loadJournal(projectPath) / saveJournal(projectPath, batch) / clearJournal(projectPath)
  batch = {batchId, time, projectPath, rows:[{oldPath,newPath}], aepSelected:[path], aep:[{path,count,ok,error}]}

aep.rewriteAep(buf, map{oldNFC→new}) → {buf, replaced, renamed}  // throw khi kiểm tra sai
aep.countAepMatches(buf, set{oldNFC}) → n
aep.findAepFiles(root, {maxDepth:6, timeoutMs:30000}) → Promise<{files, timedOut}>
aep.relinkAepFile(file, map, backupDir) → {ok, replaced, error?}
aep.isAeRunning() → bool
```

### Task 1: rename-core.js (TDD)

**Files:** Create `plugin/rename-core.js`, `bridge/test/rename-core.test.js`

- [ ] Test: splitExt (đuôi hoa giữ nguyên, nhiều dấu chấm, dotfile, không đuôi); natCmp (`IMG_2` < `IMG_10`); padWidth (1,5→2; 1,120→3; 95,10→3); renderName (`{bin}_{n}` → `Higg_01`; `{name} v2`; token lạ giữ nguyên; trim); nameError (rỗng, `/`, `:`, control, bắt đầu `.`, >255 byte UTF-8, OK với tiếng Việt); groupByPath (2 entry cùng path → 1 row 2 items, giữ thứ tự gặp đầu); buildPreview (đánh số theo thứ tự, trùng lượt hoa/thường → error cả 2 dòng, same khi tên mới = tên cũ, ext giữ nguyên).
- [ ] Chạy `node bridge/test/rename-core.test.js` → FAIL (module chưa có).
- [ ] Viết module ES5, export như resize-core.js.
- [ ] Chạy lại → PASS. Commit `feat(rename): rename-core — mẫu tên, đánh số, kiểm tra trùng`.

### Task 2: rename-ops.js (TDD)

**Files:** Create `bridge/rename-ops.js`, `bridge/test/rename-ops.test.js`

- [ ] Test trong `fs.mkdtempSync`: planRows (file cũ không có → error; tên xấu → error; đích tồn tại ngoài lượt → error; đích là file cũng đổi đi trong lượt → OK; đổi chỉ hoa/thường cùng inode → OK; trùng lượt → error; same); applyRenames hoán đổi `a↔b` đúng nội dung; lỗi pha 2 (đích là thư mục chiếm chỗ được tạo sau plan) → mọi file về tên cũ, không còn file `.rn-tmp-`; journal save/load/clear dùng `RENAME_DIR`.
- [ ] FAIL → viết module → PASS. Commit `feat(rename): bridge đổi tên 2 pha + nhật ký`.

### Task 3: aep-relink.js (TDD)

**Files:** Create `bridge/aep-relink.js`, `bridge/test/aep-relink.test.js`

- [ ] Test với `.aep` giả dựng trong test: `RIFX` + `Egg!` + `LIST Fold` → `Item`(Utf8 'a.mov', `Pin `→`Als2`→`alas`) + `Item`(folder, Utf8 'Bin', `Sfdr` → `Item`(Utf8 '', alas b.mov) → `Sfdr` → `Item`(Utf8 'Custom', alas c.mov)) + chunk lẻ độ dài (đệm) + trailer XMP. Kiểm: không map → buffer giống hệt; map cả 3 → replaced 3, Utf8 'a.mov'→tên mới, '' giữ '', 'Custom' giữ; trailer giữ; parse lại đếm đúng; Utf8 của Item folder cha không đổi; NFD trong file khớp map NFC; countAepMatches; relinkAepFile ghi backup + đè an toàn; findAepFiles bỏ `Auto-Save`, thư mục ẩn, quá sâu. Nếu env `AEP_SAMPLE` trỏ file thật: rewrite rỗng → giống hệt từng byte.
- [ ] FAIL → viết module → PASS. Chạy thêm với 2 sample thật trong scratchpad. Commit `feat(rename): relink .aep — duyệt RIFX một lượt, cả footage trong folder`.

### Task 4: endpoints

**Files:** Modify `bridge/server.js` (trước khối `if (require.main === module)`), Create `bridge/test/rename-endpoints.test.js`

- [ ] Test (PORT 3032, `RENAME_DIR` tạm): plan → apply → journal → aep (dùng `.aep` giả trong thư mục sản phẩm tạm) → revert một dòng → undo; plan có lỗi → apply 400 không đổi file nào.
- [ ] Viết route: `/rename/plan`, `/rename/apply`, `/rename/revert`, `/rename/aep`, `GET /rename/journal`, `/rename/undo`. `isAeRunning` cho phép override qua `RENAME_FAKE_AE` trong test.
- [ ] PASS + `npm test` toàn bộ. Commit `feat(rename): endpoints /rename/*`.

### Task 5: UI + rename.js

**Files:** Create `plugin/rename.js`; Modify `plugin/index.html` (mục trong `#tab-watch` sau `.wf-actions`, modal `#rnModal` sau `#wfCmpModal`, `<script>` sau watch.js), `plugin/styles.css`

- [ ] Mục gập/mở `#rnSection`: nút `#rnPick` "Lấy clip đang chọn", `#rnUndo` (ẩn khi không có lượt), dòng `#rnLast`.
- [ ] Modal: `#rnTpl` (input), `#rnStart`, `#rnList` (dòng: ↑ ↓, tên cũ → tên mới, lý do), `#rnAepList` + `#rnAeWarn` + `#rnRescan`, cảnh báo cố định, `#rnStatus`, `#rnGo`.
- [ ] Selection: `ProjectUtils.getSelection` → bin thì đệ quy (`sacCollectBinItems` trên bin), clip lấy `getMediaFilePath`, bỏ qua kèm lý do (sequence/không path/offline/không đổi path được).
- [ ] Đổi mẫu/số → `RNC.buildPreview` (debounce 250ms) → `/rename/plan` để lấy lỗi phía đĩa + danh sách `.aep`.
- [ ] Go: `/rename/apply` → quét cả project lấy mọi clip có path trong lượt → `changeMediaFilePath` → lỗi thì `/rename/revert` + relink các item đã đổi về → một transaction `createSetNameAction` → `/rename/aep` → báo kết quả + log Watch.
- [ ] Undo: `/rename/journal` lúc mở tab/đổi project; `/rename/undo` → relink newPath→oldPath, đổi tên hiển thị về khi đang bằng tên mới.
- [ ] Commit `feat(rename): mục Đổi tên source hàng loạt trong tab Watch`.

### Task 6: version + docs + live check

- [ ] `PLUGIN_VERSION 'v5.14.0-beta.1'`, `BRIDGE_VERSION '1.22.0-beta.1'`, `manifest.json` 5.14.0, CHANGELOG, bảng endpoint trong CLAUDE.md.
- [ ] `bash dev.sh` dựng bản DEV; kiểm tra panel nạp không lỗi console; dò API `changeMediaFilePath`/`canChangeMediaPath`/`isOffline` (chỉ đọc).
- [ ] Commit `chore(rename): v5.14.0-beta.1`.
