// plugin/flow-engine.js — khối ĐƠN cho quy trình tab Claude (global FLE). Thuần, có test.
//
// Mỗi khối một việc: Tạo bin · Tạo sequence · Nhân bản · Resize · Chuyển vào bin · Xuất RAW.
// Quy trình = chuỗi khối, chạy cho từng video {bộ}.{số}. Khối sau lấy "kết quả bước N" làm nguồn.
// planStep() tính TRƯỚC (không đụng Premiere) tên / bin / nguồn cho từng video, đánh dấu đã có /
// lỗi; kết quả ảo của các bước trước được thêm vào bản chụp để bước sau tìm thấy.
// Thiết kế: docs/research/2026-10-05-khoi-don-quy-trinh.md. Phần chạy ở claude-tab.js (flowEngineStep).
//
// Kiểu dữ liệu một bước:
//   bin_make   {bin}                       seq_make   {name, frame, bin}
//   seq_clone  {src, name, bin}            seq_resize {src, ratio, platform, bin}
//   seq_move   {src, bin}                  raw_export {src, mode, auto}
//   src  = {k:'base'} (FB gốc) | {k:'step', n} | {k:'prev', ref} (bản cùng loại ở bộ trước) | {k:'current'}
//   ref  = {k:'base'} | {k:'match', text:'GG Dọc'}
//   name = {k:'learn', ref} (học tên bộ trước) | {k:'tpl', text:'{SP} vid{bộ}.{số} [{CO}] [{ED}]'}
//   bin  = {k:'tpl', text} | {k:'prev', ref} | {k:'step', n} | {k:'src'}
//   frame = 'prev' | '9-16' | '4-5' | '1-1' | '16-9' | '2-3'
//   ratio = 'other' (9:16⇄4:5) | 'prev' (như bộ trước) | '9-16' | '4-5' | '1-1' | '2-3'
//   platform = 'GG' | 'FB' | 'PIN' | 'prev'

