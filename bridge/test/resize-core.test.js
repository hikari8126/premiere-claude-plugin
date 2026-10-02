// bridge/test/resize-core.test.js — test logic thuần của tab Resize (port từ 1-Click Resizer).
const test = require("node:test");
const assert = require("node:assert");
const RSZ = require("../../plugin/resize-core.js");

test("detectRatio matches the three standard 1080 sizes", () => {
  assert.strictEqual(RSZ.detectRatio(1080, 1920), "9-16");
  assert.strictEqual(RSZ.detectRatio(1080, 1350), "4-5");
  assert.strictEqual(RSZ.detectRatio(1080, 1080), "1-1");
});

test("detectRatio matches by aspect ratio at other resolutions", () => {
  assert.strictEqual(RSZ.detectRatio(2160, 3840), "9-16");
  assert.strictEqual(RSZ.detectRatio(1920, 1080), null); // 16:9 is not in our set
});

test("detectRatio returns null on bad input", () => {
  assert.strictEqual(RSZ.detectRatio(0, 100), null);
  assert.strictEqual(RSZ.detectRatio(100, 0), null);
});

test("detectRatio tolerance boundary (EPS = 0.02 on aspect)", () => {
  // 1080/1900 = 0.5684 vs 0.5625 -> diff ~0.006, inside tolerance
  assert.strictEqual(RSZ.detectRatio(1080, 1900), "9-16");
  // 1080/2100 = 0.5143 -> ~0.048 from 9:16, outside tolerance
  assert.strictEqual(RSZ.detectRatio(1080, 2100), null);
});

test("otherRatios returns the two remaining labels in order", () => {
  assert.deepStrictEqual(RSZ.otherRatios("9-16"), ["4-5", "1-1"]);
  assert.deepStrictEqual(RSZ.otherRatios("4-5"), ["9-16", "1-1"]);
  assert.deepStrictEqual(RSZ.otherRatios("1-1"), ["9-16", "4-5"]);
});

test("stripTrailingRatioLabel removes only a trailing known label", () => {
  assert.strictEqual(RSZ.stripTrailingRatioLabel("Clip 9-16"), "Clip");
  assert.strictEqual(RSZ.stripTrailingRatioLabel("Clip 4-5"), "Clip");
  assert.strictEqual(RSZ.stripTrailingRatioLabel("Clip"), "Clip");
  // must not strip a label that is not at the end
  assert.strictEqual(RSZ.stripTrailingRatioLabel("9-16 master"), "9-16 master");
  // must not strip a bracketed tag that merely contains digits
  assert.strictEqual(RSZ.stripTrailingRatioLabel("vid17.0 [tung]"), "vid17.0 [tung]");
  // strips the new x-style labels too
  assert.strictEqual(RSZ.stripTrailingRatioLabel("Clip 9x16"), "Clip");
  assert.strictEqual(RSZ.stripTrailingRatioLabel("Clip 1x1"), "Clip");
  // tolerates accidental trailing spaces from manual renames
  assert.strictEqual(RSZ.stripTrailingRatioLabel("Clip 9-16 "), "Clip");
  assert.strictEqual(RSZ.buildName("Clip 9x16 ", "4-5"), "Clip 4x5");
});

test("RATIOS/LABELS carry 2:3 (Pinterest); ORDER stays the GG set; detectRatio ignores 2:3", () => {
  assert.deepStrictEqual(RSZ.RATIOS["2-3"], { w: 1080, h: 1620 });
  assert.strictEqual(RSZ.LABELS["2-3"], "2x3");
  assert.deepStrictEqual(RSZ.ORDER, ["9-16", "4-5", "1-1"]);
  // 2:3 is PIN-only — detectRatio must never pick it as a source ratio
  assert.strictEqual(RSZ.detectRatio(1080, 1620), null);
});

test("buildName appends a platform tag after the ratio label", () => {
  var base = "SoftyGrace v1.1 [c.ngoc.nguyen][tung.thanhnguyen]";
  assert.strictEqual(RSZ.buildName(base, "4-5", "GG"), base + " 4x5 GG");
  assert.strictEqual(RSZ.buildName(base, "2-3", "PIN"), base + " 2x3 PIN");
  // no platform arg -> legacy label-only form still works
  assert.strictEqual(RSZ.buildName(base, "1-1"), base + " 1x1");
});

