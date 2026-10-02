# Raw-cutter → UXP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đưa Raw-cutter (xmlcut 3.93 của mill2nn — CEP panel + ExtendScript + engine Python) vào plugin này thành tab **Raw-cutter**, đủ mode **Both** (Source Render → `<version>/raw/`, Timeline Render → `<version>/edited/`).

**Architecture:** Engine `xmlcut.py` giữ nguyên, nằm trong bridge (`bridge/rawcut-engine/`), bridge spawn nó và stream tiến độ qua SSE. Plugin UXP thay `host.jsx`: đọc sequence thành *dump JSON* đúng schema cũ, export FCP XML bằng `ProjectConverter`, render từng cut bằng `EncoderManager.exportSequence`. Bridge không biết Premiere, plugin không spawn process — toàn bộ phần engine test được bằng Node + ffmpeg mà không cần mở Premiere.

**Tech Stack:** Node + Express (CommonJS, không thêm dependency), Python 3.8+ stdlib (engine có sẵn), ffmpeg/ffprobe, UXP Premiere API ≥ 26.3 (classic script, không ES module). Test: `node:assert` chạy `node test/x.test.js` như các test sẵn có.

**Nguồn tham chiếu:** bản clone `mill2nn/xmlcut-releases` v3.93 — `app/xmlcut.py`, `app/panel/jsx/host.jsx`, `app/panel/client/main.js`, `app/README.md`. Ký hiệu `H<line>` = host.jsx, `M<line>` = main.js của bản đó.

---

## Lộ trình — 4 plan con

| # | Plan | Phụ thuộc | Trạng thái chi tiết |
|---|---|---|---|
| 0 | **Spike API UXP** trong Premiere (console UXP Dev Tool, không ship code) | — | Chi tiết đầy đủ bên dưới |
| 1 | **Bridge chạy engine**: vendor engine, tìm python, argv, protocol, runner, lưu lần đọc, cache render, preset `.epr`, 6 endpoint, đóng gói | — (song song với 0) | Chi tiết đầy đủ bên dưới |
| 2 | **Lớp Premiere của plugin** (`rawcut-core.js` thuần + `rawcut-ppro.js`): dump, XML, fingerprint, render từng cut | Kết quả Plan 0 | Khung task bên dưới; viết code chi tiết sau khi có kết quả spike (tên method UXP quyết định code) |
| 3 | **Tab UI** (`rawcut.js` + HTML/CSS): Read → bảng clip → Both export → báo cáo → Retry | Plan 1 + 2, **user duyệt phạm vi UI** | Khung task bên dưới |
| 4 | **Release beta**: version, CHANGELOG, CLAUDE.md, build | 1–3 | Khung task bên dưới |

### Quyết định đã chốt

- **Engine là của mình:** copy nguyên `xmlcut.py` v3.93, không theo upstream nữa. Lần đầu **không sửa dòng nào** — mọi khác biệt nằm ở caller. Tên file **phải giữ chữ `xmlcut`**: engine nhận ra lock còn sống bằng cách tìm `xmlcut` trong command line của pid giữ lock (`take_run_lock`, xmlcut.py ~8097).
- **Bỏ hẳn** phần bảo trì của CEP: self-update/repair, tìm engine, changelog popup, POC render, gear menu, mirror localStorage (B.2 trong báo cáo khảo sát).
- **Mỗi lần gọi engine là một request riêng.** Plugin điều phối chuỗi Both: `export raw` → plugin render → `export edited`. Cancel = đóng request (XHR abort) → bridge giết cả process group.
- **Không còn file `_render_progress.json` / `_render_stop`**: vòng render chạy trong plugin, tiến độ và Cancel là biến JS.
- **Thư mục xuất (user chốt 2026-10-01):** giữ quy ước sản phẩm như bản CEP — tự nhận sản phẩm từ SAMX_WORKSPACE → `<Sản phẩm>/Output/ACT/<vN>/raw|edited`, vN đọc từ tên sequence, từ chối khi version đó thuộc sequence khác; không nhận ra sản phẩm → chọn thư mục → `<thư mục>/<vN>/raw|edited`.
- **Phạm vi bản đầu (user chốt):** luồng chính + **Audio** (MP3 voice-over, file từng track, track nghe trong render) + **Chất lượng** (CRF, scale, fps, preset đã lưu) + **Chống timeline bị sửa** (fingerprint). **Không** làm: ước dung lượng, relink `--remap`, size probe.
- **Spike Plan 0:** user chọn "chạy toàn bộ, review cuối" → không dừng chờ spike. Plan 2 dò API phòng thủ (thử nhiều tên method như `stProbeTimes` main.js:12405, log rõ cái nào thiếu); snippet spike giữ lại để chẩn đoán khi review.
- **Premiere < 26.3** (không có `ProjectConverter`) vẫn chạy được ở chế độ *dump-only*, nhưng nested sequence bị bỏ qua — UI phải nói rõ.

### Đã kiểm chứng trên máy dev (2026-10-01)

Engine 3.93 + `/usr/bin/python3` 3.9.6 + ffmpeg Homebrew, với dump JSON viết tay (không XML):
- `xmlcut.py dump.json -o scan --manifest-only` → exit 0, 2 cut `cuttable`.
- `xmlcut.py dump.json -o out --transitions split` → 2 file `01_(00.40-01.40)_src.mp4`…, stdout đúng protocol `>>` / `[n/N] OK`.
- `--manifest-only --render-planned --video-track 1` → clip có `timeline_in_frames`/`timeline_out_frames` = `0/25`, `25/50`.
- File render giả `video-1-0-25.mp4`, `video-1-25-50.mp4` + `--render-dir` → engine cắt `edited/` từ render, exit 0.
- `--pick` với `cut_id` lấy từ manifest → chỉ cắt đúng 1 clip.

Preset gốc có sẵn ở `/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/MediaIO/systempresets/4E49434B_48323634/00 - Match Source - High bitrate.epr`.

---

## Plan 0 — Spike API UXP (chạy trong Premiere, ~30 phút)

Mục đích: biết chắc tên method UXP trước khi viết Plan 2. Không commit code nào. Người chạy: user (cần Premiere + UXP Developer Tool), Claude đọc kết quả.

**Chuẩn bị:** Premiere 2026 (26.3+), project test có 1 sequence 25fps gồm: V1 vài clip thường, 1 clip đổi speed 200%, 1 clip reverse, 1 clip disabled, 1 clip có Time Remapping keyframe, V2 có 1 title/clip; plugin đang Load trong UXP Developer Tool → **Debug** → tab Console.

### Task 0.1: Dò API đọc clip

- [ ] **Step 1: Dán snippet vào Console, Enter**

```js
(async () => {
  const ppro = require('premierepro');
  const un = async v => (v && typeof v.then === 'function') ? await v : v;
  const has = (o, k) => !!o && typeof o[k] === 'function';
  const show = v => (v && v.ticks !== undefined) ? (String(v.ticks) + ' ticks') : v;
  const out = {};
  const proj = await ppro.Project.getActiveProject();
  const seq = await proj.getActiveSequence();
  out.seq = { name: seq.name, guid: String(seq.guid) };
  for (const k of ['getTimebase', 'getFrameSize', 'getEndTime', 'getInPoint', 'getOutPoint', 'getVideoTrackCount', 'getAudioTrackCount', 'getSettings', 'createSetInPointAction', 'createSetOutPointAction']) {
    if (!has(seq, k)) { out.seq[k] = '—'; continue; }
    if (/^create/.test(k)) { out.seq[k] = 'có'; continue; }
    try { const v = await un(seq[k]()); out.seq[k] = (v && v.width !== undefined) ? (v.width + 'x' + v.height) : show(v); } catch (e) { out.seq[k] = 'ERR ' + e.message; }
  }
  out.TickTime = ['createWithTicks', 'createWithSeconds', 'createWithFrameAndFrameRate'].filter(k => has(ppro.TickTime, k));
  const vt = await seq.getVideoTrack(0);
  out.track = ['isMuted', 'setMute', 'getTrackItems', 'getIndex'].map(k => k + ':' + (has(vt, k) ? 'có' : '—'));
  const items = await vt.getTrackItems(1, false);
  out.clips = [];
  for (const it of items.slice(0, 6)) {
    const c = {};
    for (const k of ['getName', 'getStartTime', 'getEndTime', 'getInPoint', 'getOutPoint', 'getSpeed', 'isSpeedReversed', 'isDisabled', 'isAdjustmentLayer', 'getMediaType', 'getType']) {
      if (!has(it, k)) { c[k] = '—'; continue; }
      try { c[k] = show(await un(it[k]())); } catch (e) { c[k] = 'ERR ' + e.message; }
    }
    try {
      const cpi = ppro.ClipProjectItem.cast(await un(it.getProjectItem()));
      c.mediaPath = await un(cpi.getMediaFilePath());
      c.nodeId = cpi.getId ? await un(cpi.getId()) : (cpi.id || '—');
      for (const k of ['isOffline', 'isSequence', 'isMulticamClip']) {
        try { c[k] = has(cpi, k) ? await un(cpi[k]()) : '—'; } catch (e) { c[k] = 'ERR ' + e.message; }
      }
      if (has(cpi, 'getFootageInterpretation')) {
        const fi = await un(cpi.getFootageInterpretation());
        c.interp = {};
        for (const k of ['getFrameRate', 'getPixelAspectRatio', 'getFieldType', 'getRemovePulldown', 'getAlphaUsage']) {
          try { c.interp[k] = has(fi, k) ? await un(fi[k]()) : '—'; } catch (e) { c.interp[k] = 'ERR ' + e.message; }
        }
      } else c.interp = '—';
    } catch (e) { c.projectItem = 'ERR ' + e.message; }
    try {
      const ch = await un(it.getComponentChain());
      const n = await un(ch.getComponentCount());
      c.components = [];
      for (let i = 0; i < n; i++) {
        const co = await un(ch.getComponentAtIndex(i));
        const row = { match: await un(co.getMatchName()), disp: await un(co.getDisplayName()) };
        if (/time ?remap/i.test(row.match + ' ' + row.disp) && has(co, 'getParamCount')) {
          row.params = [];
          const pn = await un(co.getParamCount());
          for (let j = 0; j < pn; j++) {
            const p = await un(co.getParam(j));
            const pr = { name: p.displayName };
            try { pr.timeVarying = has(p, 'isTimeVarying') ? await un(p.isTimeVarying()) : '—'; } catch (e) { pr.timeVarying = 'ERR ' + e.message; }
            try { pr.keys = has(p, 'getKeyframeListAsTickTimes') ? (await un(p.getKeyframeListAsTickTimes())).length : '—'; } catch (e) { pr.keys = 'ERR ' + e.message; }
            row.params.push(pr);
          }
        }
        c.components.push(row);
      }
    } catch (e) { c.components = 'ERR ' + e.message; }
    out.clips.push(c);
  }
  console.log(JSON.stringify(out, null, 1));
})();
```

- [ ] **Step 2: Copy toàn bộ JSON in ra, gửi lại cho Claude**

Câu hỏi spike này phải trả lời được (ghi kết quả vào cuối file plan này, mục "Kết quả spike"):
1. Đọc được speed / reverse / disabled / adjustment layer bằng method nào?
2. Có frame rate interpret (`getFootageInterpretation().getFrameRate()`) không?
3. Time Remapping có hiện trong component chain không, có đếm được keyframe không? (Không có → dump ghi `has_keyframed_remap:false`, engine chỉ mất cảnh báo "speed_varies".)
4. Có `TickTime.createWithTicks` không? (Có → set in/out bằng tick đúng tuyệt đối, khỏi làm 4 cách như `setRange` H1277.)
5. `nodeId` của project item lấy từ đâu (dùng cho fingerprint)?

### Task 0.2: Dò render từng khoảng

- [ ] **Step 1: Dán snippet (sửa `PRESET` nếu Premiere cài ở chỗ khác)**

