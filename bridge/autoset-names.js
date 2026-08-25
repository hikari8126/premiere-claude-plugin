// bridge/autoset-names.js
// Dựng tên sequence / đường dẫn bin / tên file voice cho một bộ 3 video.
// Module THUẦN: không I/O, không Express → test trực tiếp bằng node + assert.

// Thay {biến} trong mẫu. Thiếu biến thì NÉM — thà lỗi rõ còn hơn đặt sai tên
// deliverable giao cho CO.
function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, function (_m, key) {
    if (vars[key] === undefined || vars[key] === null || vars[key] === '') {
      throw new Error('thiếu biến "' + key + '" khi dựng tên từ mẫu: ' + tpl);
    }
    return String(vars[key]);
  });
}

// Làm sạch tên voice để dùng trong tên file (giữ khoảng trắng — tên thật có
// khoảng trắng: "31.0 - Advertising Voice 2.mp3").
function safeVoiceName(name) {
  var n = String(name || '').trim();
  if (!n) throw new Error('thiếu tên voice');
  // Thay các ký tự không hợp lệ
  n = n.replace(/[\/\\:*?"<>|]/g, '-');
  // Xóa dấu chấm và khoảng trắng ở cuối
  n = n.replace(/[\s.]+$/, '');
  // Kiểm tra lại nếu rỗng sau khi xóa trailing chars
  if (!n) throw new Error('thiếu tên voice');
  return n;
}

// voiceName: string (áp dụng chung cho cả 3 job — hành vi cũ) HOẶC mảng đúng 3
// tên (mỗi job dùng voiceNames[idx], voice khác nhau theo từng video).
function buildSetNames(cfg, setNumber, ext, voiceName) {
  var set = String(setNumber).trim();
  if (!/^\d+$/.test(set)) throw new Error('số bộ không hợp lệ: "' + setNumber + '"');
  // Bỏ leading zeros: "031" → "31", "0" → "0" (dùng regex để tránh mất độ chính xác với số dài)
  set = set.replace(/^0+(?=\d)/, '');
  var e = (ext || 'mp3').replace(/^\./, '');

  var isArr = Array.isArray(voiceName);
  if (isArr && voiceName.length < 3) {
    throw new Error('thiếu voiceName cho đủ 3 job: cần mảng 3 phần tử, nhận được ' + voiceName.length);
  }

  var jobs = [];
  for (var idx = 0; idx < 3; idx++) {
    var vn = safeVoiceName(isArr ? voiceName[idx] : voiceName);
    var vars = { sp: cfg.product, set: set, idx: idx, CO: cfg.co, Editor: cfg.editor };
    jobs.push({
      idx: idx,
      seqName:     renderTemplate(cfg.seqNameTpl, vars),
      seqBin:      renderTemplate(cfg.seqBinTpl, vars),
      voiceBin:    renderTemplate(cfg.voiceBinTpl, vars),
      voiceSubdir: set + 'x',
      voiceFile:   set + '.' + idx + ' - ' + vn + '.' + e,
    });
  }
  return jobs;
}

// Chọn thư mục voice-over trong danh sách tên có sẵn (không phân biệt hoa/thường).
// Trả về tên ĐÚNG NHƯ TRÊN ĐĨA, hoặc null nếu không có.
function findVoiceOverDir(names) {
  var list = names || [];
  for (var i = 0; i < list.length; i++) {
    if (/^(voice\s*over|voiceover|vo)$/i.test(String(list[i]).trim())) return list[i];
  }
  return null;
}

module.exports = { renderTemplate, safeVoiceName, buildSetNames, findVoiceOverDir };