test("re-resizing swaps ratio + platform cleanly (no stacking)", () => {
  var base = "Brand vid17.0 [ed.a]";
  assert.strictEqual(RSZ.buildName(base + " 4x5 GG", "1-1", "GG"), base + " 1x1 GG");
  assert.strictEqual(RSZ.buildName(base + " 4x5 GG", "2-3", "PIN"), base + " 2x3 PIN");
  assert.strictEqual(RSZ.buildName(base + " 2x3 PIN", "9-16", "GG"), base + " 9x16 GG");
  // legacy plain-ratio name still swaps into the new tagged form
  assert.strictEqual(RSZ.buildName(base + " 9x16", "4-5", "GG"), base + " 4x5 GG");
});

test("stripTrailingRatioLabel handles ratio+platform, leaves real names alone", () => {
  assert.strictEqual(RSZ.stripTrailingRatioLabel("Clip 4x5 GG"), "Clip");
  assert.strictEqual(RSZ.stripTrailingRatioLabel("Clip 2x3 PIN"), "Clip");
  assert.strictEqual(RSZ.stripTrailingRatioLabel("Clip 9-16 GG"), "Clip"); // legacy dash + tag
  assert.strictEqual(RSZ.stripTrailingRatioLabel("Clip 4x5 GG "), "Clip"); // trailing space
  // a real name ending in GG/PIN with NO ratio before it must be preserved
  assert.strictEqual(RSZ.stripTrailingRatioLabel("Weekly GG"), "Weekly GG");
  assert.strictEqual(RSZ.stripTrailingRatioLabel("Team PIN"), "Team PIN");
});

test("buildName appends the x-style label and swaps any prior label", () => {
  var base = "Brand vid17.0 [editor.a][editor.b]";
  assert.strictEqual(RSZ.buildName(base, "4-5"), base + " 4x5");
  assert.strictEqual(RSZ.buildName(base, "9-16"), base + " 9x16");
  assert.strictEqual(RSZ.buildName(base, "1-1"), base + " 1x1");
  // swaps a prior x-style label (no stacking)
  assert.strictEqual(RSZ.buildName(base + " 9x16", "1-1"), base + " 1x1");
  // also swaps a legacy dash label from older versions
  assert.strictEqual(RSZ.buildName(base + " 4-5", "9-16"), base + " 9x16");
});

test("isLogoName detects the team's logo naming conventions", () => {
  // core hints: "logo" and "fav" (covers fav vid / fav video / favicon)
  assert.strictEqual(RSZ.isLogoName("Logo"), true);
  assert.strictEqual(RSZ.isLogoName("brand_logo.png"), true);
  assert.strictEqual(RSZ.isLogoName("fav vid"), true);
  assert.strictEqual(RSZ.isLogoName("Fav Video 01"), true);
  assert.strictEqual(RSZ.isLogoName("FAVICON"), true);
  // case-insensitive
  assert.strictEqual(RSZ.isLogoName("LOGO_final"), true);
  // non-logo overlays stay unmatched
  assert.strictEqual(RSZ.isLogoName("Text All-In-One"), false);
  assert.strictEqual(RSZ.isLogoName("background.mp4"), false);
  // guards
  assert.strictEqual(RSZ.isLogoName(""), false);
  assert.strictEqual(RSZ.isLogoName(null), false);
  assert.strictEqual(RSZ.isLogoName(undefined), false);
});

test("clamp01 keeps values in [0,1]", () => {
  assert.strictEqual(RSZ.clamp01(-0.2), 0);
  assert.strictEqual(RSZ.clamp01(1.4), 1);
  assert.strictEqual(RSZ.clamp01(0.42), 0.42);
});

