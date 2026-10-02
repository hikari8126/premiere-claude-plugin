// bridge/eleven-errors.js — lỗi ElevenLabs → câu tiếng Việt cho người dùng (VG8).
// Trước đây plugin hiện nguyên "ElevenLabs HTTP 401: {"detail":{"status":"invalid_api_…"
// bị cắt ngắn. Chỉ đổi lỗi có dạng "ElevenLabs[ upload] HTTP <code>: <body>"; lỗi
// khác trả nguyên. Lỗi gốc vẫn còn trong log bridge.

function parseDetail(body) {
  try {
    const j = JSON.parse(body);
    const d = j && (j.detail !== undefined ? j.detail : j);
    if (typeof d === 'string') return { status: '', message: d };
    if (Array.isArray(d)) return { status: '', message: d.map(x => (x && (x.msg || x.message)) || '').join('; ') };
    if (d && typeof d === 'object') return { status: String(d.status || d.code || ''), message: String(d.message || '') };
  } catch (e) {}
  return { status: '', message: String(body || '') };
}

function friendlyElevenError(msg) {
  const m = String(msg || '').match(/^ElevenLabs(?: upload)? HTTP (\d{3}): ([\s\S]*)$/);
  if (!m) return String(msg || '');
  const code = Number(m[1]);
  const d = parseDetail(m[2]);
  const all = (d.status + ' ' + d.message + ' ' + m[2]).toLowerCase();

  if (/quota_exceeded|credits? (remaining|required)|insufficient.*credit/.test(all)) {
    const left = d.message.match(/(\d[\d,.]*)\s*credits? remaining/i);
    const need = d.message.match(/(\d[\d,.]*)\s*credits? (?:are )?required/i);
    return 'Hết credit ElevenLabs' + (left ? ' — còn ' + left[1] : '') + (need ? ', cần ' + need[1] : '')
      + '. Đổi sang profile khác (chip Profile) hoặc nạp thêm credit.';
  }
  if (/missing_permissions|missing the permission/.test(all)) {
    const p = d.message.match(/permission\s+([a-z_]+)/i);
    return 'API key ElevenLabs thiếu quyền' + (p ? ' "' + p[1] + '"' : '') + ' — bật quyền đó cho key trên elevenlabs.io.';
  }
  if (/voice_not_found|voice.*(not found|does not exist)/.test(all)) {
    return 'Voice không dùng được với API key này (voice của profile khác hoặc đã bị xoá) — chọn lại voice.';
  }
  if (code === 401 || /invalid_api_key|unauthorized|api key.*invalid/.test(all)) {
    return 'API key ElevenLabs không hợp lệ hoặc đã bị xoá — kiểm tra Settings → Voice Gen.';
  }
  if (code === 429 || /too_many_concurrent|rate.?limit|system_busy/.test(all)) {
    return 'ElevenLabs đang quá tải / vượt giới hạn số lượt cùng lúc — đợi ít phút rồi thử lại.';
  }
  if (/detected_unusual_activity|free tier/.test(all)) {
    return 'ElevenLabs chặn tài khoản free (phát hiện bất thường) — dùng key gói trả phí.';
  }
  const text = (d.message || m[2]).replace(/\s+/g, ' ').trim();
  return 'ElevenLabs lỗi ' + code + (text ? ': ' + (text.length > 220 ? text.slice(0, 217) + '…' : text) : '');
}

module.exports = { friendlyElevenError };