```js
(async () => {
  const ppro = require('premierepro');
  const fsu = require('uxp').storage.localFileSystem;
  const un = async v => (v && typeof v.then === 'function') ? await v : v;
  const PRESET = '/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/MediaIO/systempresets/4E49434B_48323634/00 - Match Source - High bitrate.epr';
  const TPS = 254016000000;
  const proj = await ppro.Project.getActiveProject();
  const seq = await proj.getActiveSequence();
  const tb = Number(String(await un(seq.getTimebase())));
  const tt = f => ppro.TickTime.createWithTicks ? ppro.TickTime.createWithTicks(String(f * tb)) : ppro.TickTime.createWithSeconds(f * tb / TPS);
  const tmp = (await fsu.getTemporaryFolder()).nativePath;
  const em = ppro.EncoderManager.getManager();
  const origIn = await seq.getInPoint(), origOut = await seq.getOutPoint();
  const setIO = async (a, b) => {
    let err = null;
    const r = proj.lockedAccess(() => {
      try { proj.executeTransaction(ca => { ca.addAction(seq.createSetInPointAction(a)); ca.addAction(seq.createSetOutPointAction(b)); }, 'RC spike in/out'); } catch (e) { err = e; }
    });
    if (r && r.then) await r;
    if (err) throw err;
  };
  // Thử mute V2 để xem setMute/isMuted trên track video có đọc lại được không
  const v2 = await seq.getVideoTrack(1);
  const muteBefore = v2 ? await un(v2.isMuted()) : null;
  if (v2) await un(v2.setMute(true));
  const muteAfter = v2 ? await un(v2.isMuted()) : null;
  const res = { tb, fps: TPS / tb, muteBefore, muteAfter, ranges: [] };
  try {
    for (const [a, b] of [[0, 25], [25, 60], [60, 61]]) {
      await setIO(tt(a), tt(b));
      const gi = await seq.getInPoint(), go = await seq.getOutPoint();
      const file = tmp + '/rc-spike-' + a + '-' + b + '.mp4';
      const t0 = Date.now();
      let ok, err = null;
      try { ok = await em.exportSequence(seq, ppro.Constants.ExportType.IMMEDIATELY, file, PRESET, false); } catch (e) { err = e.message || String(e); }
      res.ranges.push({ a, b, ok, err, ms: Date.now() - t0, file, wantIn: String(a * tb), gotIn: String(gi.ticks), wantOut: String(b * tb), gotOut: String(go.ticks) });
    }
  } finally {
    await setIO(origIn, origOut);
    if (v2) await un(v2.setMute(!!muteBefore));
  }
  console.log(JSON.stringify(res, null, 1));
})();
```

- [ ] **Step 2: Gửi JSON cho Claude; Claude đếm frame từng file**

Run (Claude chạy, thay `<tmp>` bằng thư mục `file` trong JSON):
```bash
for f in <tmp>/rc-spike-*.mp4; do echo "$f $(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$f")"; done
```
Expected: `rc-spike-0-25` = 25 frame, `25-60` = 35, `60-61` = 1. `gotIn === wantIn`, `gotOut === wantOut`. `muteAfter === true`.

Câu hỏi phải trả lời: (6) `exportSequence` có đợi file ghi xong mới resolve không (file có ngay sau `await`?), (7) thời gian/cut, (8) in/out có đúng frame không, (9) mute track video đọc lại được không, (10) xuất ra file ngoài temp folder của plugin (`~/Library/Caches/...`) có được không — thử thêm 1 lần đổi `file` sang `~/Library/Caches/Raw-cutter/spike.mp4`.

### Kết quả spike

Chạy 2026-10-01 trên Premiere **25.6.5** của máy dev, qua UXP Developer Tool (CDP), **chỉ đọc** (Task 0.2 render chưa chạy — project đang mở là project thật):
1. `getSpeed()` = hệ số (1.5927 = 159%), `isSpeedReversed()` trả số 0/1, `isDisabled()`, `getIsSelected()`, `isAdjustmentLayer()` có.
2. `ClipProjectItem.getFootageInterpretation().getFrameRate()` có (29.97, 59.94…); `getRemovePullDown` (chữ D hoa).
3. Component chain chỉ có Opacity/Motion/effect — **không thấy Time Remapping** → `has_keyframed_remap` luôn false.
4. `TickTime.createWithTicks` có. Sequence chưa đặt in/out → `getInPoint()` = −400000 s.
5. `ClipProjectItem.getSequence()` có (đi vào nest cho fingerprint); `ProjectItem.id` là uuid.
6–10 (render): **chưa chạy** — cần chạy Task 0.2 trên project test khi review.
- `ProjectConverter` **không có** trên 25.6 → chế độ dump-only (nest bị bỏ qua).
- in/out của track item là **đơn vị timeline** (out−in = độ dài trên timeline) — đúng schema dump; engine đọc dump thật ra `01_(00.00-01.90)_Sandy_72.mp4` cho clip 1.2 s @159%.
- Đọc 101 clip mất 54 ms. Luồng Đọc + Xuất Source 2 clip chạy được trong plugin bản dev.

---

## Plan 1 — Bridge chạy engine

### Ràng buộc bắt buộc đọc trước khi code

- CommonJS, không thêm dependency. Chỉ `fs`, `path`, `os`, `child_process`.
- `build-app.sh` chỉ copy `bridge/*.js` top-level → module mới phải là file `bridge/rawcut-*.js`; thư mục engine cần thêm 1 dòng `cp -r`.
- Mỗi module mới được `require('./rawcut-x.js')` ở server.js (nháy đơn — để bước kiểm tra require của `build-app.sh:61-71` bắt được nếu thiếu file).
- Response JSON luôn `{ok:true,...}` / `{ok:false,error}`, lỗi tiếng Việt; input sai 400, exception 500.
- Engine phải chạy **detached** (process group riêng) — không thì Cancel không giết được ffmpeg con.
- `env` truyền cho engine là **thay hẳn**, không merge (đúng như CEP `spawnOpts`, M712): `PATH, HOME, LANG=en_US.UTF-8, PYTHONIOENCODING=utf-8, PYTHONUNBUFFERED=1`.
- Thư mục scan phải **xoá sạch** trước mỗi lần: engine từ chối `--manifest-only` vào thư mục đã có export.

### File Structure

| File | Trách nhiệm |
|---|---|
| `bridge/rawcut-engine/xmlcut.py` (mới, vendored) | Engine 3.93, không sửa |
| `bridge/rawcut-engine/VENDORED.md` (mới) | Nguồn gốc, sha256, cách engine được gọi |
| `bridge/rawcut-python.js` (mới) | Tìm python3 ≥3.8 (`PYTHON_BIN` → Homebrew → /usr/local → /usr/bin) |
| `bridge/rawcut-args.js` (mới) | Thuần: options → argv cho xmlcut.py |
| `bridge/rawcut-protocol.js` (mới) | Thuần: parse stdout (`>>`, `[n/N]`, `++`, `!!`) + stderr (lock, no cuts) |
| `bridge/rawcut-runner.js` (mới) | Spawn detached, stream event, cancel cả group |
| `bridge/rawcut-reads.js` (mới) | Lưu dump/XML cạnh .prproj (`xmlcut/<seq>/<stamp>.json`), giữ 10 lần |
| `bridge/rawcut-cache.js` (mới) | Thư mục cache render theo hash thư mục xuất, prune 7 ngày, dung lượng trống |
| `bridge/rawcut-epr.js` (mới) | Tìm preset Match Source, ghi bản sửa bitrate (port `writeRenderPreset` H2226) |
| `bridge/server.js` (sửa) | 6 endpoint `/rawcut/*`, capability trong `/health`, bump `BRIDGE_VERSION` |
| `bridge-app/build-app.sh` (sửa) | Copy + kiểm tra `rawcut-engine/xmlcut.py` |
| `install.sh` (sửa) | Bước kiểm tra python3 (không phụ thuộc Whisper) |
| `bridge/test/rawcut-*.test.js` (mới) | 1 file test / module + 1 test end-to-end |
| `bridge/test/fixtures/rawcut-fake-engine.js` (mới) | Engine giả cho test runner (không cần python) |

### Task 1: Vendor engine

**Files:**
- Create: `bridge/rawcut-engine/xmlcut.py`, `bridge/rawcut-engine/VENDORED.md`
- Test: `bridge/test/rawcut-engine.test.js`

- [ ] **Step 1: Viết test smoke**

```js
// bridge/test/rawcut-engine.test.js — engine vendored chạy được với python máy này
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { findPython } = require('../rawcut-python.js');

const ENGINE = path.join(__dirname, '..', 'rawcut-engine', 'xmlcut.py');
assert.ok(fs.existsSync(ENGINE), 'thiếu ' + ENGINE);
assert.ok(/^VERSION = "3\.93"$/m.test(fs.readFileSync(ENGINE, 'utf8').slice(0, 20000)), 'engine phải là 3.93');

const py = findPython();
if (!py.ok) { console.log('⏭  bỏ qua chạy engine (không có python3 ≥3.8)'); process.exit(0); }
const r = spawnSync(py.bin, [ENGINE, '--help'], { encoding: 'utf8', timeout: 20000 });
assert.strictEqual(r.status, 0, r.stderr);
for (const flag of ['--panel', '--render-dir', '--render-planned', '--pick', '--manifest-only', '--video-track'])
  assert.ok(r.stdout.includes(flag), '--help thiếu ' + flag);
console.log('✓ rawcut-engine (' + py.bin + ' ' + py.version + ')');
```

Test này cần `rawcut-python.js` → làm Task 2 trước rồi mới chạy test Task 1. Thứ tự commit: Task 2 → Task 1.

- [ ] **Step 2: Copy engine + ghi nguồn gốc**

```bash
mkdir -p bridge/rawcut-engine
cp <scratchpad>/xmlcut/app/xmlcut.py bridge/rawcut-engine/xmlcut.py
shasum -a 256 bridge/rawcut-engine/xmlcut.py
```
Expected sha256: `8b083c31082edc736655f27e418bd79ec23a3b0c0e5c159cf17d82fb3310fdd3` (khớp `latest.json` của release 3.93). Không khớp → dừng, tải lại từ `https://raw.githubusercontent.com/mill2nn/xmlcut-releases/main/app/xmlcut.py`.

`bridge/rawcut-engine/VENDORED.md`:
```markdown
# xmlcut.py — engine của tab Raw-cutter

- Nguồn: Raw-cutter 3.93 của mill2nn (github.com/mill2nn/xmlcut-releases, `app/xmlcut.py`)
- sha256 lúc copy: 8b083c31082edc736655f27e418bd79ec23a3b0c0e5c159cf17d82fb3310fdd3
- Từ đây là code của repo này, không đồng bộ upstream nữa.

## Quy tắc
- Giữ tên file có chữ `xmlcut`: lock `.xmlcut-running` chỉ coi là còn sống khi command line của pid giữ lock chứa "xmlcut".
- Không gọi `--update`, `--self-update-json`, `--check-update-json` — cập nhật đi theo bản Bridge app.
- Chỉ dùng thư viện chuẩn Python 3.8+. Cần ffmpeg + ffprobe trên PATH.
- Bridge gọi engine qua `rawcut-args.js` / `rawcut-runner.js`; protocol stdout xem `rawcut-protocol.js`.
```

- [ ] **Step 3: Chạy test**

Run: `cd bridge && node test/rawcut-engine.test.js`
Expected: `✓ rawcut-engine (/opt/homebrew/bin/python3 3.x)` hoặc `/usr/bin/python3 3.9`.

- [ ] **Step 4: Commit**

```bash
git add bridge/rawcut-engine bridge/test/rawcut-engine.test.js
git commit -m "feat(rawcut): vendor engine xmlcut.py 3.93"
```

### Task 2: Tìm python3

**Files:**
- Create: `bridge/rawcut-python.js`
- Test: `bridge/test/rawcut-python.test.js`

- [ ] **Step 1: Viết test**

