// bridge/test/clawd-pixel.test.js — khung pixel Clawd cho tab Claude.
const test = require("node:test");
const assert = require("node:assert");
const CLAWD = require("../../plugin/clawd-pixel.js");

test("đủ 5 cảnh; mọi khung 12×9, chỉ dùng ký tự đã khai báo", () => {
  assert.deepStrictEqual(CLAWD.SCENES, ["idle", "blink", "think", "done", "fail"]);
  for (const name of CLAWD.SCENES) {
    const frames = CLAWD.frames(name);
    assert.ok(frames.length >= 1, name);
    for (const f of frames) {
      assert.strictEqual(f.length, 9, name + " cao 9");
      for (const row of f) {
        assert.strictEqual(row.length, 12, name + " rộng 12: " + row);
        assert.match(row, /^[.OK]+$/);
      }
    }
  }
});

test("blink khác idle; think và done có ≥2 khung để chuyển động", () => {
  assert.notDeepStrictEqual(CLAWD.frames("idle")[0], CLAWD.frames("blink")[0]);
  assert.ok(CLAWD.frames("think").length >= 2);
  assert.ok(CLAWD.frames("done").length >= 2);
  assert.notDeepStrictEqual(CLAWD.frames("think")[0], CLAWD.frames("think")[1]);
});

test("toSvg gộp pixel theo hàng, viewBox đúng, màu cam + mắt tối", () => {
  const svg = CLAWD.toSvg(CLAWD.frames("idle")[0], 16);
  assert.match(svg, /^<svg [^>]*viewBox="0 0 12 9"/);
  assert.match(svg, /width="16" height="12"/);
  assert.match(svg, /#D97757/);
  assert.match(svg, /#1a1a1a/);
  assert.ok((svg.match(/<rect /g) || []).length < 12 * 9, "đã gộp rect liền nhau");
});

test("tên cảnh lạ → idle, không ném", () => {
  assert.deepStrictEqual(CLAWD.frames("??"), CLAWD.frames("idle"));
});
