// plugin/resize-core.js — logic thuần của tab Resize: nhận diện ratio, đặt tên,
// chọn ratio đích, nhận diện logo. Không đụng Premiere nên test được bằng Node
// (bridge/test/resize-core.test.js).
//
// Port nguyên văn từ 1-Click Resizer (jsx/resize-core.jsx, v1.10.3) —
// https://github.com/tungnguyen1202/1-click-resizer. Sửa ở đây thì giữ ES5
// (không let/const/arrow) cho khớp phần còn lại của plugin.

var RSZ = (function () {
  var EPS = 0.02;
  var RATIOS = {
    "9-16": { w: 1080, h: 1920 },
    "4-5":  { w: 1080, h: 1350 },
    "1-1":  { w: 1080, h: 1080 },
    "2-3":  { w: 1080, h: 1620 }   // Pinterest (PIN) target only
  };
  // The GG cross-resize set (a source in here produces the other two). 2-3 is
  // deliberately NOT in ORDER: it's a PIN-only target and must never be a GG
  // source or be picked by detectRatio.
  var ORDER = ["9-16", "4-5", "1-1"];
  // Internal ratio keys stay "9-16"; the name suffix uses the "x" style.
  var LABELS = { "9-16": "9x16", "4-5": "4x5", "1-1": "1x1", "2-3": "2x3" };
  // Every trailing ratio label we recognise when stripping (new + legacy dash
  // form), so re-resizing a file named either way swaps cleanly.
  var STRIP_SUFFIXES = ["9x16", "4x5", "1x1", "2x3", "9-16", "4-5", "1-1", "2-3"];
  // Platform tags appended after the ratio label, e.g. "... 4x5 GG".
  var PLATFORM_TAGS = ["GG", "FB", "PIN"];
  // Which ratios each button may produce. The source's own ratio is always
  // dropped, so FB from a 1:1 source offers BOTH 9:16 and 4:5, while FB from
  // 9:16 offers only 4:5.
  var PLATFORM_TARGETS = {
    "GG":  ["9-16", "4-5", "1-1"],   // Google
    "FB":  ["9-16", "4-5"],          // Facebook
    "PIN": ["2-3"]                   // Pinterest
  };

  function contains(arr, v) {
    if (!arr) { return false; }
    for (var i = 0; i < arr.length; i++) { if (arr[i] === v) { return true; } }
    return false;
  }

  function aspectOf(w, h) { return w / h; }

  function detectRatio(w, h) {
    if (!w || !h) { return null; }
    var a = aspectOf(w, h);
    var best = null;
    var bestDiff = EPS;
    for (var i = 0; i < ORDER.length; i++) {
      var r = RATIOS[ORDER[i]];
      var diff = Math.abs(aspectOf(r.w, r.h) - a);
      if (diff <= bestDiff) { bestDiff = diff; best = ORDER[i]; }
    }
    return best;
  }

  function gcd(a, b) {
    a = Math.abs(a); b = Math.abs(b);
    while (b) { var t = a % b; a = b; b = t; }
    return a;
  }

  // A readable label for ANY frame size. This is DISPLAY ONLY and deliberately
  // separate from detectRatio: the panel should be able to tell you what a
  // sequence is even when it will never resize it (2:3 is the obvious case —
  // recognised here, but still not a GG/FB source). Named ratios keep their
  // familiar label; anything else is reduced (1920×1080 -> "16 : 9") or, when the
  // reduction is unwieldy, approximated with a small denominator.
  function describeRatio(w, h) {
    if (!(w > 0) || !(h > 0)) { return null; }
    var a = aspectOf(w, h);
    for (var key in RATIOS) {
      if (!RATIOS.hasOwnProperty(key)) { continue; }
      var r = RATIOS[key];
      if (Math.abs(aspectOf(r.w, r.h) - a) <= EPS) {
        return LABELS[key].replace("x", " : ");
      }
    }
    var g = gcd(w, h) || 1;
    var rw = w / g, rh = h / g;
    if (rw <= 64 && rh <= 64) { return rw + " : " + rh; }
    var bestN = 0, bestD = 1, bestErr = -1;
    for (var d = 1; d <= 32; d++) {
      var n = Math.round(a * d);
      if (n < 1) { continue; }
      var err = Math.abs(n / d - a);
      if (bestErr < 0 || err < bestErr) { bestErr = err; bestN = n; bestD = d; }
    }
    return "≈ " + bestN + " : " + bestD;
  }

  function otherRatios(label) {
    var out = [];
    for (var i = 0; i < ORDER.length; i++) {
      if (ORDER[i] !== label) { out.push(ORDER[i]); }
    }
    return out;
  }

  function rtrimSpaces(name) {
    while (name.length && name.charAt(name.length - 1) === " ") {
      name = name.substring(0, name.length - 1);
    }
    return name;
  }

  // Remove one trailing " " + token from `list` if present; return name unchanged
  // otherwise.
  function stripOneTrailing(name, list) {
    for (var i = 0; i < list.length; i++) {
      var suffix = " " + list[i];
      if (name.length >= suffix.length &&
          name.substring(name.length - suffix.length) === suffix) {
        return name.substring(0, name.length - suffix.length);
      }
    }
    return name;
  }

  // The ratios a run should actually create: the platform's set, minus the
  // source's own ratio, intersected with `wanted` (the ticked boxes). An empty
  // or missing `wanted` means "everything this platform offers".
  function targetsFor(platform, sourceRatio, wanted) {
    var base = PLATFORM_TARGETS[platform] || [];
    var out = [];
    for (var i = 0; i < base.length; i++) {
      var t = base[i];
      if (t === sourceRatio) { continue; }
      if (wanted && wanted.length && !contains(wanted, t)) { continue; }
      out.push(t);
    }
    return out;
  }

  // Strip a trailing "<ratio>" or "<ratio> <platform>" label so re-resizing (or
  // switching GG/FB/PIN) swaps cleanly. A platform tag (GG/PIN) is only stripped
  // when it sits right after a ratio label — so a real name ending in "GG"/"PIN"
  // (with no ratio before it) is left alone.
  function stripTrailingRatioLabel(name) {
    name = rtrimSpaces(name);
    var noPlatform = stripOneTrailing(name, PLATFORM_TAGS);
    if (noPlatform !== name) {
      var trimmed = rtrimSpaces(noPlatform);
      var noRatio = stripOneTrailing(trimmed, STRIP_SUFFIXES);
      if (noRatio !== trimmed) { return noRatio; } // matched "<ratio> <platform>"
      // platform tag without a preceding ratio label -> leave the name as-is
    }
    return stripOneTrailing(name, STRIP_SUFFIXES);
  }

  // targetLabel is an internal ratio key ("9-16"); the suffix uses LABELS.
  // platform (optional) appends a trailing tag, e.g. "GG" -> "... 4x5 GG".
  function buildName(originalName, targetLabel, platform) {
    var suffix = LABELS[targetLabel] || targetLabel;
    var out = stripTrailingRatioLabel(originalName) + " " + suffix;
    if (platform) { out += " " + platform; }
    return out;
  }

  // R3: chạy lại / chọn cả bin → tạo sequence trùng tên. Đánh dấu dòng kế hoạch có
  // tên đã có trong project (exists) hoặc trùng dòng trước trong cùng lượt (dupInPlan).
  // So không phân biệt hoa/thường + bỏ khoảng trắng thừa. Không đổi mảng gốc.
  function markPlanDuplicates(plan, existingNames) {
    function key(n) { return String(n || "").replace(/\s+/g, " ").trim().toLowerCase(); }
    var have = {};
    (existingNames || []).forEach(function (n) { have[key(n)] = true; });
    var seen = {};
    return (plan || []).map(function (p) {
      var o = {}; for (var k in p) { if (Object.prototype.hasOwnProperty.call(p, k)) o[k] = p[k]; }
      if (o.name) {
        var kk = key(o.name);
        if (have[kk]) o.exists = true;
        else if (seen[kk]) o.dupInPlan = true;
        seen[kk] = true;
      }
      return o;
    });
  }

  // A clip is treated as a logo when its name contains any of these hints
  // (case-insensitive substring). The team names logo files like "logo",
  // "fav vid", "fav video" — "fav" covers all of those. Add more hints here to
  // teach the panel new naming conventions; keep them lowercase.
  var LOGO_NAME_HINTS = ["logo", "fav"];

  function isLogoName(name) {
    if (!name) { return false; }
    var n = String(name).toLowerCase();
    for (var i = 0; i < LOGO_NAME_HINTS.length; i++) {
      if (n.indexOf(LOGO_NAME_HINTS[i]) !== -1) { return true; }
    }
    return false;
  }

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  // ── Bổ sung cho bản UXP (không có trong bản gốc) ─────────────────────────
  // ExtendScript trả Motion > Position dạng chuẩn hoá (0.5 = giữa khung); tài liệu
  // UXP không nói rõ đơn vị. Toạ độ chuẩn hoá của clip nằm trong khung luôn quanh
  // [0,1], còn pixel thì hàng trăm — nên |giá trị| > 2 coi là pixel và quy guide ra
  // pixel theo chiều cao khung đích.
  function positionY(guide, sample, frameH) {
    guide = clamp01(guide);
    var pixels = Math.abs(sample[0]) > 2 || Math.abs(sample[1]) > 2;
    return pixels ? guide * frameH : guide;
  }

  // Khung w×h có đúng ratio `key` không (cùng sai số EPS với detectRatio). Dùng cho
  // ratio không nằm trong ORDER, vd PIN bỏ qua nguồn đã là 2:3.
  function matchesRatio(w, h, key) {
    var r = RATIOS[key];
    if (!r || !(w > 0) || !(h > 0)) { return false; }
    return Math.abs(aspectOf(r.w, r.h) - aspectOf(w, h)) <= EPS;
  }

  // Clip cần canh theo guide = clip có CHỮ:
  //   • text tạo bằng Type tool: có component matchName "AE.ADBE Text";
  //   • MOGRT ("AE.ADBE Capsule") có param tên kiểu chữ (Text / Title / Caption…).
  // Không dựa vào loại giá trị: chẩn đoán trên Premiere 25.x cho thấy param chữ của
  // MOGRT trả getStartValue() = null (không phải MogrtText). Light leak / MOGRT
  // trang trí cũng là Capsule nhưng chỉ có Position/Scale/Color… nên giữ nguyên.
  // comps: [{ matchName, displayName, params: [tên param] }] (params chỉ cần cho Capsule).
  var TEXT_COMPONENT_RE = /adbe text\b/i;
  var MOGRT_COMPONENT_RE = /capsule/i;
  var TEXT_PARAM_RE = /\btext\b|title|caption|headline|subtitle|chữ|tiêu đề/i;
  function isTextClip(comps) {
    for (var i = 0; i < (comps ? comps.length : 0); i++) {
      var c = comps[i] || {};
      if (TEXT_COMPONENT_RE.test(String(c.matchName || ''))) { return true; }
      if (MOGRT_COMPONENT_RE.test(String(c.matchName || ''))) {
        var ps = c.params || [];
        for (var k = 0; k < ps.length; k++) {
          if (ps[k] && TEXT_PARAM_RE.test(String(ps[k]))) { return true; }
        }
      }
    }
    return false;
  }

  return {
    RATIOS: RATIOS,
    ORDER: ORDER,
    LABELS: LABELS,
    detectRatio: detectRatio,
    otherRatios: otherRatios,
    describeRatio: describeRatio,
    stripTrailingRatioLabel: stripTrailingRatioLabel,
    buildName: buildName,
    markPlanDuplicates: markPlanDuplicates,
    clamp01: clamp01,
    PLATFORM_TAGS: PLATFORM_TAGS,
    PLATFORM_TARGETS: PLATFORM_TARGETS,
    targetsFor: targetsFor,
    LOGO_NAME_HINTS: LOGO_NAME_HINTS,
    isLogoName: isLogoName,
    positionY: positionY,
    matchesRatio: matchesRatio,
    isTextClip: isTextClip
  };
})();


(function (root) {
  if (root) { root.RSZ = RSZ; }
  if (typeof module !== "undefined" && module.exports) { module.exports = RSZ; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