```js
// bridge/test/rawcut-python.test.js
const assert = require('assert');
const { findPython, parseVer } = require('../rawcut-python.js');

assert.deepStrictEqual(parseVer('3.9\n'), [3, 9]);
assert.strictEqual(parseVer('rác'), null);

// 1. bỏ bản quá cũ, lấy bản kế tiếp đủ mới
const fake = { '/opt/homebrew/bin/python3': '3.7', '/usr/bin/python3': '3.9' };
let r = findPython({ env: {}, exists: p => p in fake, run: p => fake[p] + '\n' });
assert.strictEqual(r.ok, true);
assert.strictEqual(r.bin, '/usr/bin/python3');
assert.strictEqual(r.version, '3.9');
assert.ok(r.tried.some(t => /3\.7/.test(t)), 'phải ghi lý do bỏ 3.7: ' + r.tried);

// 2. PYTHON_BIN được ưu tiên
r = findPython({ env: { PYTHON_BIN: '/x/py' }, exists: p => p === '/x/py' || p in fake, run: p => (p === '/x/py' ? '3.12' : fake[p]) });
assert.strictEqual(r.bin, '/x/py');

// 3. không có gì
r = findPython({ env: {}, exists: () => false, run: () => '' });
assert.strictEqual(r.ok, false);
assert.strictEqual(r.bin, '');

// 4. chạy thử ném lỗi (stub CLT bật hộp thoại → timeout) → bỏ qua, không crash
r = findPython({ env: {}, exists: p => p === '/usr/bin/python3', run: () => { throw new Error('timeout'); } });
assert.strictEqual(r.ok, false);

const real = findPython();
console.log('✓ rawcut-python — máy này:', real.ok ? real.bin + ' ' + real.version : 'KHÔNG CÓ python3 ≥3.8');
```

- [ ] **Step 2: Chạy, xác nhận fail**

Run: `cd bridge && node test/rawcut-python.test.js`
Expected: FAIL `Cannot find module '../rawcut-python.js'`

- [ ] **Step 3: Viết module**

```js
// bridge/rawcut-python.js — tìm python3 ≥3.8 cho engine Raw-cutter.
// Thứ tự: PYTHON_BIN (.env) → Homebrew → /usr/local → /usr/bin. /usr/bin/python3 để cuối:
// trên máy chưa có Command Line Tools nó là stub bật hộp thoại cài đặt — chạy thử có timeout.
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');

const CANDIDATES = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];

function parseVer(s) {
  const m = /^(\d+)\.(\d+)/.exec(String(s || '').trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function okVer(v) {
  return !!v && (v[0] > 3 || (v[0] === 3 && v[1] >= 8));
}

function defaultRun(p) {
  return execFileSync(p, ['-c', 'import sys;print("%d.%d" % sys.version_info[:2])'],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
}

function defaultExists(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}

function findPython(deps) {
  deps = deps || {};
  const env = deps.env || process.env;
  const exists = deps.exists || defaultExists;
  const run = deps.run || defaultRun;
  const list = (env.PYTHON_BIN ? [env.PYTHON_BIN] : []).concat(CANDIDATES);
  const tried = [];
  for (const p of list) {
    if (!exists(p)) { tried.push(p + ': không có'); continue; }
    let out;
    try { out = run(p); } catch (e) { tried.push(p + ': không chạy được'); continue; }
    const v = parseVer(out);
    if (okVer(v)) return { ok: true, bin: p, version: v.join('.'), tried };
    tried.push(p + ': bản ' + (v ? v.join('.') : '?') + ' (cần ≥3.8)');
  }
  return { ok: false, bin: '', version: '', tried };
}

module.exports = { findPython, parseVer, CANDIDATES };
```

- [ ] **Step 4: Chạy, xác nhận pass**

Run: `cd bridge && node test/rawcut-python.test.js`
Expected: `✓ rawcut-python — máy này: /opt/homebrew/bin/python3 3.x` (hoặc `/usr/bin/python3 3.9`)

- [ ] **Step 5: Commit**

```bash
git add bridge/rawcut-python.js bridge/test/rawcut-python.test.js
git commit -m "feat(rawcut): tìm python3 cho engine"
```

Sau commit này quay lại làm Task 1.

### Task 3: Dựng argv

**Files:**
- Create: `bridge/rawcut-args.js`
- Test: `bridge/test/rawcut-args.test.js`

- [ ] **Step 1: Viết test**

```js
// bridge/test/rawcut-args.test.js
const assert = require('assert');
const { buildArgs } = require('../rawcut-args.js');

// 1. scan có XML: thứ tự cờ đầu đúng như panel CEP (argsFor, M628)
let a = buildArgs({ script: '/e/xmlcut.py', xml: '/r/a.xml', sequenceName: 'Seq v1', dump: '/r/a.json', out: '/tmp/scan', manifestOnly: true, transitions: 'split' });
assert.deepStrictEqual(a, ['/e/xmlcut.py', '/r/a.xml', '--sequence', 'name:Seq v1', '--panel', '/r/a.json', '-o', '/tmp/scan', '--transitions', 'split', '--manifest-only']);

// 2. không có XML → dump là input chính
assert.deepStrictEqual(buildArgs({ script: 's', dump: 'd.json', out: 'o' }), ['s', 'd.json', '-o', 'o']);

// 3. giá trị mặc định của engine không gửi
assert.deepStrictEqual(buildArgs({ script: 's', dump: 'd', out: 'o', crf: 1, scale: 100, vcodec: 'libx264' }), ['s', 'd', '-o', 'o']);

// 4. đủ cờ, remap dài trước
a = buildArgs({
  script: 's', dump: 'd', out: 'o', ext: ['.MP4', 'mov'], videoTrack: 2, crf: 4.5, fps: 25, scale: 50,
  vcodec: 'libx265', audioPerTrack: true, audio: true, audioTracks: [1, 3], renderAudio: true,
  transitions: 'split', remap: [['/a', '/x'], ['/a/b', '/y']], renderDir: '/c', resume: true, pick: '/p.txt',
});
assert.deepStrictEqual(a, ['s', 'd', '-o', 'o', '--ext', 'mp4,mov', '--video-track', '2', '--crf', '4.5',
  '--fps', '25', '--scale', '50', '--vcodec', 'libx265', '--audio-per-track', '--audio', '--audio-tracks', '1,3',
  '--render-audio', '--transitions', 'split', '--remap', '/a/b=/y', '--remap', '/a=/x', '--render-dir', '/c',
  '--resume', '--pick', '/p.txt']);

// 5. ràng buộc
assert.throws(() => buildArgs({ script: 's', dump: 'd', out: 'o', renderPlanned: true }), /manifest-only/);
assert.throws(() => buildArgs({ script: 's', dump: 'd', out: 'o', manifestOnly: true, renderPlanned: true, renderDir: '/c' }), /render-dir/);
assert.throws(() => buildArgs({ script: 's', out: 'o' }), /dump/);
assert.throws(() => buildArgs({ script: 's', dump: 'd' }), /thư mục ra/);

console.log('✓ rawcut-args');
```

- [ ] **Step 2: Chạy, xác nhận fail**

Run: `cd bridge && node test/rawcut-args.test.js` — Expected: FAIL `Cannot find module`

- [ ] **Step 3: Viết module**

```js
// bridge/rawcut-args.js — options → argv cho xmlcut.py.
// Thứ tự cờ giữ đúng panel CEP 3.93 (argsFor M628 + settingArgs M8471) để manifest/ledger
// của bản mới giống bản cũ. Giá trị mặc định của engine (crf 1, scale 100, libx264) không gửi.
'use strict';

function buildArgs(o) {
  o = o || {};
  if (!o.script) throw new Error('thiếu đường dẫn engine (script)');
  if (!o.dump) throw new Error('thiếu dump sequence');
  if (!o.out) throw new Error('thiếu thư mục ra (out)');
  if (o.renderPlanned && o.renderDir) throw new Error('--render-planned không đi cùng --render-dir (chỉ dùng khi scan)');
  if (o.renderPlanned && !o.manifestOnly) throw new Error('--render-planned phải đi cùng --manifest-only');

  const a = [o.script];
  if (o.xml) a.push(o.xml, '--sequence', 'name:' + String(o.sequenceName || ''), '--panel', o.dump);
  else a.push(o.dump);
  a.push('-o', o.out);

  if (o.ext && o.ext.length) a.push('--ext', o.ext.map(e => String(e).toLowerCase().replace(/^\./, '')).join(','));
  if (o.videoTrack) a.push('--video-track', String(o.videoTrack));
  if (o.crf != null && Number(o.crf) !== 1) a.push('--crf', String(o.crf));
  if (o.fps) a.push('--fps', String(o.fps));
  if (o.scale != null && Number(o.scale) < 100) a.push('--scale', String(o.scale));
  if (o.vcodec && o.vcodec !== 'libx264') a.push('--vcodec', String(o.vcodec));
  if (o.audioPerTrack) a.push('--audio-per-track');
  if (o.audio) a.push('--audio');
  if (o.audioTracks && o.audioTracks.length) a.push('--audio-tracks', o.audioTracks.join(','));
  if (o.renderAudio) a.push('--render-audio');
  if (o.transitions) a.push('--transitions', String(o.transitions));
  (o.remap || []).slice()
    .sort((x, y) => String(y[0]).length - String(x[0]).length)
    .forEach(p => a.push('--remap', p[0] + '=' + p[1]));
  if (o.sizeProbe) a.push('--size-probe');
  if (o.manifestOnly) a.push('--manifest-only');
  if (o.renderPlanned) a.push('--render-planned');
  if (o.renderDir) a.push('--render-dir', o.renderDir);
  if (o.resume) a.push('--resume');
  if (o.pick) a.push('--pick', o.pick);
  return a;
}

module.exports = { buildArgs };
```

- [ ] **Step 4: Chạy, xác nhận pass** — Run: `cd bridge && node test/rawcut-args.test.js` — Expected: `✓ rawcut-args`

- [ ] **Step 5: Commit**

```bash
git add bridge/rawcut-args.js bridge/test/rawcut-args.test.js
git commit -m "feat(rawcut): dựng argv cho engine"
```

### Task 4: Parse output của engine

**Files:**
- Create: `bridge/rawcut-protocol.js`
- Test: `bridge/test/rawcut-protocol.test.js`

- [ ] **Step 1: Viết test**

```js
// bridge/test/rawcut-protocol.test.js
const assert = require('assert');
const { parseLine, createParser, parseStderr } = require('../rawcut-protocol.js');

assert.deepStrictEqual(parseLine('  >> video/1/0/25 01_(00.40-01.40)_src.mp4'), { type: 'start', key: 'video/1/0/25', file: '01_(00.40-01.40)_src.mp4' });
assert.deepStrictEqual(parseLine('  >> 01_a.mp4'), { type: 'start', key: null, file: '01_a.mp4' });
assert.deepStrictEqual(parseLine('  [1/2] OK  01_a.mp4'), { type: 'done', n: 1, total: 2, flag: 'OK', file: '01_a.mp4', ok: true });
assert.strictEqual(parseLine('  [2/2] HAVE 02_b.mp4').ok, true);
assert.strictEqual(parseLine('  [2/2] FAIL 02_b.mp4').ok, false);
assert.deepStrictEqual(parseLine('  ++ dump agrees'), { type: 'note', text: 'dump agrees' });
assert.deepStrictEqual(parseLine('  !! clip offline'), { type: 'warn', text: 'clip offline' });
assert.deepStrictEqual(parseLine('Cutting with 8 parallel job(s) ...'), { type: 'encoding' });
assert.strictEqual(parseLine('Done: 2 written, 0 failed'), null);
// dòng thụt 8 cách chỉ là lý do khi đứng ngay sau dòng [n/N]
assert.strictEqual(parseLine('        ffmpeg exited 1', null), null);
assert.deepStrictEqual(parseLine('        ffmpeg exited 1', { type: 'done' }), { type: 'reason', text: 'ffmpeg exited 1' });

// parser ghép chunk bị cắt giữa dòng, bỏ \r
const evs = [], lines = [];
const p = createParser(e => evs.push(e), l => lines.push(l));
p.feed('  [1/2] FA');
p.feed('IL 01_a.mp4\r\n        lý do 1\n');
p.feed('  [2/2] OK  02_b.mp4');
p.end();
assert.deepStrictEqual(evs.map(e => e.type), ['done', 'reason', 'done']);
assert.strictEqual(evs[0].file, '01_a.mp4');
assert.strictEqual(evs[1].text, 'lý do 1');
assert.strictEqual(lines.length, 3);

// stderr
let s = parseStderr('Traceback\nerror: another export is already writing into /x/raw (pid 12).\n');
assert.strictEqual(s.lock, 'another export is already writing into /x/raw (pid 12)');
assert.strictEqual(s.noCuts, false);
assert.strictEqual(parseStderr('error: No cuts found in "Seq".').noCuts, true);
assert.strictEqual(parseStderr('1\n2\n3\n4\n5\n6\n7\n8\n').tail, '3\n4\n5\n6\n7\n8');

console.log('✓ rawcut-protocol');
```

