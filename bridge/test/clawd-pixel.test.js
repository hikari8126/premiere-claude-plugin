// bridge/test/clawd-pixel.test.js — sprite Clawd cho tab Claude.
const test = require("node:test");
const assert = require("node:assert");
const CLAWD = require("../../plugin/clawd-pixel.js");

const rowsWith = (f, ch) => f.map((r, y) => (r.includes(ch) ? y : -1)).filter(y => y >= 0);

test("đủ 5 cảnh; mọi khung 24×18, chỉ dùng ký tự đã khai báo", () => {
  assert.deepStrictEqual(CLAWD.SCENES, ["idle", "think", "work", "done", "fail"]);
  for (const name of CLAWD.SCENES) {
    const frames = CLAWD.frames(name);
    assert.ok(frames.length >= 4, name + " có chuyển động");
    for (const f of frames) {
      assert.strictEqual(f.length, CLAWD.H, name + " cao 18");
      for (const row of f) {
        assert.strictEqual(row.length, CLAWD.W, name + " rộng 24: " + row);
        assert.match(row, /^[.OKWYB]+$/);
      }
    }
  }
});

test("dáng gốc Clawd: thân 12 rộng, hai mắt khe dọc, tay hai bên, 4 chân", () => {
  const f = CLAWD.frames("idle")[0];
  assert.strictEqual(f[8], "......OOOOOOOOOOOO......", "đỉnh thân");
  assert.strictEqual(f[10], "......OOKOOOOOOKOO......", "mắt trái cột 8, phải cột 15");
  assert.strictEqual(f[11], f[10], "mắt cao 2px (khe dọc)");
  assert.strictEqual(f[12], "....OOOOOOOOOOOOOOOO....", "tay chìa hai bên");
  assert.strictEqual(f[16], ".......O.O....O.O.......", "4 chân");
});

test("idle: có nhịp nhún thở và một khung chớp mắt", () => {
  const fr = CLAWD.frames("idle");
  assert.ok(fr.some(f => f[8] === "........................"), "có khung thân hạ 1px");
  assert.ok(fr.some(f => /OKKKO/.test(f.join(""))), "có khung mắt nhắm");
});

test("think: bong bóng nghĩ (W) to dần và có chấm '…' bên trong", () => {
  const fr = CLAWD.frames("think");
  const wCount = fr.map(f => f.join("").split("W").length - 1);
  assert.strictEqual(wCount[0], 0);
  assert.ok(wCount[1] < wCount[2] && wCount[2] < wCount[3], "bong bóng lớn dần");
  assert.ok(rowsWith(fr[5], "K").includes(1), "chấm tối trong đám mây");
});

test("done: có khung bật nhảy (thân cao hơn bình thường) và lấp lánh", () => {
  const fr = CLAWD.frames("done");
  assert.ok(fr.some(f => rowsWith(f, "O")[0] < 8), "nhảy lên trên hàng 8");
  assert.ok(fr.some(f => f.join("").includes("Y")), "lấp lánh");
});

test("fail: giọt mồ hôi rơi xuống qua các khung; tay buông quá đáy thân", () => {
  const fr = CLAWD.frames("fail");
  const dropTop = fr.map(f => rowsWith(f, "B")[0]);
  for (let i = 1; i < dropTop.length; i++) assert.ok(dropTop[i] > dropTop[i - 1], "giọt rơi xuống");
  assert.match(fr[0][17], /^....O.*O....$/, "tay chạm hàng đáy");
});

test("toSvg gộp pixel, viewBox theo khung cắt, đủ màu", () => {
  const svg = CLAWD.toSvg(CLAWD.frames("done")[2], 22, CLAWD.TAB_CROP);
  assert.match(svg, /^<svg viewBox="3 4 18 14" width="22" height="17"/);
  assert.match(svg, /#D97757/);
  assert.match(svg, /#F2C14E/);
  const full = CLAWD.toSvg(CLAWD.frames("idle")[0], 48);
  assert.match(full, /viewBox="0 0 24 18" width="48" height="36"/);
  assert.ok((full.match(/<rect /g) || []).length < 40, "đã gộp rect liền nhau");
});

test("tên cảnh lạ → idle", () => {
  assert.deepStrictEqual(CLAWD.frames("??"), CLAWD.frames("idle"));
});
