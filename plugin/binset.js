// plugin/binset.js — chạy khối "Dựng bin GG / PIN" trong Premiere (global BINSET).
// Kế hoạch thuần ở binset-core.js (BSC); nhân bản / đổi tên / vào bin dùng ResizeAPI.cloneInto,
// bản resize tài nguyên 2 dùng ResizeAPI.plan/run (nền tảng FB → tên "40.1 4x5 FB").
// Dùng global: PTOOLS, ResizeAPI, BSC.
var BINSET = (function () {
  async function plan(platform, set, idxs) {
    var items = await PTOOLS.snapshot();
    if (!items) return { ok: false, error: 'chưa mở project' };
    return BSC.plan(items, { platform: platform, set: set, idxs: idxs || [] });
  }

  async function seqOf(ref) {
    var r = await PTOOLS.sequencesFor([ref]);
    if (!r.seqs.length) throw new Error('không mở được ' + ref.split(' ▸ ').pop() + ((r.rows[0] && r.rows[0].error) ? ' (' + r.rows[0].error + ')' : ''));
    return r.seqs[0];
  }

  // rows: các dòng của BSC.plan (đã lọc theo bro chọn). onLine(text, cls) báo từng việc.
  // → {made, failed:[text]}
  async function run(rows, onLine) {
    if (!window.ResizeAPI || !window.ResizeAPI.cloneInto) throw new Error('tab Resize chưa sẵn sàng');
    var made = 0, failed = [];
    function bad(what, e) { var t = what + ': ' + ((e && e.message) || e); failed.push(t); onLine(t, 'is-error'); }
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.error) continue;
      var res1 = null;
      // Tài nguyên 1: bản sao FB gốc tên {bộ}.{số}
      try {
        if (r.res1.exists) res1 = await seqOf(r.bin + ' ▸ ' + r.res1.name);
        else if (r.res1.skip) res1 = null;                // bro bỏ chọn → không có nguồn cho bản resize
        else {
          onLine('Tạo ' + r.res1.name + '…', 'is-run');
          res1 = await window.ResizeAPI.cloneInto(await seqOf(r.src.ref), r.res1.name, r.bin);
          made++; onLine('Đã tạo ' + r.res1.name, 'is-ok');
        }
      } catch (e) { bad(r.res1.name, e); continue; }   // thiếu tài nguyên 1 thì không làm tiếp video này
      // Tài nguyên 2: resize sang ratio còn lại của FB (9:16 ⇄ 4:5), về cùng bin
      if (!r.res2.exists && !r.res2.skip && res1) {
        try {
          onLine('Resize ' + r.res1.name + '…', 'is-run');
          var sp = r.res2.spec || { platform: 'FB', ratios: [] };
          var pl = await window.ResizeAPI.plan(sp.platform, sp.ratios, [res1]);
          if (!pl.ok) throw new Error(pl.error);
          var todo = pl.plan.filter(function (p) { return !p.skip && !p.exists && !p.dupInPlan; });
          if (!todo.length) throw new Error((pl.plan[0] && pl.plan[0].skip) || 'không có ratio nào để resize');
          var out = await window.ResizeAPI.run(sp.platform, todo, function () {});
          var er = out.results.filter(function (x) { return x.error; });
          if (er.length) throw new Error(er[0].error);
          made += todo.length; onLine('Đã tạo ' + todo.map(function (p) { return p.name; }).join(', '), 'is-ok');
        } catch (e) { bad('resize ' + r.res1.name, e); }
      }
      // Bản đích: nhân bản template / bản của bộ gần nhất, đổi tên
      for (var k = 0; k < r.targets.length; k++) {
        var t = r.targets[k];
        if (t.exists || !t.from || t.skip) continue;
        try {
          onLine('Tạo ' + t.label + '…', 'is-run');
          await window.ResizeAPI.cloneInto(await seqOf(t.from.ref), t.name, r.bin);
          made++; onLine('Đã tạo ' + t.name, 'is-ok');
        } catch (e) { bad(t.label + ' ' + r.idx, e); }
      }
    }
    PTOOLS.invalidate();
    return { made: made, failed: failed };
  }

  // ── APP: nhân bản FB gốc → "<SP> AppLovin vid…" vào bin APP của bộ ──
  async function planApp(set, idxs) {
    var items = await PTOOLS.snapshot();
    if (!items) return { ok: false, error: 'chưa mở project' };
    return BSC.planApp(items, { set: set, idxs: idxs || [] });
  }
  async function runApp(rows, onLine) {
    if (!window.ResizeAPI || !window.ResizeAPI.cloneInto) throw new Error('tab Resize chưa sẵn sàng');
    var made = 0, failed = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.error || r.exists || r.skip) continue;
      try {
        onLine('Tạo ' + r.name + '…');
        await window.ResizeAPI.cloneInto(await seqOf(r.src.ref), r.name, r.bin);
        made++;
      } catch (e) { failed.push('vid' + r.idx + ': ' + ((e && e.message) || e)); }
    }
    PTOOLS.invalidate();
    return { made: made, failed: failed };
  }

  // ── PIN theo đơn: resize 2:3 từ FB gốc, bản mới vào "Sequence / PIN / Order <ngày>" ──
  async function planPin(set, idxs, order) {
    var items = await PTOOLS.snapshot();
    if (!items) return { ok: false, error: 'chưa mở project' };
    return BSC.planPin(items, { set: set, idxs: idxs || [], order: order });
  }
  async function runPin(p, rows, onLine) {
    if (!window.ResizeAPI) throw new Error('tab Resize chưa sẵn sàng');
    var todo = rows.filter(function (r) { return !r.error && !r.exists && !r.skip; });
    if (!todo.length) return { made: 0, failed: [] };
    var src = await PTOOLS.sequencesFor(todo.map(function (r) { return r.src.ref; }));
    var failed = src.rows.filter(function (r) { return r.error; }).map(function (r) { return r.name + ': ' + r.error; });
    if (!src.seqs.length) return { made: 0, failed: failed };
    var pl = await window.ResizeAPI.plan('PIN', ['2-3'], src.seqs);
    if (!pl.ok) throw new Error(pl.error);
    var go = pl.plan.filter(function (x) { return !x.skip && !x.exists && !x.dupInPlan; });
    pl.plan.forEach(function (x) { if (x.skip) failed.push(x.src + ': ' + x.skip); });
    if (!go.length) return { made: 0, failed: failed };
    var made = 0;
    var out = await window.ResizeAPI.run('PIN', go, function (r) {
      if (!r.skip && !r.error) onLine('Đã tạo ' + (++made) + '/' + go.length + '…');
    }, { destBin: p.bin });
    out.results.forEach(function (r) { if (r.error) failed.push((r.name || r.src) + ': ' + r.error); });
    PTOOLS.invalidate();
    return { made: made, failed: failed };
  }

  return { plan: plan, run: run, planApp: planApp, runApp: runApp, planPin: planPin, runPin: runPin };
})();
window.BINSET = BINSET;
