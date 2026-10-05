// bridge/test/vg-seq.test.js — Voice Gen chọn bin/thư mục lưu voice theo sequence đang mở.
const test = require("node:test");
const assert = require("node:assert");
const VGSEQ = require("../../plugin/vg-seq.js");

test("parseSeqSet reads vid{set}.{idx} like the Auto page names sequences", () => {
  assert.deepStrictEqual(VGSEQ.parseSeqSet("AeriSoft vid31.0 [c.trang] [viet]"), { set: "31", idx: "0", label: "31.0" });
  assert.deepStrictEqual(VGSEQ.parseSeqSet("AeriSoft VID031.2"), { set: "31", idx: "2", label: "31.2" });
  assert.deepStrictEqual(VGSEQ.parseSeqSet("x vid 7.1"), { set: "7", idx: "1", label: "7.1" });
  assert.strictEqual(VGSEQ.parseSeqSet("LunaHug Applovin v14.0"), null);
  assert.strictEqual(VGSEQ.parseSeqSet("AeriSoft vid31"), null);
  assert.strictEqual(VGSEQ.parseSeqSet("video31.0"), null);
  assert.strictEqual(VGSEQ.parseSeqSet(""), null);
});

test("pickDir finds an existing folder case-insensitively, else the default", () => {
  assert.strictEqual(VGSEQ.pickVoiceOverDir(["Footage", "voice over", "BGM"]), "voice over");
  assert.strictEqual(VGSEQ.pickVoiceOverDir(["VO"]), "VO");
  assert.strictEqual(VGSEQ.pickVoiceOverDir(["VoiceOver"]), "VoiceOver");
  assert.strictEqual(VGSEQ.pickVoiceOverDir(["Footage"]), "Voice Over");
  assert.strictEqual(VGSEQ.pickSetDir(["30x", "31X"], "31"), "31X");
  assert.strictEqual(VGSEQ.pickSetDir(["30x"], "31"), "31x");
});

test("buildTarget joins project folder, Voice Over folder and set folder", () => {
  var t = VGSEQ.buildTarget("/P/SP/Project/SP.prproj", { set: "31", idx: "0", label: "31.0" }, ["Voice Over"], ["31x"]);
  assert.deepStrictEqual(t, { dir: "/P/SP/Project/Voice Over/31x", bin: "Voice Over / 31x", namePart: "31.0", voDir: "Voice Over", setDir: "31x" });
  var u = VGSEQ.buildTarget("/P/SP/Project/SP.prproj", { set: "5", idx: "1", label: "5.1" }, [], []);
  assert.strictEqual(u.dir, "/P/SP/Project/Voice Over/5x");
  assert.strictEqual(u.bin, "Voice Over / 5x");
  assert.strictEqual(VGSEQ.buildTarget("", { set: "5", idx: "1", label: "5.1" }, [], []), null);
});

test("inferVoiceDir learns folder + bin from where voices of earlier sets live", () => {
  var E = "/P/AeriSoft/Videos/Editing File";
  var entries = [
    { bin: "Voice Over / 37x", dir: E + "/Voice/37x" },
    { bin: "Voice Over / 39x", dir: E + "/Voice/39x" },
    { bin: "Voice Over / OLD / 13x", dir: "/P/AeriSoft/Videos/Source/Voice Over/13x" },
    { bin: "Voice Over / test", dir: "/Users/x/Downloads" },
    { bin: "BGM", dir: "/P/AeriSoft/Videos/Source/BGMs/50x" },   // cha không phải thư mục voice
  ];
  assert.deepStrictEqual(VGSEQ.inferVoiceDir(entries, "40"), { dir: E + "/Voice/40x", bin: "Voice Over / 40x", basis: "Voice Over / 39x", from: E + "/Voice/39x" });
  // Bộ này đã có voice → dùng đúng thư mục + bin đó.
  assert.deepStrictEqual(VGSEQ.inferVoiceDir(entries, "37"), { dir: E + "/Voice/37x", bin: "Voice Over / 37x", basis: "Voice Over / 37x", from: E + "/Voice/37x" });
  // Bin OLD / thư mục không theo kiểu Nx → không học được.
  assert.strictEqual(VGSEQ.inferVoiceDir(entries.slice(2), "40"), null);
  assert.strictEqual(VGSEQ.inferVoiceDir([], "40"), null);
});

test("inferVoiceDir: Source/VO layout and a bin not named 'Voice Over'", () => {
  var S = "/P/SP/Video/Source/VO";
  var r = VGSEQ.inferVoiceDir([{ bin: "VO / 12x", dir: S + "/12x" }, { bin: "Audio / VO 11", dir: S + "/11x" }], "13");
  assert.deepStrictEqual(r, { dir: S + "/13x", bin: "VO / 13x", basis: "VO / 12x", from: S + "/12x" });
  // Bin không kết thúc bằng Nx → bin mặc định.
  var q = VGSEQ.inferVoiceDir([{ bin: "Audio / VO 11", dir: S + "/11x" }], "13");
  assert.deepStrictEqual(q, { dir: S + "/13x", bin: "Voice Over / 13x", basis: "Audio / VO 11", from: S + "/11x" });
});

test("pickVoiceOverDir also accepts a plain 'Voice' folder, preferring 'Voice Over'", () => {
  assert.strictEqual(VGSEQ.pickVoiceOverDir(["Clip", "Voice"]), "Voice");
  assert.strictEqual(VGSEQ.pickVoiceOverDir(["Voice", "Voice Over"]), "Voice Over");
});

// sameVoiceDir: thư mục lưu ≈ gợi ý (bỏ "/" cuối, NFC, hoa thường) hoặc cùng "{bộ}x" với bin gợi ý
{
  const V = require("../../plugin/vg-seq.js");
  const a = require("assert");
  a.strictEqual(V.sameVoiceDir("/a/Voice Over/36x/", "/a/Voice Over/36x", "Voice Over / 36x"), true);
  a.strictEqual(V.sameVoiceDir("/a/Café/36X", "/a/Café/36x", "Voice Over / 36x"), true);
  a.strictEqual(V.sameVoiceDir("/b/VO/36x", "/a/Voice Over/36x", "Voice Over / 36x"), true);
  a.strictEqual(V.sameVoiceDir("/b/VO/35x", "/a/Voice Over/36x", "Voice Over / 36x"), false);
  a.strictEqual(V.sameVoiceDir("/b/Other", "/a/Voice Over/36x", "Voice Over / 36x"), false);
  console.log("vg-seq sameVoiceDir: OK");
}
