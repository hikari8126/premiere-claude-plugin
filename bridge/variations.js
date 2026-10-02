// bridge/variations.js — gen N variation, lỗi giữa chừng KHÔNG bỏ phần đã gen (VG2).
// Variation 1 đã gen xong (đã trừ credit ElevenLabs) mà variation 2 lỗi thì trả
// variation 1 kèm `errors`, thay vì ném lỗi làm plugin mất cả file đã trả tiền.
// Lỗi ngay variation đầu → ném như cũ (không có gì để trả).
async function collectVariations(n, genOne) {
  const results = [];
  const errors = [];
  for (let v = 1; v <= n; v++) {
    try {
      results.push(await genOne(v));
    } catch (e) {
      if (!results.length) throw e;
      errors.push({ variation: v, error: (e && e.message) || String(e) });
      break;   // lỗi thường do quota/key → thử tiếp chỉ tốn thêm request
    }
  }
  return { results, errors };
}

module.exports = { collectVariations };