- [ ] **Step 2: Chạy, xác nhận fail** — Run: `cd bridge && node test/rawcut-protocol.test.js` — Expected: FAIL `Cannot find module`

- [ ] **Step 3: Viết module**

```js
// bridge/rawcut-protocol.js — đọc stdout/stderr của xmlcut.py.
// Định dạng lấy từ engine 3.93: `  >> {type}/{track}/{in}/{out} {file}` (xmlcut.py ~9267),
// `  [{done}/{total}] {FLAG} {file}` (~12241), lý do lỗi thụt 8 cách ngay sau đó,
// `++` = ghi chú gộp dump/XML, `!!` = cảnh báo. Chỉ OK và HAVE là thành công.
'use strict';

const RE_START  = /^\s*>>\s+(?:([a-z]+\/\d+\/\d+(?:\/\d+)?)\s+)?(.+)$/;
const RE_DONE   = /\[(\d+)\/(\d+)\]\s+(\S+)\s*(.*)$/;
const RE_NOTE   = /^\s*\+\+\s*(.+)$/;
const RE_WARN   = /^\s*!!\s*(.+)$/;
const RE_REASON = /^ {8}\S/;
const RE_LOCK   = /error: (another export is already writing into [\s\S]*?)\.?\s*$/;

function parseLine(line, prev) {
  let m;
  if ((m = RE_START.exec(line))) return { type: 'start', key: m[1] || null, file: m[2].trim() };
  if ((m = RE_NOTE.exec(line))) return { type: 'note', text: m[1].trim() };
  if ((m = RE_WARN.exec(line))) return { type: 'warn', text: m[1].trim() };
  if ((m = RE_DONE.exec(line))) {
    const flag = m[3];
    return { type: 'done', n: Number(m[1]), total: Number(m[2]), flag, file: m[4].trim(), ok: flag === 'OK' || flag === 'HAVE' };
  }
  if (/^\s*Cutting with\b/.test(line)) return { type: 'encoding' };
  if (prev && (prev.type === 'done' || prev.type === 'reason') && RE_REASON.test(line)) return { type: 'reason', text: line.trim() };
  return null;
}

// onEvent(ev) cho dòng có nghĩa, onLine(line) cho mọi dòng (để ghi log).
function createParser(onEvent, onLine) {
  let buf = '', prev = null;
  function line(l) {
    l = l.replace(/\r$/, '');
    if (onLine) onLine(l);
    const ev = parseLine(l, prev);
    if (ev) { prev = ev; if (onEvent) onEvent(ev); }
    else if (l.trim()) prev = null;
  }
  return {
    feed(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    },
    end() { if (buf) { line(buf); buf = ''; } },
  };
}

function parseStderr(s) {
  s = String(s || '');
  const lock = RE_LOCK.exec(s);
  const lines = s.split('\n').map(x => x.replace(/\s+$/, '')).filter(Boolean);
  return { lock: lock ? lock[1].trim() : null, noCuts: /No cuts found/.test(s), tail: lines.slice(-6).join('\n') };
}

module.exports = { parseLine, createParser, parseStderr };
```

- [ ] **Step 4: Chạy, xác nhận pass** — Expected: `✓ rawcut-protocol`

- [ ] **Step 5: Commit**

```bash
git add bridge/rawcut-protocol.js bridge/test/rawcut-protocol.test.js
git commit -m "feat(rawcut): parse protocol stdout/stderr của engine"
```

### Task 5: Runner (spawn + cancel cả group)

**Files:**
- Create: `bridge/rawcut-runner.js`, `bridge/test/fixtures/rawcut-fake-engine.js`
- Test: `bridge/test/rawcut-runner.test.js`

- [ ] **Step 1: Viết engine giả + test**

```js
// bridge/test/fixtures/rawcut-fake-engine.js — giả xmlcut.py: in protocol, đẻ 1 tiến trình
// con ngủ lâu (đóng vai ffmpeg). Tham số "quick" → in xong thoát 0.
const { spawn } = require('child_process');
const kid = spawn('sleep', ['30'], { stdio: 'ignore' });
process.stdout.write('Cutting with 2 parallel job(s) ...\n');
process.stdout.write('  >> video/1/0/25 01_a.mp4\n');
process.stdout.write('  [1/2] OK  01_a.mp4\n');
process.stdout.write('  [2/2] FAIL 02_b.mp4\n        ffmpeg exited 1\n');
process.stdout.write('KID ' + kid.pid + '\n');
if (process.argv[2] === 'quick') { kid.kill(); process.exit(0); }
setInterval(() => {}, 1000);
```

```js
// bridge/test/rawcut-runner.test.js
const assert = require('assert');
const path = require('path');
const { runEngine } = require('../rawcut-runner.js');
const FAKE = path.join(__dirname, 'fixtures', 'rawcut-fake-engine.js');

(async () => {
  // 1. chạy hết: đủ event, mã 0
  const evs = [];
  const r1 = await runEngine({ bin: process.execPath, args: [FAKE, 'quick'], cwd: __dirname, onEvent: e => evs.push(e) }).done;
  assert.strictEqual(r1.code, 0, r1.stderr);
  assert.strictEqual(r1.cancelled, false);
  assert.deepStrictEqual(evs.map(e => e.type), ['encoding', 'start', 'done', 'done', 'reason']);

  // 2. cancel giết cả process group, kể cả "ffmpeg" con
  let kid = 0;
  const j2 = runEngine({
    bin: process.execPath, args: [FAKE], cwd: __dirname,
    onLine: l => { const m = /^KID (\d+)/.exec(l); if (m) { kid = Number(m[1]); j2.cancel(); } },
  });
  const r2 = await j2.done;
  assert.strictEqual(r2.cancelled, true);
  assert.strictEqual(r2.code, null);
  assert.strictEqual(r2.signal, 'SIGTERM');
  assert.ok(kid > 0, 'phải đọc được pid con');
  await new Promise(r => setTimeout(r, 300));
  assert.throws(() => process.kill(kid, 0), /ESRCH/, 'tiến trình con phải chết theo');

  // 3. bin không có → không treo, có spawnError
  const r3 = await runEngine({ bin: '/khong/co/python3', args: [], cwd: __dirname }).done;
  assert.ok(r3.spawnError, 'phải báo spawnError');

  console.log('✓ rawcut-runner');
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Chạy, xác nhận fail** — Run: `cd bridge && node test/rawcut-runner.test.js` — Expected: FAIL `Cannot find module`

- [ ] **Step 3: Viết module**

```js
// bridge/rawcut-runner.js — chạy xmlcut.py, stream event, Cancel giết cả group.
// detached:true cho engine process group riêng: Cancel gửi SIGTERM tới -pid để ffmpeg con
// chết theo (engine tự xoá file .part và nhả lock trong handler SIGTERM). 1.5s sau còn sống → SIGKILL.
'use strict';
const { spawn } = require('child_process');
const { createParser } = require('./rawcut-protocol.js');

const ENGINE_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

