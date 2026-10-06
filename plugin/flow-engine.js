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
  var PF = (typeof PPF !== 'undefined') ? PPF : require('./proj-profile.js');

  var TYPES = {
    platform:   { label: 'Nền tảng',       desc: 'chọn FB / GG / PIN / APP — các khối sau tự học bin, tên, khung theo nền tảng' },
    bin_make:   { label: 'Tạo bin',        desc: 'tạo bin theo đường dẫn (mẫu hoặc như bộ trước)' },
    seq_make:   { label: 'Tạo sequence',   desc: 'sequence rỗng cho từng video, tên + cài đặt như bộ trước' },
    seq_clone:  { label: 'Nhân bản',       desc: 'nhân bản một sequence rồi đặt tên mới' },
    seq_resize: { label: 'Resize',         desc: 'đổi khung sequence thành bản mới (tab Resize)' },
    seq_move:   { label: 'Chuyển vào bin', desc: 'chuyển sequence vào bin khác' },
    raw_export: { label: 'Xuất RAW',       desc: 'xuất từng cut ra file (tab RAW)' },
    render:     { label: 'Render',         desc: 'xuất video ra .mp4, tự vào đúng thư mục giao như bộ trước (Output/Facebook/36x…)' }
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
  var PLATS = ['FB', 'GG', 'PIN', 'APP'];
  function nRef(r) {
    if (r && r.k === 'match' && str(r.text, 60).trim()) return { k: 'match', text: str(r.text, 60).trim() };
    return { k: 'base' };
  }
  function nSrc(s) {
    s = s || {};
    if (s.k === 'step') return { k: 'step', n: Math.max(1, parseInt(s.n, 10) || 1) };
    if (s.k === 'prev') return { k: 'prev', ref: nRef(s.ref) };
    if (s.k === 'current') return { k: 'current' };
    if (s.k === 'plat') return { k: 'plat' };
    if (s.k === 'video') return { k: 'video' };
    return { k: 'base' };
  }
  function nName(n) {
    n = n || {};
    if (n.k === 'tpl') return { k: 'tpl', text: str(n.text, 200) };
    if (n.k === 'plat' || !n.k) return { k: 'plat' };
    return { k: 'learn', ref: nRef(n.ref) };
  }
  function nBin(b, def) {
    b = b || def || {};
    if (b.k === 'tpl') return { k: 'tpl', text: str(b.text, 200) };
    if (b.k === 'prev') return { k: 'prev', ref: nRef(b.ref) };
    if (b.k === 'step') return { k: 'step', n: Math.max(1, parseInt(b.n, 10) || 1) };
    if (b.k === 'plat') return { k: 'plat' };
    return { k: 'src' };
  }
  function normStep(s) {
    if (!s || !isType(s.type)) return null;
    var t = s.type, o = { type: t };
    // Mặc định "theo nền tảng" (khối Nền tảng phía trước quyết định bin / tên / khung / ratio)
    if (t === 'platform') {
      o.p = PLATS.indexOf(s.p) >= 0 ? s.p : 'FB';
      if (o.p === 'FB') { o.mode = s.mode === 'resize' ? 'resize' : 'new'; if (o.mode === 'new') o.fps = s.fps === 'project' ? 'project' : '30'; }
    }
    if (t === 'bin_make') o.bin = nBin(s.bin, { k: 'plat' });
    if (t === 'seq_make') { o.name = nName(s.name || { k: 'plat' }); o.frame = FRAMES[s.frame] || s.frame === 'prev' ? s.frame : 'set'; o.bin = nBin(s.bin, { k: 'plat' }); }
    if (t === 'seq_clone') { o.src = nSrc(s.src || { k: 'plat' }); o.name = nName(s.name || { k: 'plat' }); o.bin = nBin(s.bin, { k: 'plat' }); }
    if (t === 'seq_resize') {
      o.src = nSrc(s.src);
      o.ratio = ['other', 'prev', 'plat'].indexOf(s.ratio) >= 0 || FRAMES[s.ratio] ? s.ratio : 'plat';
      o.platform = ['GG', 'FB', 'PIN', 'prev', 'plat'].indexOf(s.platform) >= 0 ? s.platform : 'plat';
      o.bin = nBin(s.bin, { k: 'src' });
    }
    if (t === 'seq_move') { o.src = nSrc(s.src); o.bin = nBin(s.bin, { k: 'tpl', text: '' }); }
    if (t === 'render') o.src = nSrc(s.src || { k: 'video' });
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
    if (s.k === 'plat') return 'khung theo nền tảng';
    if (s.k === 'step') return 'kết quả bước ' + s.n;
    if (s.k === 'prev') return refTxt(s.ref) + ' bộ trước';
    if (s.k === 'current') return 'đang chọn / mở';
    if (s.k === 'video') return 'mọi bản của video (bộ trước đã render)';
    return 'FB gốc';
  }
  function nameTxt(n) { return n.k === 'tpl' ? (n.text || 'mẫu tên?') : n.k === 'plat' ? 'tên theo nền tảng' : 'tên như ' + refTxt(n.ref) + ' bộ trước'; }
  function binTxt(b) {
    if (b.k === 'tpl') return b.text || 'bin?';
    if (b.k === 'prev') return 'bin như ' + refTxt(b.ref) + ' bộ trước';
    if (b.k === 'step') return 'bin bước ' + b.n;
    if (b.k === 'plat') return 'bin theo nền tảng';
    return 'cùng bin nguồn';
  }
  // Chip tóm tắt: [{kind, text, missing?}]
  function chips(s) {
    var out = [{ kind: 'act', text: TYPES[s.type].label }];
    function c(kind, text, miss) { out.push({ kind: kind, text: text, missing: !!miss }); }
    if (s.type === 'platform') { c('par', s.p + (s.p === 'FB' ? ' · ' + (s.mode === 'resize' ? 'resize' : 'tạo mới' + (s.fps === '30' ? ' · 30fps' : '')) : '')); return out; }
    if (s.src) c('seq', srcTxt(s.src));
    if (s.type === 'seq_resize') {
      c('par', s.ratio === 'plat' ? 'ratio theo nền tảng' : s.ratio === 'other' ? 'ratio còn lại' : s.ratio === 'prev' ? 'ratio như bộ trước' : RATIO_TXT[s.ratio]);
      if (s.platform !== 'plat') c('par', s.platform === 'prev' ? 'nhãn như bộ trước' : s.platform);
    }
    if (s.type === 'seq_make') c('par', s.frame === 'set' ? 'khung theo bộ frame' : s.frame === 'prev' ? 'khung như bộ trước' : RATIO_TXT[s.frame]);
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
    // Dạng đuôi: "<SP> vid 19.0 [..][..] Applovin" (VeraComfort) — chữ loại đứng cuối tên
    var reTail = new RegExp('(^|\\s)vid\\s*' + set + '\\s*\\.\\s*(\\d+)(?!\\d).*\\s' + esc(ref.text) + '\\s*$', 'i');
    return (items || []).filter(isSeq).map(function (it) {
      var m = String(it.name).match(re) || String(it.name).trim().match(reTail);
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
    t = t.replace(new RegExp('(^|\\D)' + from.set + '(?=\\.?x\\b)', 'g'), '$1' + to.set);   // "35x", "2.x" (StretchMotions)
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

  // ── Học theo nền tảng (khối Nền tảng phía trước) ─────────────────────────
  function ggRe() { return new RegExp('(^|\\s)(?:' + PF.alt('GG') + ')\\s+(\\S+)\\s+vid\\s*(\\d+)\\s*\\.\\s*(\\d+)(?!\\d)', 'i'); }
  // Bin mang chữ nền tảng (đứng riêng hoặc là một từ trong tên bin: "Ads GGL", "Google / v1").
  function inPlat(path, P) { return new RegExp('(^|/)[^/]*(^|[\\s_\\-])(' + PF.alt(P) + ')([\\s_\\-][^/]*)?\\s*(/|$)', 'i').test(String(path || '')); }
  // Bin chứa đồ GG của video set.idx (bản sao "{bộ}.{số}" hoặc khung "GG … vid…") ở một bộ.
  function ggBinOf(items, set, idx) {
    var hit = (items || []).filter(function (it) {
      if (!isSeq(it) || !inPlat(it.path, 'GG')) return false;
      var v = vidOf(it.name), nm = String(it.name).trim();
      return (v && v.set === set && v.idx === idx) || nm === set + '.' + idx || nm.indexOf(set + '.' + idx + ' ') === 0;
    })[0];
    return hit ? hit.path : '';
  }
  // ── GG: khung CỨNG mỗi video = 2 material + 3 đích (user 2026-10-06) ─────────────
  //   material 1 = bản sao FB gốc · material 2 = resize material 1 sang ratio còn lại (9:16 ⇄ 4:5)
  //   đích 9:16 · 16:9 · 1:1 = NHÂN BẢN khung cùng loại của bộ trước. Tên + bin khác nhau theo project:
  //   "SP GG dọc vid35.0 […]" trong "Sequence / GG / 35x / 35.0" (chuẩn) hay
  //   "SP vid 22.0 […] 9x16 GG" trong "Timeline / Google / 22x", material ở ".../22x/Draft" (VeraComfort).
  var GG_KINDS = ['9-16', '16-9', '1-1'];
  var GG_KIND_TXT = { '9-16': '9:16 (dọc)', '16-9': '16:9 (ngang)', '1-1': '1:1 (vuông)' };
  var MATERIAL_SEG = /^(draft|drafts|material|materials|nguon|nguồn|src|source|raw|old|resource|tai nguyen|tài nguyên)$/i;
  function ggKind(name) {
    var n = String(name || '').toLowerCase();
    try { n = n.normalize('NFC'); } catch (e) {}
    if (/(^|\W)(dọc|doc|vertical|9x16|9-16|916)(\W|$)/.test(n)) return '9-16';
    if (/(^|\W)(ngang|horizontal|landscape|16x9|16-9|169)(\W|$)/.test(n)) return '16-9';
    if (/(^|\W)(vuông|vuong|square|1x1|1-1|11)(\W|$)/.test(n)) return '1-1';
    return '';
  }
  function ggArea(it) { return inPlat(it.path, 'GG') || new RegExp('(^|\\s)(' + PF.alt('GG') + ')(\\s|$)', 'i').test(String(it.name)); }
  function isMaterial(it, set, idx) {
    var nm = String(it.name).trim();
    if (new RegExp('^' + set + '\\.' + idx + '(?![\\d.])').test(nm)) return true;               // "35.0", "35.0 4x5 GG"
    if (String(it.path || '').split('/').some(function (s) { return MATERIAL_SEG.test(s.trim()); })) return true;
    return /(^|\s)4x5(\s|$)/i.test(nm);                                                         // resize 4:5 = material
  }
  // 3 đích của bộ gần nhất có (mỗi loại tìm riêng, ưu tiên cùng số video). Thiếu loại → {err}.
  function ggTargets(items, set, idx) {
    var sets = prevSets(items, set), out = [];
    GG_KINDS.forEach(function (kind) {
      var hit = null;
      for (var i = 0; i < sets.length && !hit; i++) {
        var pool = videoSeqs(items, sets[i], idx);
        var cand = pool.filter(function (it) { return ggArea(it) && !isMaterial(it, sets[i], idx) && ggKind(it.name) === kind; })[0];
        if (!cand) {                                  // video khác của bộ đó (bộ trước có ít video hơn)
          (items || []).some(function (it) {
            var v = isSeq(it) && vidOf(it.name);
            if (!v || v.set !== sets[i] || !ggArea(it) || isMaterial(it, v.set, v.idx) || ggKind(it.name) !== kind) return false;
            cand = it; return true;
          });
        }
        if (cand) { var v2 = vidOf(cand.name) || { set: sets[i], idx: idx }; hit = { item: cand, set: v2.set, idx: v2.idx, label: GG_KIND_TXT[kind], kind: kind }; }
      }
      out.push(hit || { err: 'bộ trước chưa có khung GG ' + GG_KIND_TXT[kind] + ' để nhân bản', label: GG_KIND_TXT[kind] });
    });
    return out;
  }
  // Material của bộ trước (bản sao / resize) → bin + tên bản sao cho video đích.
  function ggMaterial(items, set, idx) {
    var to = { set: Number(set), idx: Number(idx) }, sets = prevSets(items, set);
    for (var i = 0; i < sets.length; i++) {
      for (var k = 0; k < 2; k++) {
        var j = k ? 0 : Number(idx);
        var mats = videoSeqs(items, sets[i], j).concat((items || []).filter(function (it) {
          return isSeq(it) && new RegExp('^' + sets[i] + '\\.' + j + '(?![\\d.])').test(String(it.name).trim());
        })).filter(function (it) { return ggArea(it) && isMaterial(it, sets[i], j); });
        if (!mats.length) continue;
        var from = { set: sets[i], idx: j };
        var copy = mats.filter(function (it) { return !/\d+x\d+/i.test(it.name); })[0];
        return { bin: subst(mats[0].path, from, to), copyName: copy ? subst(copy.name, from, to) : '' };
      }
    }
    // Không có material bộ trước: cạnh 3 đích; bin đích có bin con kiểu "Draft" ở bộ trước → vào đó
    var t = ggTargets(items, set, idx).filter(function (x) { return x.item; })[0];
    if (!t) return null;
    var tbin = subst(t.item.path, { set: t.set, idx: t.idx }, to);
    var sub = (items || []).filter(function (it) {
      return it.isFolder && MATERIAL_SEG.test(String(it.name).trim()) && samePath(it.path, t.item.path);
    })[0];
    return { bin: sub ? tbin + ' / ' + String(sub.name).trim() : tbin, copyName: '' };
  }
  function prevSets(items, set) {
    var sets = {};
    (items || []).forEach(function (it) { var v = isSeq(it) && vidOf(it.name); if (v && v.set < Number(set)) sets[v.set] = 1; });
    return Object.keys(sets).map(Number).sort(function (a, b) { return b - a; });
  }
  // PIN: bin "Order <ngày>" theo đúng định dạng ngày của đơn gần nhất ("Sep 29 26" | "070826").
  function pinOrderBin(items, date) {
    var d = date || new Date(), dd = d.getDate(), mm = d.getMonth() + 1, yy = d.getFullYear() % 100;
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    var best = null;
    (items || []).forEach(function (it) {
      var full = it.isFolder ? (it.path ? it.path + ' / ' : '') + it.name : it.path;
      var m = String(full || '').match(/^(.*\/\s*)?(Order)\s+([A-Za-z]{3} \d{2} \d{2}|\d{6})\s*$/i);
      if (!m || !inPlat(full, 'PIN')) return;
      var t = m[3], when;
      if (/^\d{6}$/.test(t)) when = new Date(2000 + Number(t.slice(4)), Number(t.slice(2, 4)) - 1, Number(t.slice(0, 2)));
      else when = new Date(2000 + Number(t.slice(-2)), MON.indexOf(t.slice(0, 3)), Number(t.slice(4, 6)));
      if (!best || when > best.when) best = { when: when, parent: (m[1] || 'Sequence / PIN / ').replace(/\s*$/, ' '), word: m[2], num: /^\d{6}$/.test(t) };
    });
    var day = best && best.num ? p2(dd) + p2(mm) + p2(yy) : MON[d.getMonth()] + ' ' + p2(dd) + ' ' + p2(yy);
    return (best ? best.parent + best.word : 'Sequence / PIN / Order') + ' ' + day;
  }
  // PIN (quy định 2026-10-05): mọi video của lượt chạy cùng MỘT bộ → bin "{bộ}x" cạnh các đơn
  // (Sequence / PIN / 36x); lẫn nhiều bộ → bin đơn "Order <ngày>".
  // Bản PIN của bộ gần nhất (bin chứa chữ PIN/Pinterest, tên có vid{bộ}.{số}) → {item, set, idx} | null
  function pinPrev(items, set, idx) {
    var best = null;
    (items || []).forEach(function (it) {
      if (!isSeq(it) || !inPlat(it.path, 'PIN')) return;
      var v = vidOf(it.name);
      if (!v || v.set >= Number(set)) return;
      if (/\/\s*(material|materials|draft)\s*$/i.test(String(it.path))) return;   // bản sao gốc để làm material
      var sc = v.set * 10 + (v.idx === Number(idx) ? 1 : 0);
      if (!best || sc > best.sc) best = { sc: sc, item: it, set: v.set, idx: v.idx };
    });
    return best;
  }
  function pinBin(items, date, targets) {
    var sets = {};
    (targets || []).forEach(function (t) { sets[String(t.set)] = 1; });
    var ks = Object.keys(sets);
    var order = pinOrderBin(items, date);
    // Nương theo các bộ PIN gần nhất (user 2026-10-06): bộ trước nằm bin đơn "Order <ngày>" → đơn hôm nay;
    // nằm bin theo bộ ("Pinterest / 21x") → bin bộ mới. Lẫn nhiều bộ trong một lượt → bin đơn.
    var t0 = targets && targets[0], pp = t0 ? pinPrev(items, t0.set, t0.idx) : null;
    if (pp) {
      var last = String(pp.item.path).split('/').map(function (x) { return x.trim(); }).pop();
      var parent = String(pp.item.path).replace(/\s*\/\s*[^/]*$/, '');
      if (/^order\b/i.test(last)) return parent + ' / ' + order.split(' / ').pop();
      if (ks.length === 1) {
        var to = { set: Number(ks[0]), idx: Number(t0.idx) }, learned = subst(pp.item.path, { set: pp.set, idx: pp.idx }, to);
        if (learned !== pp.item.path) return learned;
      } else return parent + ' / ' + order.split(' / ').pop();
    }
    var learnedOrder = (items || []).some(function (it) {
      var full = it.isFolder ? (it.path ? it.path + ' / ' : '') + it.name : it.path;
      return /\/\s*order\s+([A-Za-z]{3} \d{2} \d{2}|\d{6})\s*$/i.test(String(full || '')) && inPlat(full, 'PIN');
    });
    var tpl = PF.binTpl('PIN');
    if (!learnedOrder && tpl && /\{bộ\}/.test(tpl)) {
      // project chưa từng có bin đơn → mẫu bin PIN của project; lẫn bộ → "Order <ngày>" cạnh các bin {bộ}x
      if (ks.length === 1) return tpl.replace(/\{bộ\}/g, ks[0]).replace(/\{số\}/g, '0');
      return tpl.replace(/[^/]*\{bộ\}[^/]*$/, '').replace(/\s*\/?\s*$/, ' / ') + order.split(' / ').pop();
    }
    if (ks.length !== 1) return order;
    return order.replace(/[^/]*$/, '').replace(/\s*$/, ' ') + ks[0] + 'x';
  }
  function platBin(items, P, set, idx, date, targets) {
    var to = { set: Number(set), idx: Number(idx) };
    if (P === 'PIN') return pinBin(items, date, targets);
    if (P === 'GG') {
      var tg0 = ggTargets(items, set, idx).filter(function (x) { return x.item; })[0];
      if (tg0) return subst(tg0.item.path, { set: tg0.set, idx: tg0.idx }, to);
      var sets = prevSets(items, set);
      for (var i = 0; i < sets.length; i++) {
        var path = ggBinOf(items, sets[i], idx) || ggBinOf(items, sets[i], 0);
        if (path) {
          var from = { set: sets[i], idx: ggBinOf(items, sets[i], idx) ? Number(idx) : 0 };
          return subst(path, from, to);
        }
      }
      return defBin('GG', set, idx, 'Sequence / ' + PF.alias('GG') + ' / {bộ}x / {bộ}.{số}');
    }
    var ref = P === 'APP' ? { k: 'match', text: 'AppLovin' } : { k: 'base' };
    var p = nearestPrev(items, ref, set, idx);
    if (p) {
      var learned = subst(p.item.path, { set: p.set, idx: p.idx }, to);
      // Bộ trước để trong bin KHÔNG có số bộ ("Sequence / Applovin", "Sequence / APP / 13.11") mà hồ sơ đã học được
      // mẫu "{bộ}x" của nền tảng → theo mẫu (LiftCharm / StretchMotions 2026-10-06)
      var tplB = PF.binTpl(P);
      if (tplB && /\{bộ\}/.test(tplB) && !new RegExp('(^|\\D)' + set + '(x|\\.|\\b)').test(learned)) return defBin(P, set, idx, tplB);
      return learned;
    }
    return defBin(P, set, idx, 'Sequence / ' + PF.alias(P) + ' / {bộ}x');
  }
  // Chưa có bộ trước: mẫu bin học từ project (hồ sơ quy ước), không có thì mặc định.
  function defBin(P, set, idx, fallback) {
    return (PF.binTpl(P) || fallback).replace(/\{bộ\}/g, set).replace(/\{số\}/g, idx);
  }
  // Khung / template để nhân bản theo nền tảng: GG = mọi khung "GG <loại>" của bộ gần nhất có
  // (ưu tiên cùng số video); APP = bản AppLovin bộ trước. → [{item, set, idx, label}]
  function platTemplates(items, P, set, idx) {
    if (P === 'APP') {
      var a = nearestPrev(items, { k: 'match', text: 'AppLovin' }, set, idx);
      return a ? [{ item: a.item, set: a.set, idx: a.idx, label: 'AppLovin' }] : [];
    }
    if (P !== 'GG') return [];
    return ggTargets(items, set, idx);
  }
  function platTemplatesOld(items, P, set, idx) {
    var sets = prevSets(items, set);
    for (var i = 0; i < sets.length; i++) {
      var by = {};
      (items || []).forEach(function (it) {
        var m = isSeq(it) && String(it.name).match(ggRe());
        if (!m || Number(m[3]) !== sets[i]) return;
        var lab = m[2], same = Number(m[4]) === Number(idx), cur = by[lab.toLowerCase()];
        if (!cur || (same && !cur.same)) by[lab.toLowerCase()] = { item: it, set: sets[i], idx: Number(m[4]), label: lab, same: same };
      });
      var out = Object.keys(by).map(function (k) { return by[k]; });
      if (out.length) return out;
    }
    return [];
  }
  // Ratio + nhãn resize theo nền tảng → {ratios:[…]|null (=ratio còn lại), label}
  function platResize(items, P, set, idx) {
    if (P === 'PIN') return { ratios: ['2-3'], label: 'PIN' };
    if (P === 'GG') {
      // material 2 = ratio CÒN LẠI (9:16 ⇄ 4:5); nhãn ("GG" / "FB") học từ bản resize bộ trước
      var sp = B.res2Spec(items, 'GG', set, idx);
      return { ratios: null, label: sp.from ? sp.platform : 'GG' };
    }
    if (P === 'APP') return { error: 'APP không resize — dùng Nhân bản khung theo nền tảng' };
    return { ratios: null, label: 'FB' };
  }
  // Tên bản sao FB gốc trong bin GG: học từ bản "{bộ}.{số}" của bộ trước (vd "35.1") → "36.1".
  function platCopyName(items, P, set, idx) {
    var f = familyIn(items, { k: 'base' }, set).filter(function (x) { return x.idx === Number(idx); })[0];
    if (P === 'GG') { var gm = ggMaterial(items, set, idx); return (gm && gm.copyName) || (f ? f.item.name : set + '.' + idx); }
    if (P === 'APP' && f) return String(f.item.name).replace(/(^|\s)(vid\s*\d)/i, '$1AppLovin $2');
    return f ? f.item.name : '';
  }

  // ── Render: học thư mục giao từ file đã render ở bộ trước ─────────────────
  // files = [{dir:'Google/35x/35.0', name:'SonaShape GG Dọc vid35.0 [..] [..]'}] (bridge /render/index).
  function numOf(name) {
    var v = vidOf(name);
    if (v) return v;
    var m = String(name).match(/(?:^|[^\d.])(?:aiv\s*)?(\d+)\.(\d+)(?![\d.])/i);
    return m ? { set: Number(m[1]), idx: Number(m[2]) } : null;
  }
  // Tên file trên Drive hay ở dạng NFD (dấu tách rời) → chuẩn NFC trước khi so; bỏ " (1)", "-" thừa ở đuôi.
  function nfc(s) { var t = String(s || ''); try { t = t.normalize('NFC'); } catch (e) {} return t; }
  // So "loại" bản render: bỏ tag người làm [..] (bộ 39 [c.trang…] vs bộ 40 [c.uyen…] — bug 2026-10-05).
  function fkey(s) {
    var t = nfc(s).replace(/\[[^\]]*\]/g, ' ');
    return norm(t.replace(/\s*\(\d+\)/g, '').replace(/[-_]+$/, ''));
  }
  var RENDER_LOOKBACK = 6;     // chỉ học từ 6 bộ gần nhất (file cũ / nháp ở bộ xa không tính)
  // → {dir, from:{set, idx}} | null — bộ gần nhất trước đó, ưu tiên cùng số video
  function renderDest(files, name, set, idx, order) {
    var to = { set: Number(set), idx: Number(idx) }, want = fkey(name), best = null;
    (files || []).forEach(function (f) {
      var n = numOf(f.name);
      if (!n || n.set >= to.set || n.set < to.set - RENDER_LOOKBACK) return;
      if (fkey(subst(f.name, n, to)) !== want) return;
      var score = n.set * 10 + (n.idx === to.idx ? 1 : 0);
      if (!best || score > best.score) best = { score: score, dir: subst(nfc(f.dir), n, to), from: n };
    });
    if (!best) return null;
    // Đơn PIN: bộ trước nằm ở "Pinterest/Order <ngày cũ>" → vào đơn của bin hiện tại (cùng tên "Order …")
    var segs = best.dir.split('/'), last = segs[segs.length - 1];
    // PIN: bộ trước ở "Pinterest/Order <ngày cũ>" hay "Pinterest/35x" → theo bin hiện tại ("Order <ngày>" | "36x")
    if (/^order\b|^\d+x$/i.test(last) && /^pinterest$|^pin$/i.test(segs[segs.length - 2] || '')) {
      var ob = String(order || '').split('/').map(function (x) { return x.trim(); }).filter(Boolean).pop() || '';
      if (/^order\b|^\d+x$/i.test(ob)) segs[segs.length - 1] = ob;
    }
    return { dir: segs.join('/'), from: best.from };
  }
  // Chưa có bộ nào đã render để học → chỗ mặc định theo nền tảng, chỉ cho BẢN GIAO (khung GG, AppLovin, 2x3 PIN,
  // FB gốc). Thư mục nền tảng lấy đúng tên đang có trong Output ("FB" ở SAMX, "Facebook" ở ổ team…).
  var PLAT_DIR = { FB: 'Facebook', GG: 'Google', PIN: 'Pinterest', APP: 'Applovin' };
  function deliverable(items, P, name, set, idx) {
    if (P === 'GG') return ggRe().test(name);
    if (P === 'APP') return /applovin/i.test(name);
    if (P === 'PIN') return /\b2x3\b/i.test(name) && new RegExp('(^|\\s)(' + PF.alt('PIN') + ')\\s*$', 'i').test(name);
    if (P === 'FB') return familyIn(items, { k: 'base' }, set).some(function (f) { return f.idx === Number(idx) && f.item.name === name; });
    return false;
  }
  function defaultRenderDir(dirs, P, set, idx, bin) {
    var top = (dirs || []).filter(function (d) { return PF.platOf(d) === P; })[0] || PLAT_DIR[P];
    if (P === 'GG') return top + '/' + set + 'x/' + set + '.' + idx;
    if (P === 'PIN') {
      var last = String(bin || '').split('/').map(function (x) { return x.trim(); }).filter(Boolean).pop() || '';
      return top + '/' + (/^order\b|^\d+x$/i.test(last) ? last : set + 'x');
    }
    return top + '/' + set + 'x';
  }

  // Mọi sequence của video set.idx: tên có vid{set}.{idx}, hoặc mở đầu "{set}.{idx}" (bản sao / resize tài nguyên)
  function videoSeqs(items, set, idx) {
    var re = new RegExp('^' + set + '\\.' + idx + '(?![\\d.])');
    return (items || []).filter(function (it) {
      if (!isSeq(it)) return false;
      var v = vidOf(it.name);
      return (v && v.set === Number(set) && v.idx === Number(idx)) || re.test(String(it.name).trim());
    });
  }

  // ── Lập kế hoạch một bước ─────────────────────────────────────────────────
  // ctx = {items, targets:[{set, idx}], results:[…], platform:'FB'|…, frames:{idx:'9-16'}, date}
  // → rows [{key, ti, set, idx, name, bin, src, exists, error, frame?, like?, ratio?, ratios?, platform?, label?}]
  function planStep(s, n, ctx) {
    var items = ctx.items || [], rows = [], P = ctx.platform || '';
    if (s.type === 'platform') { ctx.platform = s.p; ctx.platMode = s.mode || ''; ctx.fps = s.fps || ''; return rows; }
    function needP() { if (!P) throw new Error('chưa có khối Nền tảng phía trước'); }
    (ctx.targets || []).forEach(function (tg, ti) {
      var set = String(tg.set), idx = Number(tg.idx), to = { set: Number(set), idx: idx };
      var v = varsFor(items, set, idx, ctx.date);
      function stepRes(k) {
        var r = ctx.results && ctx.results[k - 1] && ctx.results[k - 1][ti];
        if (!r) throw new Error('bước ' + k + ' chưa có kết quả cho vid' + set + '.' + idx);
        return r;
      }
      // Nhân bản "khung theo nền tảng" → một dòng cho mỗi khung (GG Dọc / Ngang / Vuông…)
      var variants = [null];
      if (s.type === 'render' && s.src && s.src.k === 'video') {
        variants = videoSeqs(items, set, idx).map(function (it) { return { item: it, set: Number(set), idx: idx, label: it.name, video: true }; });
        if (!variants.length) variants = [{ err: 'chưa có sequence nào của vid' + set + '.' + idx }];
      }
      if (s.src && s.src.k === 'plat') {
        try { needP(); variants = platTemplates(items, P, set, idx); } catch (e) { variants = [{ err: e.message }]; }
        if (!variants.length) variants = [{ err: 'chưa có khung ' + P + ' ở bộ trước để nhân bản' }];
      }
      variants.forEach(function (tpl) {
        var row = { key: set + '.' + idx + (tpl && tpl.label ? ' · ' + tpl.label : ''), ti: ti, set: set, idx: idx };
        try {
          if (tpl && tpl.err) throw new Error(tpl.err);
          // nguồn
          if (s.src) {
            if (tpl) row.src = { ref: refOf(tpl.item), name: tpl.item.name, bin: tpl.item.path, prev: tpl.video ? undefined : tpl.set };
            else if (s.src.k === 'base') {
              var f = familyIn(items, { k: 'base' }, set).filter(function (x) { return x.idx === idx; })[0];
              if (!f) throw new Error('không thấy FB gốc vid' + set + '.' + idx);
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
            } else if (s.name.k === 'plat') {
              needP();
              if (tpl) row.name = subst(tpl.item.name, { set: tpl.set, idx: tpl.idx }, to);
              else if (s.type === 'seq_make') {
                var pb0 = nearestPrev(items, { k: 'base' }, set, idx);
                if (!pb0) throw new Error('chưa có bộ trước để học tên');
                row.name = subst(pb0.item.name, { set: pb0.set, idx: pb0.idx }, to);
              } else {
                row.name = platCopyName(items, P, set, idx);
                if (!row.name) throw new Error('chưa học được tên ' + P + ' cho vid' + set + '.' + idx);
              }
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
            } else if (s.bin.k === 'plat') {
              needP();
              if (tpl && tpl.item && P === 'GG') row.bin = subst(tpl.item.path, { set: tpl.set, idx: tpl.idx }, to);
              else if (P === 'GG' && s.type === 'seq_clone' && s.src && s.src.k === 'base') {
                var gmb = ggMaterial(items, set, idx);
                row.bin = gmb ? gmb.bin : platBin(items, P, set, idx, ctx.date, ctx.targets);
              } else row.bin = platBin(items, P, set, idx, ctx.date, ctx.targets);
            }
            else if (s.bin.k === 'prev') {
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
            // Bin học từ bộ trước mà không chứa số bộ ("Sequence / FB", "Bộ 39"…) → ra đúng bin cũ, coi là
            // "đã có" và không tạo gì — dễ tưởng lỗi. Ghi chú để thẻ xem trước nói rõ.
            if ((s.bin.k === 'plat' || s.bin.k === 'prev') && !new RegExp('(^|\\D)' + set + '(\\D|$)').test(row.bin)) row.note = 'bin bộ trước không có số bộ → dùng chung bin "' + row.bin + '"';
            row.exists = (items || []).some(function (it) { return it.isFolder && samePath((it.path ? it.path + ' / ' : '') + it.name, row.bin); })
                      || (items || []).some(function (it) { return !it.isFolder && samePath(it.path, row.bin); });
          }
          if (s.type === 'seq_make') {
            if (ctx.fps === '30') row.fps = '30';
            var pl = nearestPrev(items, { k: 'base' }, set, idx);
            // "theo bộ frame": phiếu chạy chọn 1 trong 2 — theo bộ cũ (frames = null → chép cài đặt video
            // cùng số bộ trước) hoặc tự chọn (frames {số: ratio} → cài đặt mặc định project + khung đó).
            if (s.frame === 'set' && ctx.frames) {
              var fr = ctx.frames[idx];
              if (!FRAMES[fr]) throw new Error('chưa chọn khung cho vid' + set + '.' + idx + ' (bộ frame)');
              row.frame = FRAMES[fr]; row.frameKey = fr;
            } else if (s.frame === 'set' || s.frame === 'prev') {
              if (!pl) throw new Error('chưa có bộ trước để chép cài đặt sequence');
              row.like = { ref: refOf(pl.item), name: pl.item.name };
            } else row.frame = FRAMES[s.frame];
          }
          if (s.type === 'seq_make' || s.type === 'seq_clone') {
            var sameAsSrc = row.src && row.src.name && norm(row.src.name) === norm(row.name);
            row.exists = (items || []).some(function (it) { return isSeq(it) && norm(it.name) === norm(row.name) && (!sameAsSrc || samePath(it.path, row.bin)); });
          }
          if (s.type === 'seq_resize') {
            row.ratio = s.ratio; row.platform = s.platform;
            if (s.ratio === 'plat' || s.platform === 'plat') {
              needP();
              var pr = platResize(items, P, set, idx);
              if (pr.error) throw new Error(pr.error);
              if (s.ratio === 'plat') { if (pr.ratios) { row.ratio = pr.ratios.length === 1 ? pr.ratios[0] : 'prev'; row.ratios = pr.ratios; } else row.ratio = 'other'; }
              if (s.platform === 'plat') row.platform = pr.label;
            }
            if (s.ratio === 'prev' || s.platform === 'prev') {
              var hint = ['GG', 'PIN', 'FB', 'APP'].filter(function (q) { return inPlat(row.bin, q); })[0] || 'GG';
              var spec = B.res2Spec(items, hint.toUpperCase(), set, idx);
              if (s.ratio === 'prev') { if (spec.from) row.ratios = spec.ratios; else row.ratio = 'other'; }
              if (s.platform === 'prev') row.platform = spec.from ? spec.platform : 'FB';
              row.learnedFrom = spec.from || null;
            }
            if (row.platform === 'PIN' && (s.src.k === 'base')) {
              var pv0 = pinPrev(items, set, idx);
              if (pv0) row.nameOverride = subst(pv0.item.name, { set: pv0.set, idx: pv0.idx }, to);
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
            if (row.nameOverride) {
              row.exists = (items || []).some(function (it) { return isSeq(it) && norm(it.name) === norm(row.nameOverride); });
              row.name = row.nameOverride;
            } else row.name = stem ? stem + ' ' + (row.ratio === 'other' ? '…' : (row.ratios && row.ratios.length ? row.ratios.map(function (r) { return r.replace('-', 'x'); }).join('+') : String(row.ratio).replace('-', 'x'))) + ' ' + row.platform : '';
          }
          if (s.type === 'seq_move') row.exists = !!row.src && samePath(row.src.bin, row.bin);
          if (s.type === 'render') {
            row.name = row.src && row.src.name;
            if (ctx.renderFiles) {
              var rd = renderDest(ctx.renderFiles, row.name, set, idx, row.src && row.src.bin);
              var top = rd ? PF.platOf(rd.dir.split('/')[0]) : '';
              if (!rd && P && deliverable(items, P, row.name, set, idx)) {
                rd = { dir: defaultRenderDir(ctx.renderDirs, P, set, idx, row.src && row.src.bin), from: null }; top = P;
              }
              if (!rd) row.skip = 'bộ trước chưa render loại này';
              else if (P && top && top !== P) row.skip = 'bản ' + top + ' — quy trình này chỉ render ' + P;
              else {
                row.dest = rd.dir; row.learnedFrom = rd.from ? rd.from.set + '.' + rd.from.idx : '';
                row.exists = ctx.renderFiles.some(function (f) { return samePath(f.dir, rd.dir) && fkey(f.name) === fkey(row.name); });
              }
            }
          }
        } catch (e) { row.error = e.message; }
        rows.push(row);
      });
    });
    return rows;
  }

  // Kết quả ảo của một bước (để bước sau tìm) — thêm vào items + results.
  function applyVirtual(s, rows, ctx) {
    var res = (ctx.targets || []).map(function () { return null; });
    if (s.type === 'platform') { ctx.results = (ctx.results || []).concat([res]); return res; }
    rows.forEach(function (r) {
      var ti = r.ti != null ? r.ti : rows.indexOf(r);
      if (r.error) return;
      var out;
      if (s.type === 'bin_make') out = { bin: r.bin, binOnly: r.bin };
      else if (s.type === 'seq_make' || s.type === 'seq_clone') {
        if (!r.exists) ctx.items.push({ name: r.name, path: r.bin, isFolder: false, mediaType: 'sequence', virtual: true });
        out = { name: r.name, bin: r.bin, ref: r.bin + ' ▸ ' + r.name };
      } else if (s.type === 'seq_move') out = r.src ? { name: r.src.name, bin: r.bin, ref: r.bin + ' ▸ ' + r.src.name } : null;
      else out = r.src ? { name: r.src.name, bin: r.src.bin, ref: r.src.ref } : null;   // resize / raw / render: kết quả = nguồn
      if (out && !res[ti]) res[ti] = out;                                                // nhiều khung / video → giữ dòng đầu
    });
    ctx.results = (ctx.results || []).concat([res]);
    return res;
  }

  // Xem trước cả quy trình (chỉ các khối đơn; khối khác giữ chỗ trống).
  function planFlow(items, steps, targets, date, frames) {
    var ctx = { items: (items || []).slice(), targets: targets, results: [], date: date, frames: frames || null };
    return steps.map(function (s, i) {
      if (!isType(s.type)) { ctx.results.push(targets.map(function () { return null; })); return { step: i + 1, skip: true }; }
      var rows = planStep(s, i + 1, ctx);
      applyVirtual(s, rows, ctx);
      return { step: i + 1, type: s.type, rows: rows };
    });
  }

  return { renderDest: renderDest, videoSeqs: videoSeqs, TYPES: TYPES, FRAMES: FRAMES, PLATS: PLATS, platBin: platBin, platTemplates: platTemplates, platResize: platResize, pinOrderBin: pinOrderBin, RATIO_TXT: RATIO_TXT, isType: isType, normStep: normStep, problems: problems,
           chips: chips, srcTxt: srcTxt, nameTxt: nameTxt, binTxt: binTxt,
           familyIn: familyIn, nearestPrev: nearestPrev, subst: subst, varsFor: varsFor, fillTpl: fillTpl,
           planStep: planStep, applyVirtual: applyVirtual, planFlow: planFlow };
})();

(function (root) {
  if (root) { root.FLE = FLE; }
  if (typeof module !== "undefined" && module.exports) { module.exports = FLE; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