var FLE = (function () {
  var B = (typeof BSC !== 'undefined') ? BSC : require('./binset-core.js');

  var TYPES = {
    bin_make:   { label: 'Tạo bin',        desc: 'tạo bin theo đường dẫn (mẫu hoặc như bộ trước)' },
    seq_make:   { label: 'Tạo sequence',   desc: 'sequence rỗng cho từng video, tên + cài đặt như bộ trước' },
    seq_clone:  { label: 'Nhân bản',       desc: 'nhân bản một sequence rồi đặt tên mới' },
    seq_resize: { label: 'Resize',         desc: 'đổi khung sequence thành bản mới (tab Resize)' },
    seq_move:   { label: 'Chuyển vào bin', desc: 'chuyển sequence vào bin khác' },
    raw_export: { label: 'Xuất RAW',       desc: 'xuất từng cut ra file (tab RAW)' }
  };
  var FRAMES = { '9-16': [1080, 1920], '4-5': [1080, 1350], '1-1': [1080, 1080], '16-9': [1920, 1080], '2-3': [1080, 1620] };
  var RATIO_TXT = { '9-16': '9:16', '4-5': '4:5', '1-1': '1:1', '16-9': '16:9', '2-3': '2:3' };
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function isType(t) { return !!TYPES[t]; }
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function str(v, n) { return String(v == null ? '' : v).slice(0, n || 300); }
  function isSeq(it) { return it && !it.isFolder && it.mediaType === 'sequence'; }
  function refOf(it) { return (it.path || '') + ' ▸ ' + it.name; }
  function samePath(a, b) { return norm(a).replace(/\s*\/\s*/g, '/') === norm(b).replace(/\s*\/\s*/g, '/'); }

  // ── Chuẩn hoá ──────────────────────────────────────────────────────────────
  function nRef(r) {
    if (r && r.k === 'match' && str(r.text, 60).trim()) return { k: 'match', text: str(r.text, 60).trim() };
    return { k: 'base' };
  }
  function nSrc(s) {
    s = s || {};
    if (s.k === 'step') return { k: 'step', n: Math.max(1, parseInt(s.n, 10) || 1) };
    if (s.k === 'prev') return { k: 'prev', ref: nRef(s.ref) };
    if (s.k === 'current') return { k: 'current' };
    return { k: 'base' };
  }
  function nName(n) {
    n = n || {};
    if (n.k === 'tpl') return { k: 'tpl', text: str(n.text, 200) };
    return { k: 'learn', ref: nRef(n.ref) };
  }
  function nBin(b, def) {
    b = b || def || {};
    if (b.k === 'tpl') return { k: 'tpl', text: str(b.text, 200) };
    if (b.k === 'prev') return { k: 'prev', ref: nRef(b.ref) };
    if (b.k === 'step') return { k: 'step', n: Math.max(1, parseInt(b.n, 10) || 1) };
    return { k: 'src' };
  }
  function normStep(s) {
    if (!s || !isType(s.type)) return null;
    var t = s.type, o = { type: t };
    if (t === 'bin_make') o.bin = nBin(s.bin, { k: 'tpl', text: '' });
    if (t === 'seq_make') { o.name = nName(s.name); o.frame = FRAMES[s.frame] ? s.frame : 'prev'; o.bin = nBin(s.bin, { k: 'step', n: 1 }); }
    if (t === 'seq_clone') { o.src = nSrc(s.src); o.name = nName(s.name); o.bin = nBin(s.bin, { k: 'src' }); }
    if (t === 'seq_resize') {
      o.src = nSrc(s.src);
      o.ratio = ['other', 'prev'].indexOf(s.ratio) >= 0 || FRAMES[s.ratio] ? s.ratio : 'other';
      o.platform = ['GG', 'FB', 'PIN', 'prev'].indexOf(s.platform) >= 0 ? s.platform : 'FB';
      o.bin = nBin(s.bin, { k: 'src' });
    }
    if (t === 'seq_move') { o.src = nSrc(s.src); o.bin = nBin(s.bin, { k: 'tpl', text: '' }); }
    if (t === 'raw_export') { o.src = nSrc(s.src); o.mode = ['source', 'render', 'both'].indexOf(s.mode) >= 0 ? s.mode : 'both'; o.auto = s.auto !== false; }
    return o;
  }
  // Thiếu gì để lưu được → ['đường dẫn bin', …]
  function problems(s) {
    var out = [];
    if (s.bin && s.bin.k === 'tpl' && !s.bin.text.trim()) out.push('đường dẫn bin');
    if (s.name && s.name.k === 'tpl' && !s.name.text.trim()) out.push('mẫu tên');
    if (s.name && s.name.k === 'learn' && s.name.ref.k === 'match' && !s.name.ref.text) out.push('loại sequence để học tên');
    return out;
  }

  // ── Nhãn hiển thị ──────────────────────────────────────────────────────────
  function refTxt(r) { return r.k === 'match' ? '"' + r.text + '"' : 'FB gốc'; }
  function srcTxt(s) {
    if (s.k === 'step') return 'kết quả bước ' + s.n;
    if (s.k === 'prev') return refTxt(s.ref) + ' bộ trước';
    if (s.k === 'current') return 'đang chọn / mở';
    return 'FB gốc';
  }
  function nameTxt(n) { return n.k === 'tpl' ? (n.text || 'mẫu tên?') : 'tên như ' + refTxt(n.ref) + ' bộ trước'; }
  function binTxt(b) {
    if (b.k === 'tpl') return b.text || 'bin?';
    if (b.k === 'prev') return 'bin như ' + refTxt(b.ref) + ' bộ trước';
    if (b.k === 'step') return 'bin bước ' + b.n;
    return 'cùng bin nguồn';
  }
  // Chip tóm tắt: [{kind, text, missing?}]
  function chips(s) {
    var out = [{ kind: 'act', text: TYPES[s.type].label }];
    function c(kind, text, miss) { out.push({ kind: kind, text: text, missing: !!miss }); }
    if (s.src) c('seq', srcTxt(s.src));
    if (s.type === 'seq_resize') {
      c('par', s.ratio === 'other' ? 'ratio còn lại' : s.ratio === 'prev' ? 'ratio như bộ trước' : RATIO_TXT[s.ratio]);
      c('par', s.platform === 'prev' ? 'nhãn như bộ trước' : s.platform);
    }
    if (s.type === 'seq_make') c('par', s.frame === 'prev' ? 'khung như bộ trước' : RATIO_TXT[s.frame]);
    if (s.type === 'raw_export') c('par', s.mode === 'both' ? 'source + render' : s.mode);
    if (s.name) c('par', nameTxt(s.name), s.name.k === 'tpl' && !s.name.text.trim());
    if (s.bin) c('seq', binTxt(s.bin), s.bin.k === 'tpl' && !s.bin.text.trim());
    return out;
  }

  // ── Tìm trong project ──────────────────────────────────────────────────────
  // Sequence thuộc "loại" ref của video set.idx (idx null = video bất kỳ của bộ).
  function vidOf(name) { var m = String(name).match(/vid\s*(\d+)\s*\.\s*(\d+)(?!\d)/i); return m ? { set: Number(m[1]), idx: Number(m[2]) } : null; }
  function familyIn(items, ref, set) {
    if (ref.k === 'base') {
      var src = B.fbSources(items, set), out = [];
      Object.keys(src).forEach(function (i) {
        var it = (items || []).filter(function (x) { return isSeq(x) && refOf(x) === src[i].ref; })[0];
        if (it) out.push({ item: it, set: Number(set), idx: Number(i) });
      });
      return out;
    }
    var re = new RegExp('(^|\\s)' + esc(ref.text) + '\\s+vid\\s*' + set + '\\s*\\.\\s*(\\d+)(?!\\d)', 'i');
    return (items || []).filter(isSeq).map(function (it) {
      var m = String(it.name).match(re);
      return m ? { item: it, set: Number(set), idx: Number(m[2]) } : null;
    }).filter(Boolean);
  }
  function setsWith(items, ref) {
    var sets = {};
    (items || []).forEach(function (it) { var v = isSeq(it) && vidOf(it.name); if (v) sets[v.set] = 1; });
    return Object.keys(sets).map(Number).sort(function (a, b) { return b - a; })
      .filter(function (s) { return familyIn(items, ref, s).length; });
  }
  // Bộ gần nhất (< set) có loại ref; ưu tiên cùng số video. → {item, set, idx} | null
  function nearestPrev(items, ref, set, idx) {
    var sets = setsWith(items, ref).filter(function (s) { return s < Number(set); });
    if (!sets.length) return null;
    var fam = familyIn(items, ref, sets[0]);
    return fam.filter(function (f) { return f.idx === Number(idx); })[0] || fam.sort(function (a, b) { return a.idx - b.idx; })[0];
  }
  // Đổi số bộ / số video của bộ trước sang video đích (tên + đường dẫn).
  function subst(text, from, to) {
    var t = String(text || '');
    t = t.replace(new RegExp('(vid\\s*)' + from.set + '(\\s*\\.\\s*)' + from.idx + '(?!\\d)', 'gi'), '$1' + to.set + '$2' + to.idx);
    t = t.replace(new RegExp('(^|[^\\d.])' + from.set + '\\.' + from.idx + '(?![\\d])', 'g'), '$1' + to.set + '.' + to.idx);
    t = t.replace(new RegExp('(^|\\D)' + from.set + '(?=x\\b)', 'g'), '$1' + to.set);
    return t;
  }

  // Biến của video: lấy tag / sản phẩm từ FB gốc của bộ (chưa có → bộ trước).
  function varsFor(items, set, idx, date) {
    var base = familyIn(items, { k: 'base' }, set).filter(function (f) { return f.idx === Number(idx); })[0]
            || nearestPrev(items, { k: 'base' }, set, idx);
    var name = base ? base.item.name : '';
    var tags = String(name).match(/\[[^\]]*\]/g) || [];
    var sp = (String(name).match(/^(.*?)\s*vid\s*\d/i) || [])[1] || '';
    var d = date || new Date(), dd = d.getDate(), yy = d.getFullYear() % 100;
    return { 'bộ': String(set), 'số': String(idx), 'SP': sp.trim(),
             'CO': tags[0] ? tags[0].slice(1, -1) : '', 'ED': tags[1] ? tags[1].slice(1, -1) : '',
             'ngày': MON[d.getMonth()] + ' ' + (dd < 10 ? '0' : '') + dd + ' ' + (yy < 10 ? '0' : '') + yy };
  }
  function fillTpl(text, v) {
    var miss = [];
    var out = String(text || '').replace(/\{(bộ|số|SP|CO|ED|ngày)\}/g, function (m, k) {
      if (!v[k]) { if (miss.indexOf(k) < 0) miss.push(k); return m; }
      return v[k];
    });
    return { text: out, missing: miss };
  }

  // ── Lập kế hoạch một bước ─────────────────────────────────────────────────
  // ctx = {items, targets:[{set, idx}], results:[[{name, bin, ref?}|null per target] per step trước], date}
  // → rows [{key, set, idx, name, bin, src:{ref,name}|{step}, exists, error, frame?, ratio?, platform?, like?}]
  function planStep(s, n, ctx) {
    var items = ctx.items || [], rows = [];
    (ctx.targets || []).forEach(function (tg, ti) {
      var set = String(tg.set), idx = Number(tg.idx), to = { set: Number(set), idx: idx };
      var row = { key: set + '.' + idx, set: set, idx: idx };
      var v = varsFor(items, set, idx, ctx.date);
      function stepRes(k) {
        var r = ctx.results && ctx.results[k - 1] && ctx.results[k - 1][ti];
        if (!r) throw new Error('bước ' + k + ' chưa có kết quả cho vid' + row.key);
        return r;
      }
      try {
        // nguồn
        if (s.src) {
          if (s.src.k === 'base') {
            var f = familyIn(items, { k: 'base' }, set).filter(function (x) { return x.idx === idx; })[0];
            if (!f) throw new Error('không thấy FB gốc vid' + row.key);
            row.src = { ref: refOf(f.item), name: f.item.name, bin: f.item.path };
          } else if (s.src.k === 'step') {
            var r0 = stepRes(s.src.n);
            row.src = { step: s.src.n, name: r0.name, bin: r0.bin, ref: r0.ref };
          } else if (s.src.k === 'prev') {
            var p = nearestPrev(items, s.src.ref, set, idx);
            if (!p) throw new Error('chưa có ' + refTxt(s.src.ref) + ' ở bộ trước');
            row.src = { ref: refOf(p.item), name: p.item.name, bin: p.item.path, prev: p.set };
          } else row.src = { current: true };
        }
        // tên
        if (s.name) {
          if (s.name.k === 'tpl') {
            var ft = fillTpl(s.name.text, v);
            if (ft.missing.length) throw new Error('thiếu ' + ft.missing.map(function (k) { return '{' + k + '}'; }).join(', '));
            row.name = ft.text;
          } else {
            var pn = nearestPrev(items, s.name.ref, set, idx);
            if (!pn) throw new Error('chưa có ' + refTxt(s.name.ref) + ' ở bộ trước để học tên');
            row.name = subst(pn.item.name, { set: pn.set, idx: pn.idx }, to);
          }
        }
        // bin
        if (s.bin) {
          if (s.bin.k === 'tpl') {
            var fb = fillTpl(s.bin.text, v);
            if (fb.missing.length) throw new Error('thiếu ' + fb.missing.map(function (k) { return '{' + k + '}'; }).join(', '));
            row.bin = fb.text;
          } else if (s.bin.k === 'prev') {
            var pb = nearestPrev(items, s.bin.ref, set, idx);
            if (!pb) throw new Error('chưa có ' + refTxt(s.bin.ref) + ' ở bộ trước để học bin');
            row.bin = subst(pb.item.path, { set: pb.set, idx: pb.idx }, to);
          } else if (s.bin.k === 'step') {
            var rb = stepRes(s.bin.n);
            row.bin = rb.binOnly || rb.bin;
          } else row.bin = row.src ? row.src.bin : '';
        }
        // riêng từng khối
        if (s.type === 'bin_make') {
          row.binOnly = row.bin;
          row.exists = (items || []).some(function (it) { return it.isFolder && samePath((it.path ? it.path + ' / ' : '') + it.name, row.bin); });
        }
        if (s.type === 'seq_make') {
          if (s.frame === 'prev') {
            var pl = nearestPrev(items, { k: 'base' }, set, idx);
            if (!pl) throw new Error('chưa có bộ trước để chép cài đặt sequence');
            row.like = { ref: refOf(pl.item), name: pl.item.name };
          } else row.frame = FRAMES[s.frame];
        }
        if (s.type === 'seq_make' || s.type === 'seq_clone') {
          row.exists = (items || []).some(function (it) { return isSeq(it) && norm(it.name) === norm(row.name); });
        }
        if (s.type === 'seq_resize') {
          row.ratio = s.ratio; row.platform = s.platform;
          if (s.ratio === 'prev' || s.platform === 'prev') {
            // như bộ trước: bản "{bộ}.{số} AxB …" nằm trong bin cùng nền tảng ở bộ gần nhất
            var hint = (String(row.bin || '').match(/\/\s*(GG|PIN|FB|APP)\s*(\/|$)/i) || [])[1] || 'GG';
            var spec = B.res2Spec(items, hint.toUpperCase(), set, idx);
            if (s.ratio === 'prev') { if (spec.from) row.ratios = spec.ratios; else row.ratio = 'other'; }   // chưa học được → ratio còn lại
            if (s.platform === 'prev') row.platform = spec.from ? spec.platform : 'FB';
            row.learnedFrom = spec.from || null;
          }
          var stem = row.src && row.src.name ? String(row.src.name).replace(/\s+\d+x\d+(\s+\S+)?$/i, '') : '';
          var exact = FRAMES[row.ratio] && row.platform !== 'prev' ? stem + ' ' + row.ratio.replace('-', 'x') + ' ' + row.platform : '';
          // Tên chắc chắn (ratio + nhãn cụ thể) → trùng ở BẤT KỲ đâu (như tab Resize, vd PIN ở đơn cũ);
          // còn lại (ratio còn lại / như bộ trước) → có bản "<nguồn> AxB …" trong bin đích là coi như có.
          var had = exact ? (items || []).filter(function (it) { return isSeq(it) && norm(it.name) === norm(exact); })[0] : null;
          row.exists = exact ? !!had : !!stem && (items || []).some(function (it) {
            return isSeq(it) && samePath(it.path, row.bin) && new RegExp('^' + esc(stem) + '\\s+\\d+x\\d+(\\s+\\S+)?$', 'i').test(String(it.name).trim());
          });
          if (had) row.where = had.path;
          row.name = stem ? stem + ' ' + (row.ratio === 'other' ? '…' : (row.ratios && row.ratios.length ? row.ratios.map(function (r) { return r.replace('-', 'x'); }).join('+') : String(row.ratio).replace('-', 'x'))) + ' ' + row.platform : '';
        }
        if (s.type === 'seq_move') row.exists = !!row.src && samePath(row.src.bin, row.bin);
      } catch (e) { row.error = e.message; }
      rows.push(row);
    });
    return rows;
  }

  // Kết quả ảo của một bước (để bước sau tìm) — thêm vào items + results.
  function applyVirtual(s, rows, ctx) {
    var res = [];
    rows.forEach(function (r) {
      if (r.error) { res.push(null); return; }
      if (s.type === 'bin_make') { res.push({ bin: r.bin, binOnly: r.bin }); return; }
      if (s.type === 'seq_make' || s.type === 'seq_clone') {
        if (!r.exists) ctx.items.push({ name: r.name, path: r.bin, isFolder: false, mediaType: 'sequence', virtual: true });
        res.push({ name: r.name, bin: r.bin, ref: r.bin + ' ▸ ' + r.name });
        return;
      }
      if (s.type === 'seq_move') { res.push(r.src ? { name: r.src.name, bin: r.bin, ref: r.bin + ' ▸ ' + r.src.name } : null); return; }
      res.push(r.src ? { name: r.src.name, bin: r.src.bin, ref: r.src.ref } : null);   // resize / raw: kết quả = nguồn
    });
    ctx.results = (ctx.results || []).concat([res]);
    return res;
  }

  // Xem trước cả quy trình (chỉ các khối đơn; khối khác giữ chỗ trống).
  function planFlow(items, steps, targets, date) {
    var ctx = { items: (items || []).slice(), targets: targets, results: [], date: date };
    return steps.map(function (s, i) {
      if (!isType(s.type)) { ctx.results.push(targets.map(function () { return null; })); return { step: i + 1, skip: true }; }
      var rows = planStep(s, i + 1, ctx);
      applyVirtual(s, rows, ctx);
      return { step: i + 1, type: s.type, rows: rows };
    });
  }

  return { TYPES: TYPES, FRAMES: FRAMES, RATIO_TXT: RATIO_TXT, isType: isType, normStep: normStep, problems: problems,
           chips: chips, srcTxt: srcTxt, nameTxt: nameTxt, binTxt: binTxt,
           familyIn: familyIn, nearestPrev: nearestPrev, subst: subst, varsFor: varsFor, fillTpl: fillTpl,
           planStep: planStep, applyVirtual: applyVirtual, planFlow: planFlow };
})();

(function (root) {
  if (root) { root.FLE = FLE; }
  if (typeof module !== "undefined" && module.exports) { module.exports = FLE; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