function engineEnv() {
  return { PATH: ENGINE_PATH, HOME: process.env.HOME || '', LANG: 'en_US.UTF-8', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' };
}

function runEngine(opts) {
  const child = spawn(opts.bin, opts.args, {
    cwd: opts.cwd, env: opts.env || engineEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', cancelled = false;
  const parser = createParser(opts.onEvent, opts.onLine);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => { stdout += d; parser.feed(d); });
  child.stderr.on('data', d => { stderr += d; });
  const done = new Promise(resolve => {
    child.on('error', e => resolve({ code: -1, signal: null, stdout, stderr: stderr + '\n' + e.message, spawnError: e.message, cancelled }));
    child.on('close', (code, signal) => { parser.end(); resolve({ code, signal, stdout, stderr, cancelled }); });
  });
  function cancel() {
    if (cancelled || child.pid == null) return;
    cancelled = true;
    try { process.kill(-child.pid, 'SIGTERM'); } catch (e) {}
    setTimeout(() => {
      try { process.kill(-child.pid, 0); process.kill(-child.pid, 'SIGKILL'); } catch (e) {}
    }, 1500).unref();
  }
  return { child, done, cancel };
}

module.exports = { runEngine, engineEnv };
```

- [ ] **Step 4: Chạy, xác nhận pass** — Expected: `✓ rawcut-runner`

- [ ] **Step 5: Commit**

```bash
git add bridge/rawcut-runner.js bridge/test/rawcut-runner.test.js bridge/test/fixtures/rawcut-fake-engine.js
git commit -m "feat(rawcut): runner spawn engine + cancel cả process group"
```

### Task 6: Lưu lần đọc timeline

**Files:**
- Create: `bridge/rawcut-reads.js`
- Test: `bridge/test/rawcut-reads.test.js`

Hành vi port từ `readFolderFor` / `pruneOldReads` / `safeName` (H305-426): dump + XML nằm cạnh project ở `<thư mục .prproj>/xmlcut/<tên sequence>/<YYYY-MM-DD_HHMMSS>.json|.xml`; project chưa lưu → `~/Desktop/xmlcut-dumps/<seq>/`; giữ 10 lần mới nhất, không đụng file khác tên.

- [ ] **Step 1: Viết test**

```js
// bridge/test/rawcut-reads.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeName, readFolderFor, saveRead, pruneReads } = require('../rawcut-reads.js');

assert.strictEqual(safeName('A/B:C\\D'), 'A-B-C-D');
assert.strictEqual(safeName('  ..x.. '), 'x');
assert.strictEqual(safeName(''), 'Untitled Sequence');
assert.strictEqual(safeName('a'.repeat(100)).length, 80);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-reads-'));
const proj = path.join(tmp, 'P', 'Edit.prproj');
assert.deepStrictEqual(readFolderFor(proj, 'Seq v1'), { dir: path.join(tmp, 'P', 'xmlcut', 'Seq v1'), besideProject: true });
assert.deepStrictEqual(readFolderFor('', 'S', tmp), { dir: path.join(tmp, 'Desktop', 'xmlcut-dumps', 'S'), besideProject: false });

// ghi dump + copy XML
const xmlSrc = path.join(tmp, 'in.xml');
fs.writeFileSync(xmlSrc, '<xmeml/>');
const r = saveRead({ projectPath: proj, sequenceName: 'Seq v1', dump: { a: 'Việt' }, xmlPath: xmlSrc, now: new Date(2026, 9, 1, 9, 5, 7) });
assert.strictEqual(path.basename(r.json), '2026-10-01_090507.json');
assert.deepStrictEqual(JSON.parse(fs.readFileSync(r.json, 'utf8')), { a: 'Việt' });
assert.strictEqual(path.basename(r.xml), '2026-10-01_090507.xml');
assert.strictEqual(fs.readFileSync(r.xml, 'utf8'), '<xmeml/>');
assert.strictEqual(saveRead({ projectPath: proj, sequenceName: 'Seq v1', dump: {}, now: new Date(2026, 9, 1, 9, 5, 8) }).xml, null);

// giữ 10 lần mới nhất, không đụng file lạ
for (let i = 10; i < 22; i++) fs.writeFileSync(path.join(r.dir, '2026-09-01_0000' + i + '.json'), '{}');
fs.writeFileSync(path.join(r.dir, 'ghi-chu.txt'), 'x');
pruneReads(r.dir, 10);
const left = fs.readdirSync(r.dir).filter(n => /\.json$/.test(n));
assert.strictEqual(left.length, 10);
assert.ok(left.includes('2026-10-01_090507.json') && left.includes('2026-10-01_090508.json'));
assert.ok(fs.existsSync(path.join(r.dir, 'ghi-chu.txt')));

console.log('✓ rawcut-reads');
```

- [ ] **Step 2: Chạy, xác nhận fail** — Expected: FAIL `Cannot find module`

- [ ] **Step 3: Viết module**

```js
// bridge/rawcut-reads.js — mỗi lần Read timeline: lưu dump JSON + FCP XML cạnh project.
// Port từ host.jsx (readFolderFor H369, pruneOldReads H394, safeName H305). Thư mục có thể
// nằm trên shared drive nên prune chỉ xoá đúng file tên dạng thời gian.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const KEEP_READS = 10;
const READ_RE = /^\d{4}-\d{2}-\d{2}_\d{6}\.(json|xml)$/;

function safeName(s) {
  s = String(s == null ? '' : s)
    .replace(/[\/:\\]/g, '-')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (!s) s = 'Untitled Sequence';
  return s.slice(0, 80);
}

function stamp(d) {
  d = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function readFolderFor(projectPath, seqName, home) {
  if (projectPath && path.isAbsolute(projectPath)) {
    return { dir: path.join(path.dirname(projectPath), 'xmlcut', safeName(seqName)), besideProject: true };
  }
  return { dir: path.join(home || os.homedir(), 'Desktop', 'xmlcut-dumps', safeName(seqName)), besideProject: false };
}

function pruneReads(dir, keep) {
  keep = keep || KEEP_READS;
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return 0; }
  const stamps = Array.from(new Set(names.filter(n => READ_RE.test(n)).map(n => n.replace(/\.(json|xml)$/, '')))).sort().reverse();
  let removed = 0;
  for (const s of stamps.slice(keep)) {
    for (const ext of ['.json', '.xml']) {
      try { fs.unlinkSync(path.join(dir, s + ext)); removed++; } catch (e) {}
    }
  }
  return removed;
}

function saveRead(o) {
  const f = readFolderFor(o.projectPath, o.sequenceName, o.home);
  fs.mkdirSync(f.dir, { recursive: true });
  const s = stamp(o.now);
  const json = path.join(f.dir, s + '.json');
  fs.writeFileSync(json, JSON.stringify(o.dump));
  let xml = null;
  if (o.xmlPath) {
    xml = path.join(f.dir, s + '.xml');
    fs.copyFileSync(o.xmlPath, xml);
  }
  const pruned = pruneReads(f.dir);
  return { json, xml, dir: f.dir, besideProject: f.besideProject, stamp: s, pruned };
}

module.exports = { safeName, stamp, readFolderFor, pruneReads, saveRead, KEEP_READS };
```

- [ ] **Step 4: Chạy, xác nhận pass** — Expected: `✓ rawcut-reads`

- [ ] **Step 5: Commit**

```bash
git add bridge/rawcut-reads.js bridge/test/rawcut-reads.test.js
git commit -m "feat(rawcut): lưu dump + XML mỗi lần đọc timeline"
```

### Task 7: Cache render

**Files:**
- Create: `bridge/rawcut-cache.js`
- Test: `bridge/test/rawcut-cache.test.js`

Port ý từ M9997-10306: `~/Library/Caches/Raw-cutter/renders/<hash 16 hex của thư mục edited/>`, entry cũ hơn 7 ngày bị xoá, kiểm tra dung lượng trống trước khi render.

- [ ] **Step 1: Viết test**

```js
// bridge/test/rawcut-cache.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../rawcut-cache.js');

assert.strictEqual(C.fnv1a64(''), 'cbf29ce484222325');
assert.strictEqual(C.fnv1a64('a'), 'af63dc4c8601ec8c');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-cache-'));
assert.strictEqual(C.renderCacheDir('/a/b/', root), path.join(root, C.fnv1a64('/a/b')));
assert.notStrictEqual(C.renderCacheDir('/a/b', root), C.renderCacheDir('/a/c', root));

// prune: chỉ xoá thư mục cũ hơn hạn
const oldD = path.join(root, 'old'), newD = path.join(root, 'new');
fs.mkdirSync(oldD); fs.mkdirSync(newD);
const now = Date.now();
const eightDays = new Date(now - 8 * 24 * 3600 * 1000);
fs.utimesSync(oldD, eightDays, eightDays);
assert.strictEqual(C.pruneCache(root, C.MAX_AGE_MS, now), 1);
assert.ok(!fs.existsSync(oldD));
assert.ok(fs.existsSync(newD));

assert.strictEqual(C.isUnder(root, newD), true);
assert.strictEqual(C.isUnder(root, root), false);
assert.strictEqual(C.isUnder(root, path.join(root, '..', 'x')), false);

assert.ok(C.freeBytes(root) > 0);
console.log('✓ rawcut-cache');
```

- [ ] **Step 2: Chạy, xác nhận fail** — Expected: FAIL `Cannot find module`

- [ ] **Step 3: Viết module**

```js
// bridge/rawcut-cache.js — nơi Premiere render từng cut cho nửa Timeline Render.
// Một thư mục cache / một thư mục edited/ (hash đường dẫn), giữ lại khi chạy lỗi để Retry
// dùng lại render cũ; xoá khi chạy sạch; entry quá 7 ngày bị dọn.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_ROOT = path.join(os.homedir(), 'Library', 'Caches', 'Raw-cutter', 'renders');
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function fnv1a64(s) {
  let h = 0xcbf29ce484222325n;
  const P = 0x100000001b3n;
  for (const b of Buffer.from(String(s), 'utf8')) {
    h ^= BigInt(b);
    h = (h * P) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

function renderCacheDir(outDir, root) {
  return path.join(root || DEFAULT_ROOT, fnv1a64(path.resolve(outDir)));
}

function pruneCache(root, maxAgeMs, now) {
  let names;
  try { names = fs.readdirSync(root); } catch (e) { return 0; }
  let removed = 0;
  for (const n of names) {
    const p = path.join(root, n);
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory() && now - st.mtimeMs > maxAgeMs) {
      try { fs.rmSync(p, { recursive: true, force: true }); removed++; } catch (e) {}
    }
  }
  return removed;
}

function isUnder(root, p) {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function freeBytes(dir) {
  const st = fs.statfsSync(dir);
  return Number(st.bavail) * Number(st.bsize);
}

module.exports = { DEFAULT_ROOT, MAX_AGE_MS, fnv1a64, renderCacheDir, pruneCache, isUnder, freeBytes };
```

- [ ] **Step 4: Chạy, xác nhận pass** — Expected: `✓ rawcut-cache`

- [ ] **Step 5: Commit**

```bash
git add bridge/rawcut-cache.js bridge/test/rawcut-cache.test.js
git commit -m "feat(rawcut): cache render theo thư mục xuất"
```

### Task 8: Preset render `.epr`

**Files:**
- Create: `bridge/rawcut-epr.js`
- Test: `bridge/test/rawcut-epr.test.js`

Port nguyên logic H2114-2365, giữ 3 bài học của bản gốc: (1) chỉ tìm value **trong đúng block** `<ExporterParam …>…</ExporterParam>` của identifier (14/43 preset đặt value trước identifier); (2) kẹp theo `<ParamMaxValue>` (preset High khai max 50 — ghi 94 làm 8/8 render ra rỗng); (3) **không bao giờ** ghi pass mode `ADBEVideoBitrateEncoding` (ghi 1 làm treo render).

- [ ] **Step 1: Viết test**

```js
// bridge/test/rawcut-epr.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../rawcut-epr.js');

// block có value ĐỨNG TRƯỚC identifier (kiểu làm hỏng bản tìm xuôi cũ)
const blk = (id, val, max) => '<ExporterParam Index="0" ObjectID="1" ClassID="c" Version="1">\n<ParamValue>' + val + '</ParamValue>\n'
  + (max ? '<ParamMaxValue>' + max + '</ParamMaxValue>\n' : '') + '<ParamIdentifier>' + id + '</ParamIdentifier>\n</ExporterParam>\n';
// block value đứng sau identifier
const blk2 = (id, val) => '<ExporterParam Index="0" ObjectID="2" ClassID="c" Version="1">\n<ParamIdentifier>' + id + '</ParamIdentifier>\n<ParamValue>' + val + '</ParamValue>\n</ExporterParam>\n';
const noVal = id => '<ExporterParam Index="0" ObjectID="3" ClassID="c" Version="1">\n<ParamIdentifier>' + id + '</ParamIdentifier>\n</ExporterParam>\n';
const wrap = s => '<ExporterParamContainer ObjectID="9">\n' + s + '</ExporterParamContainer>';
const XML = wrap(blk('ADBEVideoTargetBitrate', '10.', '50.') + blk('ADBEVideoMaxBitrate', '12.', '50.')
  + blk2('ADBEVideoMinBitrate', '1.') + blk2('ADBEVideoBitrateEncoding', '2'));

assert.strictEqual(E.readEprParam(XML, 'ADBEVideoMaxBitrate'), '12.');
assert.strictEqual(E.readEprParam(XML, 'ADBEVideoMinBitrate'), '1.');
assert.strictEqual(E.eprLimit(XML, 'ADBEVideoTargetBitrate', 'ParamMaxValue'), 50);
assert.strictEqual(E.eprLimit(XML, 'ADBEVideoMinBitrate', 'ParamMaxValue'), 0);
// identifier không có value riêng → null, không với sang block kế bên
assert.strictEqual(E.readEprParam(wrap(noVal('ADBEOnlyId') + blk2('Other', '7')), 'ADBEOnlyId'), null);
assert.strictEqual(E.patchEprParam(XML, 'NoSuch', '1'), null);
assert.strictEqual(E.eprNumber(10), '10.');
assert.strictEqual(E.eprNumber(41.666), '41.7');

assert.deepStrictEqual(E.planBitrate(20, XML), { target: 20, max: 24, min: 2, capped: false });
const cap = E.planBitrate(50, XML);
assert.strictEqual(cap.max, 50);
assert.strictEqual(E.eprNumber(cap.target), '41.7');
assert.strictEqual(cap.capped, true);

// ghi file + đọc lại
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-epr-'));
const base = path.join(tmp, 'base.epr');
fs.writeFileSync(base, XML);
let w = E.writeRenderPreset({ destDir: path.join(tmp, 'out'), mbps: 20, basePath: base });
assert.strictEqual(w.ok, true, w.error);
const back = fs.readFileSync(w.path, 'utf8');
assert.strictEqual(E.readEprParam(back, 'ADBEVideoTargetBitrate'), '20.');
assert.strictEqual(E.readEprParam(back, 'ADBEVideoMaxBitrate'), '24.');
assert.strictEqual(E.readEprParam(back, 'ADBEVideoMinBitrate'), '2.');
assert.strictEqual(E.readEprParam(back, 'ADBEVideoBitrateEncoding'), '2', 'pass mode giữ nguyên');

// preset thiếu tham số → từ chối, nêu tên
fs.writeFileSync(base, wrap(blk('ADBEVideoTargetBitrate', '10.') + blk('ADBEVideoMaxBitrate', '12.')));
w = E.writeRenderPreset({ destDir: tmp, mbps: 20, basePath: base });
assert.strictEqual(w.ok, false);
assert.ok(/ADBEVideoMinBitrate/.test(w.error), w.error);

// tìm preset trong cây /Applications giả: Premiere mới nhất trước
const apps = path.join(tmp, 'Applications');
const sub = (top, app) => path.join(apps, top, app, 'Contents', 'MediaIO', 'systempresets', '4E49434B_48323634');
fs.mkdirSync(sub('Adobe Premiere Pro 2026', 'Adobe Premiere Pro 2026.app'), { recursive: true });
fs.mkdirSync(sub('Adobe Premiere Pro 2025', 'Adobe Premiere Pro 2025.app'), { recursive: true });
fs.writeFileSync(path.join(sub('Adobe Premiere Pro 2026', 'Adobe Premiere Pro 2026.app'), '01 - Match Source - High bitrate.epr'), XML);
fs.writeFileSync(path.join(sub('Adobe Premiere Pro 2025', 'Adobe Premiere Pro 2025.app'), '00 - Match Source - High bitrate.epr'), XML);
const f = E.findStockPreset({ appsDir: apps });
assert.ok(f.found.includes('Premiere Pro 2026') && f.found.endsWith('01 - Match Source - High bitrate.epr'), f.found);
assert.strictEqual(E.findStockPreset({ appsDir: path.join(tmp, 'trong') }).found, '');

// máy thật (nếu có Premiere)
const real = E.findStockPreset();
if (real.found) {
  const rw = E.writeRenderPreset({ destDir: tmp, mbps: 20, basePath: real.found });
  assert.strictEqual(rw.ok, true, rw.error);
  console.log('  preset thật:', real.name, '→ pass', rw.pass);
}
console.log('✓ rawcut-epr');
```

- [ ] **Step 2: Chạy, xác nhận fail** — Expected: FAIL `Cannot find module`

- [ ] **Step 3: Viết module**

```js
// bridge/rawcut-epr.js — preset H.264 cho Premiere render từng cut (port host.jsx H1082-1222, H2114-2365).
// Gốc là "Match Source - High bitrate" (theo size/fps của sequence); chỉ sửa 3 tham số bitrate.
// Không bao giờ ghi ADBEVideoBitrateEncoding (pass mode): ghi 1 đã làm treo render thật.
'use strict';
const fs = require('fs');
const path = require('path');

const PRESET_NAME = '_xmlcut_render.epr';
const PRESET_SUBDIR = path.join('Contents', 'MediaIO', 'systempresets', '4E49434B_48323634');
const STOCK_NAMES = ['00 - Match Source - High bitrate.epr', '01 - Match Source - High bitrate.epr',
  '00 - Match Source - Medium bitrate.epr', '01 - Match Source - Medium bitrate.epr'];

// Value chỉ được tìm TRONG block <ExporterParam …>…</ExporterParam> của chính identifier.
function eprValueSpan(xml, ident, field) {
  field = field || 'ParamValue';
  const at = xml.indexOf('<ParamIdentifier>' + ident + '</ParamIdentifier>');
  if (at < 0) return null;
  const start = xml.lastIndexOf('<ExporterParam ', at);
  if (start < 0) return null;
  const end = xml.indexOf('</ExporterParam>', start);
  if (end < at) return null;
  const block = xml.substring(start, end);
  const open = '<' + field + '>', shut = '</' + field + '>';
  const vs = block.indexOf(open);
  if (vs < 0) return null;
  const ve = block.indexOf(shut, vs);
  if (ve < 0) return null;
  return { from: start + vs + open.length, to: start + ve };
}

function patchEprParam(xml, ident, value) {
  const span = eprValueSpan(xml, ident);
  return span ? xml.substring(0, span.from) + value + xml.substring(span.to) : null;
}

function readEprParam(xml, ident) {
  const span = eprValueSpan(xml, ident);
  return span ? xml.substring(span.from, span.to) : null;
}

// 0 = file không khai giới hạn (không phải "giới hạn là 0").
function eprLimit(xml, ident, which) {
  const span = eprValueSpan(xml, ident, which);
  if (!span) return 0;
  const n = Number(String(xml.substring(span.from, span.to)).replace(/\.$/, ''));
  return n > 0 ? n : 0;
}

// Adobe ghi số nguyên dạng "10." — giữ đúng định dạng file vẫn dùng.
function eprNumber(n) {
  n = Math.round(Number(n) * 10) / 10;
  return n === Math.floor(n) ? String(Math.floor(n)) + '.' : String(n);
}

function planBitrate(mbps, xml) {
  let target = Number(mbps);
  let maxb = target * 1.2; // preset của Adobe để max cao hơn target 20%
  const capM = eprLimit(xml, 'ADBEVideoMaxBitrate', 'ParamMaxValue');
  const capT = eprLimit(xml, 'ADBEVideoTargetBitrate', 'ParamMaxValue');
  if (capM > 0 && maxb > capM) { maxb = capM; if (target > maxb / 1.2) target = maxb / 1.2; }
  if (capT > 0 && target > capT) { target = capT; if (maxb < target) maxb = target; }
  return { target, max: maxb, min: Math.min(2, target), capped: target !== Number(mbps) };
}

function writeRenderPreset(o) {
  let xml0;
  try { xml0 = fs.readFileSync(o.basePath, 'utf8'); } catch (e) { return { ok: false, error: 'Không đọc được preset gốc ' + o.basePath }; }
  if (!(Number(o.mbps) > 0)) return { ok: false, error: 'Không có bitrate để ghi' };
  const plan = planBitrate(o.mbps, xml0);
  let xml = xml0;
  const pairs = [['ADBEVideoTargetBitrate', eprNumber(plan.target)], ['ADBEVideoMaxBitrate', eprNumber(plan.max)], ['ADBEVideoMinBitrate', eprNumber(plan.min)]];
  for (const [id, v] of pairs) {
    const next = patchEprParam(xml, id, v);
    if (next === null) return { ok: false, error: 'Preset không có ' + id + ' — không đoán chỗ ghi, dùng preset gốc' };
    xml = next;
  }
  fs.mkdirSync(o.destDir, { recursive: true });
  const out = path.join(o.destDir, PRESET_NAME);
  fs.writeFileSync(out, xml, 'utf8');
  const back = fs.readFileSync(out, 'utf8');
  if (readEprParam(back, 'ADBEVideoTargetBitrate') !== eprNumber(plan.target) || readEprParam(back, 'ADBEVideoMaxBitrate') !== eprNumber(plan.max)) {
    return { ok: false, error: 'Preset đọc lại không đúng bitrate vừa ghi — không dùng' };
  }
  const pass = readEprParam(back, 'ADBEVideoBitrateEncoding');
  if (pass !== readEprParam(xml0, 'ADBEVideoBitrateEncoding')) return { ok: false, error: 'Pass mode của preset bị đổi — không dùng' };
  return { ok: true, path: out, target: plan.target, max: plan.max, min: plan.min, pass, capped: plan.capped };
}

// Premiere trước Media Encoder, bản mới trước. Mỗi app: thử STOCK_NAMES theo thứ tự.
function findStockPreset(o) {
  const appsDir = (o && o.appsDir) || '/Applications';
  const tried = [];
  let tops;
  try { tops = fs.readdirSync(appsDir).filter(n => /^Adobe (Premiere Pro|Media Encoder)/.test(n)); } catch (e) { tops = []; }
  tops.sort((a, b) => {
    const pa = /Premiere/.test(a) ? 0 : 1, pb = /Premiere/.test(b) ? 0 : 1;
    return pa !== pb ? pa - pb : b.localeCompare(a, undefined, { numeric: true });
  });
  for (const top of tops) {
    let apps;
    try { apps = fs.readdirSync(path.join(appsDir, top)).filter(n => n.endsWith('.app')); } catch (e) { continue; }
    for (const app of apps) {
      for (const name of STOCK_NAMES) {
        const p = path.join(appsDir, top, app, PRESET_SUBDIR, name);
        tried.push(p);
        if (fs.existsSync(p)) return { found: p, name: top + ' / ' + name, tried };
      }
    }
  }
  return { found: '', name: '', tried };
}

module.exports = { PRESET_NAME, eprValueSpan, patchEprParam, readEprParam, eprLimit, eprNumber, planBitrate, writeRenderPreset, findStockPreset };
```

- [ ] **Step 4: Chạy, xác nhận pass** — Expected: `  preset thật: Adobe Premiere Pro 2026 / 00 - Match Source - High bitrate.epr → pass 2` rồi `✓ rawcut-epr`

- [ ] **Step 5: Commit**

```bash
git add bridge/rawcut-epr.js bridge/test/rawcut-epr.test.js
git commit -m "feat(rawcut): preset render .epr (port writeRenderPreset)"
```

### Task 9: Endpoint `/rawcut/*`

**Files:**
- Modify: `bridge/server.js` — thêm section ngay **trước** `// ── Start ──` (hiện ở ~3602); thêm capability vào `/health` (~3043)
- Test: `bridge/test/rawcut-endpoints.test.js`

Hợp đồng endpoint:

| Endpoint | Input | Output |
|---|---|---|
| `GET /rawcut/status` | — | `{ok, python:{ok,bin,version,tried}, ffmpeg:{ok}, engine:{path,exists,version}}` |
| `POST /rawcut/scan` | `{projectPath, sequenceName, dump, xmlPath?, half:'source'\|'render', options}` **hoặc** `{read:{json,xml}, sequenceName, half, options}` (dùng lại lần đọc — Both quét 2 lần trên cùng 1 lần đọc) | `{ok, read:{json,xml,dir,stamp}, half, manifest, notes[], warnings[]}` / `{ok:true, noCuts:true, read, ...}` |
| `POST /rawcut/export` (SSE) | `{read:{json,xml}, sequenceName, out, renderDir?, pick?:[key], options}` | `data: {type:'event', ev}` … `data: {type:'end', code, signal, cancelled, built, lock, tail, spawnError, manifest}` rồi `data: [DONE]`. Đóng request = Cancel |
| `POST /rawcut/render-cache` | `{out}` (thư mục edited/) | `{ok, dir, pruned, freeBytes, files[]}` |
| `POST /rawcut/render-cache/clean` | `{dir}` (phải nằm trong cache) | `{ok}` |
| `POST /rawcut/render-preset` | `{dir, mbps}` (mbps 0 = preset gốc) | `{ok, path, stockPath, stock, bitrate?, warning?}` |

`options` cho scan chỉ nhận: `videoTrack, crf, fps, scale, vcodec, audioPerTrack, audio, audioTracks, renderAudio, transitions, remap, sizeProbe`. Export nhận thêm `ext, resume`. Các key khác bị bỏ (client không được tự đặt `script`, `out`, `renderPlanned`…).

- [ ] **Step 1: Viết test end-to-end (python + ffmpeg thật, tự bỏ qua nếu thiếu)**

```js
// bridge/test/rawcut-endpoints.test.js — scan → export raw/ → scan render → export edited/ → pick → dọn cache
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.PORT = '3032';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ep-'));
process.env.RAWCUT_CACHE = path.join(TMP, 'cache');

const { findPython } = require('../rawcut-python.js');
const ENV = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' };
if (!findPython().ok || spawnSync('ffmpeg', ['-version'], { env: ENV }).status !== 0) {
  console.log('⏭  bỏ qua rawcut-endpoints (thiếu python3 hoặc ffmpeg)');
  process.exit(0);
}
const { app } = require('../server.js');

const T = 254016000000;
const tt = s => ({ ticks: String(Math.round(s * T)), seconds: s });
function ffmpeg(args) { const r = spawnSync('ffmpeg', ['-v', 'error', '-y'].concat(args), { env: ENV }); assert.strictEqual(r.status, 0, String(r.stderr)); }
function dumpFor(src) {
  const clip = (st, en, i, o) => ({
    track_index: 1, track_type: 'video', name: 'src.mp4', media_type: 'Video',
    start: tt(st), end: tt(en), duration: tt(en - st), in_point: tt(i), out_point: tt(o),
    speed: 1, reversed: false, disabled: false, selected: false, is_adjustment_layer: false,
    project_item: { name: 'src.mp4', node_id: '1', type: 1, media_path: src, is_sequence: false, is_offline: false, is_multicam: false },
    interpretation: { frame_rate: 25 }, components: [], has_keyframed_remap: false,
  });
  return {
    generator: 'xmlcut reader', format_version: 1, premiere_version: '26.3', project_name: 'T', project_path: '',
    sequence: { name: 'Test v1', id: 'seq-1', timebase_ticks_per_frame: String(T / 25), fps: 25, frame_width: 320, frame_height: 180, end: tt(2), in_point: null, out_point: null },
    ticks_per_second: T, clips: [clip(0, 1, 0.4, 1.4), clip(1, 2, 2, 3)],
  };
}

const server = app.listen(3032, async () => {
  const base = 'http://127.0.0.1:3032';
  const opts = b => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
  const post = (u, b) => fetch(base + u, opts(b)).then(r => r.json());
  const sse = async (u, b) => {
    const t = await (await fetch(base + u, opts(b))).text();
    return t.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => JSON.parse(l.slice(6)));
  };
  const doneEvs = list => list.filter(x => x.type === 'event' && x.ev.type === 'done');
  try {
    const st = await fetch(base + '/rawcut/status').then(r => r.json());
    assert.strictEqual(st.ok, true, JSON.stringify(st));
    assert.strictEqual(st.engine.version, '3.93');

    const src = path.join(TMP, 'src.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-t', '4', '-pix_fmt', 'yuv420p', src]);
    const proj = path.join(TMP, 'proj', 'Edit.prproj');
    fs.mkdirSync(path.dirname(proj));

    // 1. scan nửa source
    const s1 = await post('/rawcut/scan', { projectPath: proj, sequenceName: 'Test v1', dump: dumpFor(src), half: 'source', options: { transitions: 'split' } });
    assert.strictEqual(s1.ok, true, s1.error);
    assert.strictEqual(s1.manifest.clips.length, 2);
    assert.ok(s1.manifest.clips.every(c => c.cuttable));
    assert.ok(s1.read.json.startsWith(path.join(TMP, 'proj', 'xmlcut', 'Test v1')), s1.read.json);

    // 2. export raw/
    const raw = path.join(TMP, 'out', 'v1', 'raw');
    const e1 = await sse('/rawcut/export', { read: s1.read, sequenceName: 'Test v1', out: raw, options: { transitions: 'split' } });
    assert.strictEqual(doneEvs(e1).length, 2);
    assert.ok(doneEvs(e1).every(x => x.ev.ok));
    const end1 = e1[e1.length - 1];
    assert.strictEqual(end1.type, 'end');
    assert.strictEqual(end1.code, 0, end1.tail);
    assert.strictEqual(end1.built, true);
    assert.strictEqual(end1.manifest.counts.ok, 2);
    assert.ok(fs.existsSync(path.join(raw, 'report', path.basename(s1.read.json))));
    assert.ok(fs.existsSync(path.join(raw, 'report', 'bridge-log.txt')));

    // 3. scan nửa render trên cùng lần đọc → nhãn render
    const s2 = await post('/rawcut/scan', { read: s1.read, sequenceName: 'Test v1', half: 'render', options: { videoTrack: 1, transitions: 'split' } });
    assert.strictEqual(s2.ok, true, s2.error);
    const labels = s2.manifest.clips.map(c => c.track_type + '-' + c.track_index + '-' + c.timeline_in_frames + '-' + c.timeline_out_frames);
    assert.deepStrictEqual(labels, ['video-1-0-25', 'video-1-25-50']);

    // 4. cache + render giả (thay Premiere) → export edited/
    const edited = path.join(TMP, 'out', 'v1', 'edited');
    const rc = await post('/rawcut/render-cache', { out: edited });
    assert.strictEqual(rc.ok, true, rc.error);
    assert.ok(rc.dir.startsWith(process.env.RAWCUT_CACHE));
    for (const l of labels) ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '1', '-pix_fmt', 'yuv420p', path.join(rc.dir, l + '.mp4')]);
    const e2 = await sse('/rawcut/export', { read: s1.read, sequenceName: 'Test v1', out: edited, renderDir: rc.dir, options: { videoTrack: 1, transitions: 'split' } });
    const end2 = e2[e2.length - 1];
    assert.strictEqual(end2.code, 0, end2.tail);
    assert.strictEqual(end2.manifest.counts.ok, 2);

    // 5. pick: chỉ 1 clip
    const e3 = await sse('/rawcut/export', { read: s1.read, sequenceName: 'Test v1', out: path.join(TMP, 'out', 'pick'), pick: [end1.manifest.clips[0].cut_id] });
    assert.strictEqual(doneEvs(e3).length, 1);

    // 6. preset: mbps 0 → preset gốc (nếu máy có Premiere)
    const pr = await post('/rawcut/render-preset', { dir: rc.dir, mbps: 0 });
    if (pr.ok) assert.strictEqual(pr.stock, true);

    // 7. dọn cache — chỉ trong cache
    assert.strictEqual((await post('/rawcut/render-cache/clean', { dir: rc.dir })).ok, true);
    assert.ok(!fs.existsSync(rc.dir));
    assert.strictEqual((await post('/rawcut/render-cache/clean', { dir: TMP })).ok, false);

    // 8. input sai
    assert.strictEqual((await post('/rawcut/scan', { sequenceName: 'x' })).ok, false);
    assert.strictEqual((await fetch(base + '/rawcut/export', opts({ read: { json: '/khong/co.json' }, out: raw }))).status, 400);

    console.log('✓ rawcut-endpoints');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.close();
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  }
});
```

- [ ] **Step 2: Chạy, xác nhận fail**

Run: `cd bridge && node test/rawcut-endpoints.test.js`
Expected: FAIL — `/rawcut/status` trả 404 (JSON parse lỗi "Unexpected token <").

- [ ] **Step 3: Thêm section vào `bridge/server.js` ngay trước `// ── Start ──`**

```js
// ── Raw-cutter: cắt từng cut của timeline ra file riêng ───────────────────
// Engine xmlcut.py (Raw-cutter 3.93 của mill2nn, vendored ở rawcut-engine/). Plugin đọc
// timeline + render từng cut trong Premiere; bridge lưu lần đọc, chạy engine (ffmpeg) và
// stream tiến độ. Both = plugin gọi /rawcut/export 2 lần (raw/ rồi edited/ + renderDir).
const rcArgs   = require('./rawcut-args.js');
const rcProto  = require('./rawcut-protocol.js');
const rcRunner = require('./rawcut-runner.js');
const rcReads  = require('./rawcut-reads.js');
const rcCache  = require('./rawcut-cache.js');
const rcEpr    = require('./rawcut-epr.js');
const rcPy     = require('./rawcut-python.js');
const RC_ENGINE = path.join(__dirname, 'rawcut-engine', 'xmlcut.py');
const RC_TMP    = path.join(os.tmpdir(), 'xmlcut-panel');
const RC_CACHE  = process.env.RAWCUT_CACHE || rcCache.DEFAULT_ROOT;
const RC_SCAN_KEYS   = ['videoTrack', 'crf', 'fps', 'scale', 'vcodec', 'audioPerTrack', 'audio', 'audioTracks', 'renderAudio', 'transitions', 'remap', 'sizeProbe'];
const RC_EXPORT_KEYS = RC_SCAN_KEYS.concat(['ext', 'resume']);

let rcPyCache = null;
function rcPython() {
  if (!rcPyCache || !rcPyCache.ok) rcPyCache = rcPy.findPython();
  return rcPyCache;
}
function rcEngineVersion() {
  try {
    const m = /^VERSION = "([^"]+)"/m.exec(fs.readFileSync(RC_ENGINE, 'utf8').slice(0, 20000));
    return m ? m[1] : '';
  } catch (e) { return ''; }
}
function rcPick(o, keys) {
  const r = {};
  o = o || {};
  for (const k of keys) if (o[k] !== undefined) r[k] = o[k];
  return r;
}
function rcAbs(p) { return typeof p === 'string' && path.isAbsolute(p); }
function rcMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (e) { return 0; } }

// ── GET /rawcut/status ── → {ok, python, ffmpeg:{ok}, engine:{path,exists,version}}
app.get('/rawcut/status', (_req, res) => {
  const py = rcPython();
  let ffOk = false;
  try { ffOk = require('child_process').spawnSync('ffmpeg', ['-version'], { env: cleanEnv(), timeout: 5000 }).status === 0; } catch (e) {}
  const exists = fs.existsSync(RC_ENGINE);
  res.json({ ok: py.ok && ffOk && exists, python: py, ffmpeg: { ok: ffOk }, engine: { path: RC_ENGINE, exists, version: rcEngineVersion() } });
});

// ── POST /rawcut/scan ── {projectPath, sequenceName, dump, xmlPath?} | {read}, half, options
//    → {ok, read, half, manifest, notes, warnings} | {ok:true, noCuts:true, ...}
app.post('/rawcut/scan', async (req, res) => {
  const b = req.body || {};
  const reuse = b.read && rcAbs(b.read.json) && fs.existsSync(b.read.json);
  if (!reuse && (!b.dump || typeof b.dump !== 'object')) return res.status(400).json({ ok: false, error: 'Thiếu dữ liệu sequence (dump)' });
  if (!b.sequenceName) return res.status(400).json({ ok: false, error: 'Thiếu tên sequence' });
  if (b.xmlPath && !rcAbs(b.xmlPath)) return res.status(400).json({ ok: false, error: 'xmlPath phải là đường dẫn tuyệt đối' });
  const py = rcPython();
  if (!py.ok) return res.status(500).json({ ok: false, error: 'Không tìm thấy python3 ≥3.8 — ' + py.tried.join('; ') });
  try {
    const read = reuse
      ? { json: b.read.json, xml: (b.read.xml && fs.existsSync(b.read.xml)) ? b.read.xml : null }
      : rcReads.saveRead({ projectPath: b.projectPath, sequenceName: b.sequenceName, dump: b.dump, xmlPath: b.xmlPath || null });
    const half = b.half === 'render' ? 'render' : 'source';
    const dir = path.join(RC_TMP, half === 'render' ? 'scan-edited' : 'scan');
    fs.rmSync(dir, { recursive: true, force: true }); // engine từ chối --manifest-only vào thư mục đã có export
    fs.mkdirSync(dir, { recursive: true });
    const args = rcArgs.buildArgs(Object.assign(rcPick(b.options, RC_SCAN_KEYS), {
      script: RC_ENGINE, xml: read.xml, sequenceName: b.sequenceName, dump: read.json, out: dir,
      manifestOnly: true, renderPlanned: half === 'render',
    }));
    const notes = [], warnings = [];
    const r = await rcRunner.runEngine({
      bin: py.bin, args, cwd: path.dirname(RC_ENGINE),
      onEvent: ev => { if (ev.type === 'note') notes.push(ev.text); else if (ev.type === 'warn') warnings.push(ev.text); },
    }).done;
    if (r.code !== 0) {
      const st = rcProto.parseStderr(r.stderr);
      if (st.noCuts) return res.json({ ok: true, noCuts: true, read, half, notes, warnings });
      return res.status(500).json({ ok: false, error: 'Engine lỗi khi đọc (mã ' + r.code + '): ' + (r.spawnError || st.tail), read });
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    res.json({ ok: true, read, half, manifest, notes, warnings });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /rawcut/export (SSE) ── {read, sequenceName, out, renderDir?, pick?, options}
//    data:{type:'event',ev} … data:{type:'end',code,signal,cancelled,built,lock,tail,manifest}
//    Đóng request = Cancel (giết cả process group của engine).
app.post('/rawcut/export', async (req, res) => {
  const b = req.body || {};
  const read = b.read || {};
  if (!rcAbs(read.json) || !fs.existsSync(read.json)) return res.status(400).json({ ok: false, error: 'Lần đọc timeline không còn — bấm Đọc timeline lại' });
  if (!rcAbs(b.out)) return res.status(400).json({ ok: false, error: 'Thiếu thư mục xuất (đường dẫn tuyệt đối)' });
  if (b.renderDir && (!rcAbs(b.renderDir) || !fs.existsSync(b.renderDir))) return res.status(400).json({ ok: false, error: 'Thư mục render không tồn tại' });
  const py = rcPython();
  if (!py.ok) return res.status(500).json({ ok: false, error: 'Không tìm thấy python3 ≥3.8' });

  let args, pickFile = null;
  try {
    fs.mkdirSync(RC_TMP, { recursive: true });
    if (Array.isArray(b.pick)) {
      pickFile = path.join(RC_TMP, 'pick-' + Date.now() + '-' + process.pid + '.txt');
      fs.writeFileSync(pickFile, '# Raw-cutter pick list\n# one cut_id or "TYPE INDEX IN OUT" per line\n' + b.pick.map(String).join('\n') + '\n');
    }
    const xml = (read.xml && fs.existsSync(read.xml)) ? read.xml : null;
    args = rcArgs.buildArgs(Object.assign(rcPick(b.options, RC_EXPORT_KEYS), {
      script: RC_ENGINE, xml, sequenceName: b.sequenceName, dump: read.json, out: b.out,
      renderDir: b.renderDir || null, pick: pickFile,
    }));
    const rep = path.join(b.out, 'report');
    fs.mkdirSync(rep, { recursive: true });
    fs.copyFileSync(read.json, path.join(rep, path.basename(read.json)));
    if (xml) fs.copyFileSync(xml, path.join(rep, path.basename(xml)));
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }

  const manPath = path.join(b.out, 'manifest.json');
  const before = rcMtime(manPath);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = obj => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) {} };
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 10000);
  let finished = false;
  const job = rcRunner.runEngine({ bin: py.bin, args, cwd: path.dirname(RC_ENGINE), onEvent: ev => send({ type: 'event', ev }) });
  res.on('close', () => { if (!finished) job.cancel(); });
  const r = await job.done;
  finished = true;
  clearInterval(hb);
  if (pickFile) { try { fs.unlinkSync(pickFile); } catch (e) {} }
  const st = rcProto.parseStderr(r.stderr);
  const after = rcMtime(manPath);
  const built = after > 0 && after !== before; // Cancel bằng signal không ghi manifest
  let manifest = null;
  if (built) { try { manifest = JSON.parse(fs.readFileSync(manPath, 'utf8')); } catch (e) {} }
  try {
    fs.writeFileSync(path.join(b.out, 'report', 'bridge-log.txt'),
      '$ ' + [py.bin].concat(args).join(' ') + '\n\n' + r.stdout + '\n--- stderr ---\n' + r.stderr);
  } catch (e) {}
  send({ type: 'end', code: r.code, signal: r.signal, cancelled: r.cancelled, built, lock: st.lock, tail: st.tail, spawnError: r.spawnError || null, manifest });
  try { res.write('data: [DONE]\n\n'); res.end(); } catch (e) {}
});

// ── POST /rawcut/render-cache ── {out} → {ok, dir, pruned, freeBytes, files}
app.post('/rawcut/render-cache', (req, res) => {
  const out = (req.body || {}).out;
  if (!rcAbs(out)) return res.status(400).json({ ok: false, error: 'Thiếu thư mục xuất' });
  try {
    fs.mkdirSync(RC_CACHE, { recursive: true });
    const pruned = rcCache.pruneCache(RC_CACHE, rcCache.MAX_AGE_MS, Date.now());
    const dir = rcCache.renderCacheDir(out, RC_CACHE);
    fs.mkdirSync(dir, { recursive: true });
    res.json({ ok: true, dir, pruned, freeBytes: rcCache.freeBytes(dir), files: fs.readdirSync(dir).filter(n => !n.startsWith('.')) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /rawcut/render-cache/clean ── {dir} — chỉ xoá trong cache render
app.post('/rawcut/render-cache/clean', (req, res) => {
  const dir = (req.body || {}).dir;
  if (!rcAbs(dir) || !rcCache.isUnder(RC_CACHE, dir)) return res.status(400).json({ ok: false, error: 'Chỉ xoá được thư mục trong cache render' });
  try { fs.rmSync(dir, { recursive: true, force: true }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── POST /rawcut/render-preset ── {dir, mbps} → {ok, path, stockPath, stock, bitrate?, warning?}
//    Không ghi được bản sửa → vẫn ok, trả preset gốc + warning (render vẫn chạy được).
app.post('/rawcut/render-preset', (req, res) => {
  const b = req.body || {};
  const stock = rcEpr.findStockPreset();
  if (!stock.found) return res.status(500).json({ ok: false, error: 'Không tìm thấy preset H.264 "Match Source" trong Premiere / Media Encoder', tried: stock.tried });
  if (!(Number(b.mbps) > 0) || !rcAbs(b.dir)) return res.json({ ok: true, path: stock.found, stockPath: stock.found, stock: true });
  const w = rcEpr.writeRenderPreset({ destDir: b.dir, mbps: Number(b.mbps), basePath: stock.found });
  if (!w.ok) return res.json({ ok: true, path: stock.found, stockPath: stock.found, stock: true, warning: w.error });
  res.json({ ok: true, path: w.path, stockPath: stock.found, stock: false, bitrate: { target: w.target, max: w.max, min: w.min, pass: w.pass, capped: w.capped } });
});
```

- [ ] **Step 4: Thêm capability vào `/health`**

Trong object `capabilities` của `app.get('/health', …)` thêm dòng:
```js
      rawcut:      fs.existsSync(path.join(__dirname, 'rawcut-engine', 'xmlcut.py')), // /rawcut/* (Raw-cutter)
```
(Không gọi `rcPython()` ở đây: `/health` bị poll 15s/lần, tìm python có thể chạy process con.)

- [ ] **Step 5: Chạy test endpoint, rồi cả bộ**

Run: `cd bridge && node test/rawcut-endpoints.test.js`
Expected: `✓ rawcut-endpoints`

Run: `cd bridge && npm test`
Expected: `ALL TESTS PASSED`

- [ ] **Step 6: Commit**

```bash
git add bridge/server.js bridge/test/rawcut-endpoints.test.js
git commit -m "feat(rawcut): endpoint /rawcut/* (scan, export SSE, cache, preset)"
```

### Task 10: Đóng gói + installer + version beta

**Files:**
- Modify: `bridge-app/build-app.sh:53-56` và sau khối kiểm tra require (`:61-71`)
- Modify: `install.sh` — `ensure_media_tools()` (~`:142`)
- Modify: `bridge/server.js` — `BRIDGE_VERSION` (~`:3024`)

- [ ] **Step 1: `build-app.sh` — copy engine (ngay sau dòng `cp -r bridge/node_modules …`)**

```bash
cp -r bridge/rawcut-engine      "${APP_DIR}/Contents/Resources/server/"
```

Và ngay sau khối `echo "  ✅ Local require() đầy đủ trong bundle"`:
```bash
# Engine Raw-cutter là file .py — bước kiểm tra require ở trên không thấy nó.
if [ ! -s "${APP_DIR}/Contents/Resources/server/rawcut-engine/xmlcut.py" ]; then
  echo "  ❌ Bundle thiếu rawcut-engine/xmlcut.py — tab Raw-cutter sẽ không chạy. Dừng build."
  exit 1
fi
echo "  ✅ Engine Raw-cutter có trong bundle"
```

- [ ] **Step 2: `install.sh` — kiểm tra python3 trước bước Whisper** (trong `ensure_media_tools()`, ngay sau `brew_install ffmpeg ffmpeg`)

```bash
  step "Python 3 (engine Raw-cutter)"
  if have python3 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' 2>/dev/null; then
    ok "đã có ($(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])'))"
  else
    brew_install python3 python3
  fi
```

Kiểm tra: `bash install.sh --dry-run` in ra dòng `Python 3 (engine Raw-cutter)` và `đã có (3.x)`, không cài gì.

- [ ] **Step 3: Bump version bridge**

`bridge/server.js`: `const BRIDGE_VERSION = '1.20.0';` → `'1.21.0-beta.1'`, và thêm vào đầu chuỗi comment cùng dòng: `Raw-cutter: /rawcut/status|scan|export(SSE)|render-cache|render-cache/clean|render-preset, engine xmlcut.py 3.93 vendored ở rawcut-engine/ (cần python3 ≥3.8 + ffmpeg). Prior 1.20.0: …` (giữ nguyên phần cũ phía sau).

- [ ] **Step 4: Chạy lại toàn bộ test**

Run: `cd bridge && npm test` — Expected: `ALL TESTS PASSED`

- [ ] **Step 5: Commit**

```bash
git add bridge-app/build-app.sh install.sh bridge/server.js
git commit -m "build(rawcut): đóng gói engine, installer kiểm python3, bridge 1.21.0-beta.1"
```

---

## Plan 2 — Lớp Premiere của plugin (khung, chi tiết hoá sau spike)

**Files:** `plugin/rawcut-core.js` (thuần, ES5, dual-export như `resize-core.js:242-246`, test ở `bridge/test/rawcut-core.test.js`), `plugin/rawcut-ppro.js` (gọi Premiere; tự copy helper `commitTx`/`makeTime`/`un` vì các helper trong main.js nằm trong IIFE).

Task (mỗi task TDD cho phần thuần, test tay trong Premiere cho phần ppro):

1. **`RCC.buildDump(seqInfo, clips)`** — dựng dump đúng schema `format_version:1` (xem "Schema dump" ở cuối file). Thời gian `{ticks: STRING, seconds}`; `in_point/out_point` là đơn vị **timeline**. Test: dump dựng từ clip giả chạy được qua `/rawcut/scan` (dùng lại fixture Task 9).
2. **`RCP.readSequence()`** — đọc sequence + mọi clip track video rồi audio (track 1-based), theo đúng method đã xác nhận ở spike. Nest = 1 clip có `project_item.is_sequence:true`.
3. **`RCP.exportXml(seq)`** — `ProjectConverter.exportAsFinalCutProXML(seq, <temp>/<stamp>.xml, true)` (cách dùng ở `main.js:13917-13930`); không có API → trả null (chế độ dump-only).
4. **`RCC.fingerprint(tracks)`** + `RCP.stamp(deep)` — hash như `activeSequenceStamp` H682-846: track mute + mỗi clip `start:end:in:out:on/off:nodeId:mediaPath`, nest đệ quy ≤4 tầng. Dùng để từ chối render khi timeline đã bị sửa sau lúc Read.
5. **`RCC.renderSpec(editClips)`** — nhãn `video-<track>-<in>-<out>` khớp tên engine tìm trong `--render-dir`.
6. **`RCP.renderRanges(ranges, opts, onProgress, shouldStop)`** — với mỗi khoảng: set in/out (transaction trong `lockedAccess`, bắt lỗi bên trong lock), đọc lại kiểm tra đúng tick, `exportSequence(seq, IMMEDIATELY, <cacheDir>/<label>.mp4, preset, false)`, kiểm tra file có thật & >0 byte. Solo track video (`keepTracks`) + mute audio track không nghe; luôn khôi phục **chỉ cái đã đổi** trong `finally`. Cut đầu lỗi với preset tự ghi → thử lại với preset gốc (`shouldFallBackToStock` H2219). Không set được in/out → dừng cả lượt (`no_range`).
7. **`RCC.renderMbps(crf, w, h, fps)`** — port `renderMbps` M9583 (kẹp [4, 41.7]).

## Plan 3 — Tab UI (khung, cần user duyệt phạm vi trước)

**Files:** `plugin/index.html` (tab `data-tab="rawcut"`, panel `#tab-rawcut`, `<script src="rawcut-core.js">` trước main.js, `rawcut-ppro.js` + `rawcut.js` sau `resize.js`), `plugin/rawcut.js` (IIFE theo mẫu `resize.js`), `plugin/styles.css` (prefix `rc-`, layout theo `.rsz-root`/`.rsz-scroll`).

Luồng: **Đọc timeline** (dump → XML → `/rawcut/scan` source, nếu Both thêm scan render trên cùng `read`) → bảng clip (tick từng clip, chip loại file, cảnh báo) → **Xuất** (kiểm sequence/fingerprint → `/rawcut/export` raw/ → `/rawcut/render-cache` + `/rawcut/render-preset` → `RCP.renderRanges` → `/rawcut/export` edited/ + renderDir → dọn cache nếu sạch) → báo cáo gộp 2 nửa → **Retry** clip lỗi (pick = key clip lỗi, nửa render chỉ render lại clip thiếu/lệch).

Gate: `RC_MIN_BRIDGE = '1.21.0'` theo mẫu `stBlockIfOldBridge` (`main.js:12555-12579`); hiện lỗi rõ nếu `/rawcut/status` báo thiếu python/ffmpeg.

## Plan 4 — Release beta

`PLUGIN_VERSION` → `v5.12.0-beta.1` (manifest.json giữ `5.12.0`, không hậu tố), CHANGELOG, bảng endpoint trong `CLAUDE.md` + `AGENTS.md`, chạy `bash bridge-app/build-app.sh`, test tay trên máy member trước khi bỏ hậu tố beta.

---

## Phụ lục: Schema dump (`format_version: 1`)

Engine kiểm `generator === "xmlcut reader"`. Thời gian `T = {ticks: STRING, seconds: NUMBER}`, 254016000000 tick/giây.

```
{ generator:"xmlcut reader", format_version:1, premiere_version, project_name, project_path,
  sequence:{ name, id, timebase_ticks_per_frame (STRING), fps, frame_width, frame_height,
             end:T, in_point:T|null, out_point:T|null },
  ticks_per_second: 254016000000,
  clips:[ { track_index (1-based), track_type "video"|"audio", name, media_type,
            start:T, end:T, duration:T,
            in_point:T, out_point:T,          // đơn vị TIMELINE — engine nhân speed ra giây nguồn
            speed (hệ số, 2 = 200%)|null, reversed, disabled, selected, is_adjustment_layer,
            project_item:{ name, node_id, type, media_path ("" cho title), is_sequence, is_offline, is_multicam },
            interpretation:{ frame_rate, pixel_aspect_ratio, field_type, remove_pulldown, alpha_usage },
            components:[ { displayName, matchName, is_time_remap?, params?:[{ name, keyframes_supported, time_varying, value, keys?:[{time:T, value}] }] } ],
            has_keyframed_remap, error? } ] }
```

Engine gộp dump với XML (`overlay_dump`, xmlcut.py ~4121): XML là gốc (nest, transition, audio, marker, `cut_id`); dump chỉ sửa đường dẫn media khi XML trỏ file không còn, thêm ramp keys và `interpreted_fps`. Không có XML → `DumpTimeline` (~3690), bỏ qua nest kèm cảnh báo.
