// bridge/test/eleven-errors.test.js — lỗi ElevenLabs → câu tiếng Việt (VG8).
const assert = require('assert');
const { friendlyElevenError: f } = require('../eleven-errors.js');

assert.match(f('ElevenLabs HTTP 401: {"detail":{"status":"invalid_api_key","message":"Invalid API key"}}'), /API key ElevenLabs không hợp lệ/);
const q = f('ElevenLabs HTTP 401: {"detail":{"status":"quota_exceeded","message":"This request exceeds your quota of 10000. You have 52 credits remaining, while 340 credits are required for this request."}}');
assert.match(q, /Hết credit ElevenLabs — còn 52, cần 340/);
assert.match(f('ElevenLabs HTTP 401: {"detail":{"status":"missing_permissions","message":"The API key you used is missing the permission voices_read to execute this operation."}}'), /thiếu quyền "voices_read"/);
assert.match(f('ElevenLabs HTTP 400: {"detail":{"status":"voice_not_found","message":"A voice with the voice_id abc was not found."}}'), /Voice không dùng được/);
assert.match(f('ElevenLabs HTTP 429: {"detail":{"status":"too_many_concurrent_requests"}}'), /quá tải/);
assert.match(f('ElevenLabs HTTP 422: {"detail":[{"msg":"field required"}]}'), /^ElevenLabs lỗi 422: field required/);
assert.match(f('ElevenLabs HTTP 500: {"detail":{"status":"quota_exceeded","message":"This request exce'), /Hết credit/, 'JSON bị cắt vẫn nhận ra');
assert.match(f('ElevenLabs upload HTTP 401: {"detail":{"status":"invalid_api_key"}}'), /không hợp lệ/);
assert.strictEqual(f('Cannot create folder: /x'), 'Cannot create folder: /x', 'lỗi khác giữ nguyên');
console.log('eleven-errors: OK');
