// bridge/test/vg-bin-learn.test.js — Voice Gen tự chọn bin import theo project.
const test = require("node:test");
const assert = require("node:assert");
const B = require("../../plugin/vg-bin-learn.js");

const F = (path, name) => ({ path, name, isFolder: true, mediaType: "folder" });
const A = (path, name) => ({ path, name, isFolder: false, mediaType: "audio" });
const V = (path, name) => ({ path, name, isFolder: false, mediaType: "video" });

test("giọng: học gốc 'Voice Over / {N}x' → bộ đang mở", () => {
  const items = [
    A("Voice Over / 38x", "38.0 - Audrey.mp3"),
    A("Voice Over / 39x", "39.0 - Audrey.mp3"),
    A("Voice Over / 39x", "39.1 - Audrey.mp3"),
  ];
  assert.strictEqual(B.learn(items, "40").tts, "Voice Over / 40x");
  assert.strictEqual(B.learn(items, "40").learned.tts, true);
});

test("giọng: gốc lồng nhiều cấp (Audio / VO / 39x)", () => {
  const items = [A("Audio / VO / 39x", "a.mp3"), A("Audio / VO / 39x", "b.mp3"), A("Voice Over / 12x", "c.mp3")];
  assert.strictEqual(B.learn(items, "40").tts, "Audio / VO / 40x");
});

test("giọng: không có bộ nào → mặc định; không có số bộ → Voice Over", () => {
  assert.strictEqual(B.learn([A("Voice Over", "x.mp3")], "40").tts, "Voice Over / 40x");
  assert.strictEqual(B.learn([], "").tts, "Voice Over");
  assert.strictEqual(B.learn([], "").learned.tts, false);
});

test("giọng: học được nhưng sequence không theo quy ước → giữ biến {bộ}", () => {
  assert.strictEqual(B.learn([A("Voice Over / 39x", "a.mp3")], "").tts, "Voice Over / {bộ}x");
});

test("giọng: video trong bin Nx không tính", () => {
  assert.strictEqual(B.learn([V("Footage / 39x", "a.mov")], "40").learned.tts, false);
});

test("SFX / nhạc: bin chứa nhiều audio nhất trong nhánh khớp tên", () => {
  const items = [
    A("SFX", "whoosh.wav"), A("Audio / SFX / Hits", "hit1.wav"), A("Audio / SFX / Hits", "hit2.wav"),
    A("BGMs AI", "song1.mp3"), A("BGM", "song2.mp3"), A("BGMs AI", "song3.mp3"),
    A("Clips", "talk.wav"),
  ];
  const r = B.learn(items, "40");
  assert.strictEqual(r.sfx, "Audio / SFX / Hits");
  assert.strictEqual(r.music, "BGMs AI");
});

test("SFX / nhạc: chưa có audio → bin rỗng có tên khớp, không có thì mặc định", () => {
  const r = B.learn([F("", "Music"), F("Audio", "Sound FX")], "");
  assert.strictEqual(r.music, "Music");
  assert.strictEqual(r.sfx, "Audio / Sound FX");
  const d = B.learn([], "");
  assert.strictEqual(d.sfx, "SFX");
  assert.strictEqual(d.music, "BGM");
});

test("tên không nhầm: 'Absfx', 'Musical' không khớp", () => {
  assert.strictEqual(B.RE_SFX.test("Absfxy"), false);
  assert.strictEqual(B.RE_MUSIC.test("Musicals"), false);
  assert.strictEqual(B.RE_MUSIC.test("BGM"), true);
  assert.strictEqual(B.RE_MUSIC.test("Nhạc nền"), true);
});
