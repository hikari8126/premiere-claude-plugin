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
  return n.replace(/[\/\\:*?"<>|]/g, '-');
}

function buildSetNames(cfg, setNumber, ext, voiceName) {
  var set = String(setNumber).trim();
  if (!/^\d+$/.test(set)) throw new Error('số bộ không hợp lệ: "' + setNumber + '"');
  var e = (ext || 'mp3').replace(/^\./, '');
  var vn = safeVoiceName(voiceName);

  var jobs = [];
  for (var idx = 0; idx < 3; idx++) {
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

module.exports = { renderTemplate, safeVoiceName, buildSetNames };
