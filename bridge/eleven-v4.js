// bridge/eleven-v4.js — gen giọng bằng Eleven v4.
//
// Tài liệu (2026-09-28) chỉ xác nhận eleven_v4 chạy qua Text to Dialogue
// (/v1/text-to-dialogue, tối đa 2.000 ký tự/lần); /v1/text-to-speech không nhắc tới v4.
// Nên: thử TTS trước (đơn giản, 1 lần gọi), ElevenLabs trả 4xx kiểu "model không hợp lệ"
// thì chuyển sang Dialogue và nhớ lựa chọn cho các lần sau trong phiên bridge.
// v4 chỉ có 2 thông số: stability + similarity (không style/speed/speaker boost, không SSML).

const DIALOGUE_MAX = 2000;

let mode = null;   // null = chưa biết · 'tts' · 'dialogue'

// Chia script thành các đoạn ≤ max ký tự, ưu tiên cắt ở ranh giới câu → dòng → dấu phẩy
// → khoảng trắng. Không bao giờ cắt giữa chữ trừ khi một "từ" dài hơn max.
function splitText(text, max) {
  max = max || DIALOGUE_MAX;
  text = String(text || '').trim();
  if (text.length <= max) return text ? [text] : [];
  const out = [];
  let rest = text;
  while (rest.length > max) {
    const win = rest.slice(0, max + 1);
    let cut = -1;
    for (const re of [/[.!?…]["')\]]?\s/g, /\n/g, /[,;:]\s/g, /\s/g]) {
      let m, last = -1;
      re.lastIndex = 0;
      while ((m = re.exec(win)) !== null) { if (m.index + m[0].length <= max) last = m.index + m[0].length; }
      if (last > max * 0.3) { cut = last; break; }
    }
    if (cut < 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

function settingsOf(s) {
  const num = (v, d) => { const n = Number(v); return (v == null || isNaN(n)) ? d : Math.min(1, Math.max(0, n)); };
  return { stability: num(s && s.stability, 0.5), similarity: num(s && s.similarity, 0.75) };
}

// Lỗi kiểu "model không dùng được ở endpoint này" → đáng thử Dialogue.
// Lỗi key / hết credit / voice không tồn tại thì KHÔNG đổi endpoint (Dialogue cũng sẽ lỗi y vậy).
function isModelRejected(err) {
  const m = String(err && err.message || '');
  if (!/ElevenLabs HTTP (400|404|422)/.test(m)) return false;
  if (/voice_not_found|quota|credits|unauthorized|invalid_api_key/i.test(m)) return false;
  return /model/i.test(m);
}

// request(method, urlPath, body, expectBinary) → Promise<{buffer}> — elevenLabsRequest đã gắn key.
async function generateV4(request, opts) {
  const { voiceId, modelId, text, settings, languageCode, outputFormat, seed } = opts;
  const st = settingsOf(settings);
  const q = outputFormat ? ('?output_format=' + encodeURIComponent(outputFormat)) : '';

  async function viaTts() {
    const body = { text, model_id: modelId,
      voice_settings: { stability: st.stability, similarity_boost: st.similarity } };
    if (languageCode) body.language_code = languageCode;
    if (seed != null) body.seed = seed;
    return (await request('POST', '/v1/text-to-speech/' + voiceId + q, body, true)).buffer;
  }

  async function viaDialogue() {
    const parts = splitText(text, DIALOGUE_MAX);
    const bufs = [];
    for (let i = 0; i < parts.length; i++) {
      const body = { inputs: [{ text: parts[i], voice_id: voiceId }], model_id: modelId, settings: st };
      if (languageCode) body.language_code = languageCode;
      if (seed != null) body.seed = seed;
      // Nối mạch giọng giữa các đoạn (tối đa 100 ký tự mỗi bên).
      if (i > 0) body.previous_text = parts[i - 1].slice(-100);
      if (i < parts.length - 1) body.future_text = parts[i + 1].slice(0, 100);
      bufs.push((await request('POST', '/v1/text-to-dialogue' + q, body, true)).buffer);
    }
    // Cùng output_format → nối thẳng các frame MP3 là phát liền mạch.
    return { buffer: Buffer.concat(bufs), chunks: parts.length };
  }

  if (mode !== 'dialogue') {
    try {
      const buf = await viaTts();
      mode = 'tts';
      return { buffer: buf, via: 'tts', chunks: 1 };
    } catch (e) {
      if (mode === 'tts' || !isModelRejected(e)) throw e;
      console.log('[tts/v4] text-to-speech không nhận ' + modelId + ' → chuyển Text to Dialogue:', e.message.slice(0, 160));
      mode = 'dialogue';
    }
  }
  const d = await viaDialogue();
  return { buffer: d.buffer, via: 'dialogue', chunks: d.chunks };
}

function isV4(modelId) { return /^eleven_v4/.test(String(modelId || '')); }
function _resetMode() { mode = null; }

module.exports = { generateV4, splitText, isModelRejected, isV4, DIALOGUE_MAX, _resetMode };
