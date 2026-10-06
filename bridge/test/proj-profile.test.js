// bridge/test/proj-profile.test.js — hồ sơ quy ước project (Facebook / Google / v1 …).
const test = require("node:test");
const assert = require("node:assert");
const PPF = require("../../plugin/proj-profile.js");
const FLE = require("../../plugin/flow-engine.js");

const seq = (path, name) => ({ path, name, isFolder: false, mediaType: "sequence" });
const bin = (path, name) => ({ path, name, isFolder: true, mediaType: "" });

const other = [
  bin("", "Facebook"), bin("Facebook", "v1"), bin("Facebook / v1", "35x"),
  seq("Facebook / v1 / 35x", "SP vid35.0 [a] [b]"), seq("Facebook / v1 / 35x", "SP vid35.1 [a] [b]"),
  bin("", "Google"), bin("Google", "35x"), bin("Google / 35x", "35.0"),
  seq("Google / 35x / 35.0", "35.0"), seq("Google / 35x / 35.0", "SP Google dọc vid35.0 [a] [b]"),
  seq("Facebook / v1 / 36x", "SP vid36.0 [a] [b]"),
];

test("scan học chữ nền tảng + mẫu bin", () => {
  const p = PPF.scan(other);
  assert.strictEqual(p.alias.FB, "Facebook");
  assert.strictEqual(p.alias.GG, "Google");
  assert.strictEqual(p.bins.FB, "Facebook / v1 / {bộ}x");
  assert.strictEqual(p.bins.GG, "Google / {bộ}x / {bộ}.{số}");
  assert.strictEqual(PPF.summary(p), "FB = Facebook · GG = Google");
});

test("project mặc định không đổi gì, project trống có cảnh báo", () => {
  const mine = [seq("Sequence / FB / 35x", "SP vid35.0"), seq("Sequence / GG / 35x / 35.0", "35.0")];
  const p = PPF.scan(mine);
  assert.strictEqual(p.alias.GG, "GG");
  assert.strictEqual(PPF.summary(p), "");
  assert.ok(PPF.scan([]).warns.length >= 1);
});

test("engine dùng hồ sơ: bin GG + khung Google học được", () => {
  PPF.use(PPF.scan(other));
  try {
    assert.strictEqual(FLE.platBin(other, "GG", "36", 0), "Google / 36x / 36.0");
    const t = FLE.platTemplates(other, "GG", "36", 0);
    // khung cứng 3 đích: có dọc, thiếu ngang + vuông → báo lỗi từng loại
    assert.deepStrictEqual(t.map(x => !!x.item), [true, false, false]);
    assert.strictEqual(t[0].label, "9:16 (dọc)");
    assert.match(t[1].err, /16:9/);
    // FB gốc không lẫn khung Google
    const fam = FLE.familyIn(other, { k: "base" }, 35).map(f => f.item.name);
    assert.deepStrictEqual(fam.sort(), ["SP vid35.0 [a] [b]", "SP vid35.1 [a] [b]"]);
    // chưa có bộ trước → mẫu học được
    assert.strictEqual(FLE.platBin([], "GG", "36", 1), "Google / 36x / 36.1");
  } finally { PPF.use(null); }
});

test("needsAI + mergeAI: bin lạ → hỏi Claude, kết quả phải khớp project thật", () => {
  const odd = [
    seq("Ads GGL / 35x", "SP GGL dọc vid35.0 [a] [b]"), seq("Ads GGL / 35x", "SP GGL ngang vid35.0 [a] [b]"),
    seq("Meta Team / 35x", "SP vid35.0 [a] [b]"), bin("", "Ads GGL"), bin("Ads GGL", "35x"),
  ];
  const p = PPF.scan(odd);
  assert.strictEqual(PPF.needsAI(p, odd), true);
  assert.strictEqual(PPF.needsAI(PPF.scan([]), []), false);
  const m = PPF.mergeAI(p, {
    alias: { GG: "GGL", FB: "Bịa" },
    bins: { GG: "Ads GGL / {bộ}x", FB: "Không / Có / {bộ}x" },
    note: "Bin Google tên Ads GGL, chia theo bộ",
  }, odd);
  assert.strictEqual(m.alias.GG, "GGL");
  assert.notStrictEqual(m.alias.FB, "Bịa");        // không có trong project → bỏ
  assert.strictEqual(m.bins.GG, "Ads GGL / {bộ}x");
  assert.strictEqual(m.bins.FB, p.bins.FB);         // mẫu không khớp bin thật → giữ của luật
  assert.strictEqual(m.ai, true);
  assert.ok(m.aiNote);
});

test("engine nhận bin chứa chữ nền tảng trong tên (Ads GGL)", () => {
  const items = [seq("Edit / Ads GGL / v2 / 35x", "SP GGL Vertical vid35.0 [a] [b]"), seq("Edit / Meta / v1 / 35x", "SP vid35.0 [a] [b]")];
  PPF.use({ alias: { FB: "Meta", GG: "GGL", PIN: "PIN", APP: "AppLovin" }, bins: {}, warns: [] });
  try {
    assert.strictEqual(FLE.platBin(items, "GG", "36", 0), "Edit / Ads GGL / v2 / 36x");
    assert.strictEqual(FLE.platTemplates(items, "GG", "36", 0)[0].kind, "9-16");
  } finally { PPF.use(null); }
});