test("targetsFor picks a platform's ratios, minus the source, minus unticked", () => {
  // GG offers all three; the source's own ratio is never re-made
  assert.deepStrictEqual(RSZ.targetsFor("GG", "9-16"), ["4-5", "1-1"]);
  assert.deepStrictEqual(RSZ.targetsFor("GG", "1-1"), ["9-16", "4-5"]);
  // unticking 1:1 leaves just 4:5
  assert.deepStrictEqual(RSZ.targetsFor("GG", "9-16", ["4-5"]), ["4-5"]);
  // FB only swaps between 9:16 and 4:5 …
  assert.deepStrictEqual(RSZ.targetsFor("FB", "9-16"), ["4-5"]);
  assert.deepStrictEqual(RSZ.targetsFor("FB", "4-5"), ["9-16"]);
  // … and from a 1:1 source it offers both
  assert.deepStrictEqual(RSZ.targetsFor("FB", "1-1"), ["9-16", "4-5"]);
  // PIN is a single fixed output, whatever the source
  assert.deepStrictEqual(RSZ.targetsFor("PIN", "9-16"), ["2-3"]);
  assert.deepStrictEqual(RSZ.targetsFor("PIN", null), ["2-3"]);
  // everything unticked -> nothing to do
  assert.deepStrictEqual(RSZ.targetsFor("GG", "9-16", ["9-16"]), []);
  // an unknown platform never invents work
  assert.deepStrictEqual(RSZ.targetsFor("XX", "9-16"), []);
});

test("FB joins the platform tags and swaps cleanly with the others", () => {
  var base = "Brand vid [ed.a]";
  assert.strictEqual(RSZ.buildName(base, "4-5", "FB"), base + " 4x5 FB");
  assert.strictEqual(RSZ.buildName(base + " 4x5 FB", "9-16", "GG"), base + " 9x16 GG");
  assert.strictEqual(RSZ.buildName(base + " 2x3 PIN", "9-16", "FB"), base + " 9x16 FB");
  assert.strictEqual(RSZ.stripTrailingRatioLabel("Clip 9x16 FB"), "Clip");
  // a real name merely ending in FB keeps it (no ratio label in front)
  assert.strictEqual(RSZ.stripTrailingRatioLabel("Highlights FB"), "Highlights FB");
});

test("describeRatio labels ANY frame size without widening what can be resized", () => {
  // the named sizes keep their familiar label
  assert.strictEqual(RSZ.describeRatio(1080, 1920), "9 : 16");
  assert.strictEqual(RSZ.describeRatio(1080, 1350), "4 : 5");
  assert.strictEqual(RSZ.describeRatio(1080, 1080), "1 : 1");
  // 2:3 is READ correctly but is still not a resize source — that separation is
  // the whole point of keeping describeRatio apart from detectRatio.
  assert.strictEqual(RSZ.describeRatio(1080, 1620), "2 : 3");
  assert.strictEqual(RSZ.detectRatio(1080, 1620), null);
  assert.strictEqual(RSZ.describeRatio(1000, 1500), "2 : 3");
  // sizes the panel never touches are still reported
  assert.strictEqual(RSZ.describeRatio(1920, 1080), "16 : 9");
  assert.strictEqual(RSZ.describeRatio(2560, 1080), "64 : 27");
  // an awkward size is approximated rather than shown as a giant fraction
  assert.strictEqual(RSZ.describeRatio(1234, 987), "≈ 5 : 4");
  // guards
  assert.strictEqual(RSZ.describeRatio(0, 100), null);
  assert.strictEqual(RSZ.describeRatio(100, 0), null);
});

// ── Bổ sung cho bản UXP ────────────────────────────────────────────────────
test("positionY giữ dạng chuẩn hoá khi Position đang là 0..1", () => {
  assert.strictEqual(RSZ.positionY(0.3, [0.5, 0.5], 1350), 0.3);
  assert.strictEqual(RSZ.positionY(0.8, [-0.2, 1.4], 1080), 0.8);
});

test("positionY quy ra pixel theo chiều cao khung đích khi Position là pixel", () => {
  assert.strictEqual(RSZ.positionY(0.5, [540, 960], 1350), 675);
  assert.strictEqual(RSZ.positionY(0.25, [540, 1.0], 1080), 270);
});

test("positionY kẹp guide về 0..1", () => {
  assert.strictEqual(RSZ.positionY(1.7, [0.5, 0.5], 1920), 1);
  assert.strictEqual(RSZ.positionY(-1, [540, 960], 1920), 0);
});

