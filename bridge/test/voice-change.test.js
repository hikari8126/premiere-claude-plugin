const assert = require('assert');
const { buildMultipartBody } = require('../server.js');

// buildMultipartBody phải là pure function export được từ server.js
const boundary = '----TESTB';
const body = buildMultipartBody(
  boundary,
  { model_id: 'eleven_multilingual_sts_v2', remove_background_noise: 'true' },
  [{ fieldName: 'audio', buffer: Buffer.from('RIFFDATA'), filename: 'in.wav', contentType: 'audio/wav' }]
);
const s = body.toString('binary');

assert.ok(body instanceof Buffer, 'trả về Buffer');
assert.ok(s.includes('name="model_id"'), 'có field model_id');
assert.ok(s.includes('eleven_multilingual_sts_v2'), 'có giá trị model');
assert.ok(s.includes('name="remove_background_noise"'), 'có field denoise');
assert.ok(s.includes('name="audio"; filename="in.wav"'), 'có file audio');
assert.ok(s.includes('RIFFDATA'), 'có nội dung file');
assert.ok(s.trim().endsWith('--' + boundary + '--'), 'đóng boundary đúng');
assert.ok(!s.includes('undefined'), 'không rò field null/undefined');

// field null bị bỏ qua
const body2 = buildMultipartBody(boundary, { a: null, b: 'x' }, []);
assert.ok(!body2.toString('binary').includes('name="a"'), 'field null bị bỏ');

console.log('OK buildMultipartBody');
