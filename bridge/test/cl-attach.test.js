// bridge/test/cl-attach.test.js — tách đường dẫn ảnh khỏi ô lệnh + map sản phẩm → project.
const test = require("node:test");
const assert = require("node:assert");
const A = require("../../plugin/cl-attach.js");

test("extract: đường dẫn có dấu cách, file://, \\ escape, nhiều ảnh", () => {
  const r = A.extract("xếp RAW giúp /Users/a/Library/CleanShot 2026-10-05 at 22.49.08.png nhé");
  assert.deepStrictEqual(r.paths, ["/Users/a/Library/CleanShot 2026-10-05 at 22.49.08.png"]);
  assert.strictEqual(r.text, "xếp RAW giúp nhé");
  assert.deepStrictEqual(A.extract("file:///Users/a/b%20c.JPG").paths, ["/Users/a/b c.JPG"]);
  assert.deepStrictEqual(A.extract("/Users/a/b\\ c.png").paths, ["/Users/a/b c.png"]);
  assert.deepStrictEqual(A.extract("'/x/1.png' '/x/2.webp' /x/1.png").paths, ["/x/1.png", "/x/2.webp"]);
  assert.deepStrictEqual(A.extract("không có ảnh /x/a.mp4").paths, []);
});

test("matchProject: tên trùng > mở đầu > thư mục; mới mở gần nhất thắng khi bằng điểm", () => {
  const ps = [
    { path: "/d/Team 04/AeriSoft/Videos/Editing File/AeriSoft.prproj", name: "AeriSoft", last: 1 },
    { path: "/d/SAMX_WORKSPACE/AeriSoft/Asset/project/AeriSoft.prproj", name: "AeriSoft", last: 5 },
    { path: "/d/Team 04/SonaShape (BEVA AdoraBra)/Videos/Editing File/SonaShape.prproj", name: "SonaShape", last: 2 },
    { path: "/d/Team 01/EaseMotions 2/Video/Editing File/EaseMotion 25.prproj", name: "EaseMotion 25", last: 3 },
  ];
  assert.strictEqual(A.matchProject(ps, "AeriSoft").last, 5);
  assert.strictEqual(A.matchProject(ps, "sonashape").name, "SonaShape");
  assert.strictEqual(A.matchProject(ps, "EaseMotions").name, "EaseMotion 25");
  assert.strictEqual(A.matchProject(ps, "Khác"), null);
});