// Dữ liệu lấy từ chẩn đoán thật (sequence ZipLacy vid35.2, 2026-10-01).
var OPACITY = { matchName: "AE.ADBE Opacity", displayName: "Opacity" };
var MOTION = { matchName: "AE.ADBE Motion", displayName: "Motion" };

test("isTextClip: text tạo bằng Type tool", () => {
  assert.strictEqual(RSZ.isTextClip([OPACITY, MOTION,
    { matchName: "AE.ADBE Graphic Group", displayName: "Vector Motion" },
    { matchName: "AE.ADBE Text", displayName: "Text" }]), true);
});

test("isTextClip: MOGRT có param chữ (CTA) → canh", () => {
  assert.strictEqual(RSZ.isTextClip([OPACITY, MOTION, { matchName: "AE.ADBE Capsule", displayName: "Graphic Parameters",
    params: ["Text Color", "Text Position", "Text", "Gradient Ramp Start of Ramp", "Bo góc"] }]), true);
  assert.strictEqual(RSZ.isTextClip([{ matchName: "AE.ADBE Capsule", params: ["Main Title", "Color"] }]), true);
  assert.strictEqual(RSZ.isTextClip([{ matchName: "AE.ADBE Capsule", params: ["Nội dung chữ"] }]), true);
});

test("isTextClip: MOGRT không chữ (Generated Light Leak) → giữ nguyên", () => {
  assert.strictEqual(RSZ.isTextClip([OPACITY, MOTION, { matchName: "AE.ADBE Capsule", displayName: "Graphic Parameters",
    params: ["Transform", "Position", "Scale", "", "", "Color", "Color 1", "Color 2", "Color 3",
             "Color 4", "Color 5", "Color 6", "Mister Horse Metadata", "mhpc-meta"] }]), false);
});

test("isTextClip: footage / shape không chữ / input rỗng → không canh", () => {
  assert.strictEqual(RSZ.isTextClip([OPACITY, MOTION, { matchName: "AE.Impact_Grow_FX", displayName: "FI: Grow FX" },
    { matchName: "AE.ADBE Lumetri", displayName: "Lumetri Color" }]), false);
  assert.strictEqual(RSZ.isTextClip([OPACITY, MOTION, { matchName: "AE.ADBE Graphic Group", displayName: "Vector Motion" }]), false);
  assert.strictEqual(RSZ.isTextClip([{ matchName: "AE.ADBE Capsule" }]), false);
  assert.strictEqual(RSZ.isTextClip([]), false);
  assert.strictEqual(RSZ.isTextClip(null), false);
});

test("matchesRatio nhận đúng 2:3 (PIN bỏ qua nguồn đã là 2:3)", () => {
  assert.strictEqual(RSZ.matchesRatio(1080, 1620, "2-3"), true);
  assert.strictEqual(RSZ.matchesRatio(2160, 3240, "2-3"), true);
  assert.strictEqual(RSZ.matchesRatio(1080, 1920, "2-3"), false);
  assert.strictEqual(RSZ.matchesRatio(1080, 1350, "2-3"), false);
  assert.strictEqual(RSZ.matchesRatio(0, 1620, "2-3"), false);
  assert.strictEqual(RSZ.matchesRatio(1080, 1620, "x-y"), false);
});

test("markPlanDuplicates flags names already in project and repeats within the run (R3)", () => {
  const plan = [
    { src: "A", ratio: "4-5", name: "Ad v1 4x5 GG" },
    { src: "A", ratio: "1-1", name: "Ad v1 1x1 GG" },
    { src: "B", ratio: "4-5", name: "ad v1  4x5 gg" },   // trùng dòng 1 (khác hoa/thường, khoảng trắng)
    { src: "C", skip: "ratio lạ" },
  ];
  const out = RSZ.markPlanDuplicates(plan, ["Ad v1 1x1 GG", "Khác"]);
  assert.strictEqual(out[0].exists, undefined);
  assert.strictEqual(out[0].dupInPlan, undefined);
  assert.strictEqual(out[1].exists, true);
  assert.strictEqual(out[2].dupInPlan, true);
  assert.strictEqual(out[3].exists, undefined);
  assert.strictEqual(plan[1].exists, undefined, "không đổi mảng gốc");
});
