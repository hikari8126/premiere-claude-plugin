// bridge/test/eleven-v4.test.js
const assert = require('assert');
const v4 = require('../eleven-v4.js');

(async () => {
// splitText: ngắn giữ nguyên; dài cắt ở ranh giới câu, mọi đoạn ≤ max, không mất chữ.
assert.deepStrictEqual(v4.splitText('Hello there.', 2000), ['Hello there.']);
const long = Array.from({ length: 80 }, (_, i) => 'Sentence number ' + i + ' is here.').join(' ');
const parts = v4.splitText(long, 200);
assert.ok(parts.length > 1);
parts.forEach(p => assert.ok(p.length <= 200, 'đoạn dài ' + p.length));
parts.forEach(p => assert.ok(/\.$/.test(p), 'phải cắt ở cuối câu: ' + p.slice(-20)));
assert.strictEqual(parts.join(' ').replace(/\s+/g, ' '), long);

// isModelRejected: lỗi model → true; lỗi key/credit/voice → false.
assert.strictEqual(v4.isModelRejected(new Error('ElevenLabs HTTP 400: {"detail":{"status":"invalid_model","message":"model eleven_v4 not supported"}}')), true);
assert.strictEqual(v4.isModelRejected(new Error('ElevenLabs HTTP 401: invalid_api_key model')), false);
assert.strictEqual(v4.isModelRejected(new Error('ElevenLabs HTTP 400: voice_not_found')), false);

// TTS nhận v4 → 1 lần gọi TTS, settings đúng tên similarity_boost.
v4._resetMode();
let calls = [];
let r = await v4.generateV4(async (m, url, body) => { calls.push({ url, body }); return { buffer: Buffer.from('A') }; },
  { voiceId: 'V', modelId: 'eleven_v4', text: 'Hi.', settings: { stability: 0.3, similarity: 0.9 } });
assert.strictEqual(r.via, 'tts');
assert.strictEqual(calls.length, 1);
assert.ok(calls[0].url.startsWith('/v1/text-to-speech/V'));
assert.deepStrictEqual(calls[0].body.voice_settings, { stability: 0.3, similarity_boost: 0.9 });

// TTS từ chối model → chuyển Dialogue, chia đoạn, nối buffer; lần sau đi thẳng Dialogue.
v4._resetMode();
calls = [];
const req = async (m, url, body) => {
  calls.push({ url, body });
  if (url.startsWith('/v1/text-to-speech')) throw new Error('ElevenLabs HTTP 422: {"detail":"model_id eleven_v4 is not supported"}');
  return { buffer: Buffer.from(body.inputs[0].text.slice(0, 1)) };
};
r = await v4.generateV4(req, { voiceId: 'V', modelId: 'eleven_v4', text: long, settings: {} });
assert.strictEqual(r.via, 'dialogue');
assert.ok(r.chunks >= 1);
const dl = calls.filter(c => c.url.startsWith('/v1/text-to-dialogue'));
assert.strictEqual(dl.length, r.chunks);
dl.forEach(c => { assert.ok(c.body.inputs[0].text.length <= 2000); assert.deepStrictEqual(c.body.settings, { stability: 0.5, similarity: 0.75 }); });
calls = [];
await v4.generateV4(req, { voiceId: 'V', modelId: 'eleven_v4', text: 'Hi.' });
assert.ok(calls.every(c => c.url.startsWith('/v1/text-to-dialogue')), 'nhớ mode dialogue');

// Lỗi key ở TTS → ném ra, không đổi sang Dialogue.
v4._resetMode();
await assert.rejects(v4.generateV4(async () => { throw new Error('ElevenLabs HTTP 401: invalid_api_key'); },
  { voiceId: 'V', modelId: 'eleven_v4', text: 'Hi.' }), /401/);

console.log('eleven-v4: OK');
})().catch(e => { console.error(e); process.exit(1); });
