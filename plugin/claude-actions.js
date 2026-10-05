// plugin/claude-actions.js — whitelist action Claude được gọi trong tab Claude (global CLA).
// Claude chỉ "hiểu ý" → khối ```actions; plugin đối chiếu danh sách này trước khi chạy.
// mode 'auto' = chạy luôn; 'confirm' = hỏi trước (việc tốn credit / thay đổi project).
// Danh sách phải khớp prompt ở bridge/chat-prompt.js — test chat-prompt.test.js kiểm hai chiều.

var CLA = (function () {
  var TABS = ['voicegen', 'autocut', 'subtext', 'unnest', 'watch', 'resize', 'rawcut'];
  var TAB_NAMES = { voicegen: 'Voice Gen', autocut: 'Autocut', subtext: 'Tạo Sub', unnest: 'Un-nest',
                    watch: 'Watch', resize: 'Resize', rawcut: 'RAW' };

  var PLATFORMS = ['GG', 'FB', 'PIN'];
  // "9:16" / "9x16" / "9-16" → khoá ratio của tab Resize ("9-16").
  function normRatio(v) {
    var m = String(v || '').trim().match(/^(\d+)\s*[:x×\-\/]\s*(\d+)$/i);
    var k = m ? m[1] + '-' + m[2] : '';
    return ['9-16', '4-5', '1-1', '2-3'].indexOf(k) >= 0 ? k : '';
  }

  function parse(text) {
    var out = [], re = /```actions\s*([\s\S]*?)```/g, m;
    while ((m = re.exec(String(text || ''))) !== null) {
      try {
        var p = JSON.parse(m[1].trim());
        out = out.concat(Array.isArray(p) ? p : [p]);
      } catch (e) { /* khối hỏng → bỏ */ }
    }
    return out.filter(function (a) { return a && typeof a === 'object'; });
  }

  var RULES = {
    get_timeline_info: function () { return { mode: 'auto' }; },
    open_tab: function (a) {
      if (TABS.indexOf(a.tab) < 0) return { error: 'không có tab "' + a.tab + '"' };
      return { mode: 'auto' };
    },
    voicegen_script: function (a) {
      if (!a.text || !String(a.text).trim()) return { error: 'thiếu script' };
      return { mode: a.autoGenerate ? 'confirm' : 'auto' };   // gen luôn = tốn credit ElevenLabs
    },
    voicegen_sfx: function (a) {
      if (!a.text || !String(a.text).trim()) return { error: 'thiếu mô tả SFX' };
      return { mode: a.autoGenerate ? 'confirm' : 'auto' };
    },
    autocut_load: function (a) {
      if (!Array.isArray(a.rows) || !a.rows.length) return { error: 'thiếu rows' };
      return { mode: 'auto' };
    },
    // Chuyển item giữa các bin — item lấy nguyên chuỗi "<bin> ▸ <tên>" từ tool list_bin/find_items.
    // Luôn qua thẻ xem trước + bấm xác nhận.
    move_items: function (a) {
      if (!Array.isArray(a.moves) || !a.moves.length) return { error: 'thiếu danh sách moves' };
      for (var i = 0; i < a.moves.length; i++) {
        var m = a.moves[i] || {};
        if (!m.item || !m.to) return { error: 'mỗi dòng moves cần item và to' };
      }
      return { mode: 'confirm' };
    },
    // Xếp việc xuất RAW vào hàng đợi nhiều project (từ ảnh / tin Slack "Beat cuts to export").
    // items: [{product, set, idxs?}] — plugin map sản phẩm → project đã mở trước đó; luôn qua thẻ xác nhận.
    queue_raw: function (a) {
      if (!Array.isArray(a.items) || !a.items.length) return { error: 'thiếu items' };
      for (var i = 0; i < a.items.length; i++) {
        var it = a.items[i] || {};
        if (!String(it.product || '').trim() || !/^\d+$/.test(String(it.set || ''))) return { error: 'mỗi dòng cần product và set (số bộ)' };
      }
      return { mode: 'confirm' };
    },
    // Plugin tự quét: voice "N.x - …" nằm sai bin / ngoài "Voice Over / Nx" → thẻ xem trước.
    fix_voice_bins: function () { return { mode: 'confirm' }; },
    // Nhân bản sequence sang ratio khác (tab Resize). items: ref "<bin> ▸ <tên sequence>";
    // trống = sequence đang chọn ở Project panel / đang mở. ratios trống = mọi ratio của nền tảng.
    resize: function (a) {
      if (PLATFORMS.indexOf(a.platform) < 0) return { error: 'platform phải là GG, FB hoặc PIN' };
      if (a.items != null && !Array.isArray(a.items)) return { error: 'items phải là danh sách' };
      var rs = [];
      for (var i = 0; i < (a.ratios || []).length; i++) {
        var k = normRatio(a.ratios[i]);
        if (!k) return { error: 'ratio "' + a.ratios[i] + '" không có (9:16, 4:5, 1:1, 2:3)' };
        if (rs.indexOf(k) < 0) rs.push(k);
      }
      a.ratios = rs;
      a.items = a.items || [];
      return { mode: 'confirm' };
    },
    // Dựng bin GG / PIN cho bộ: bin "Sequence / GG / 40x / 40.N" + 40.N (bản sao FB gốc) + 40.N 4x5 FB
    // + bản đích dọc/ngang/vuông (từ template / bộ gần nhất). set trống = bộ của sequence đang mở.
    bin_set: function (a) {
      if (['GG', 'PIN'].indexOf(a.platform) < 0) return { error: 'platform phải là GG hoặc PIN' };
      if (a.set != null && a.set !== '' && !/^\d+$/.test(String(a.set))) return { error: 'set phải là số bộ, vd "40"' };
      if (a.idxs != null && !Array.isArray(a.idxs)) return { error: 'idxs phải là danh sách số' };
      a.set = a.set != null ? String(a.set) : '';
      a.idxs = (a.idxs || []).map(Number).filter(function (n) { return n >= 0; });
      return { mode: 'confirm' };
    },
    // Dựng APP (Applovin): nhân bản FB gốc → "<SP> AppLovin vid40.N" vào "Sequence / APP / 40x".
    app_set: function (a) {
      if (a.set != null && a.set !== '' && !/^\d+$/.test(String(a.set))) return { error: 'set phải là số bộ, vd "40"' };
      if (a.idxs != null && !Array.isArray(a.idxs)) return { error: 'idxs phải là danh sách số' };
      a.set = a.set != null ? String(a.set) : ''; a.idxs = (a.idxs || []).map(Number).filter(function (n) { return n >= 0; });
      return { mode: 'confirm' };
    },
    // PIN theo đơn: resize 2:3 từ FB gốc vào "Sequence / PIN / Order <ngày>" (order trống = hôm nay).
    pin_order: function (a) {
      if (a.set != null && a.set !== '' && !/^\d+$/.test(String(a.set))) return { error: 'set phải là số bộ, vd "40"' };
      if (a.idxs != null && !Array.isArray(a.idxs)) return { error: 'idxs phải là danh sách số' };
      a.set = a.set != null ? String(a.set) : ''; a.idxs = (a.idxs || []).map(Number).filter(function (n) { return n >= 0; });
      a.order = a.order ? String(a.order).slice(0, 60) : '';
      return { mode: 'confirm' };
    },
    // Chuẩn bị tab RAW (xuất từng cut). mode: source (raw/) | render (edited/) | both.
    rawcut: function (a) {
      if (['source', 'render', 'both'].indexOf(a.mode) < 0) return { error: 'mode phải là source, render hoặc both' };
      if (a.items != null && !Array.isArray(a.items)) return { error: 'items phải là danh sách' };
      a.items = a.items || [];
      a.export = !!a.export;                       // true = tự xuất sau khi đọc (quy trình "RAW")
      return { mode: 'confirm' };
    }
  };

  function check(action) {
    var a = {};
    for (var k in (action || {})) a[k] = action[k];
    var rule = RULES[a.action];
    if (!rule) return { ok: false, error: 'action "' + (a.action || '?') + '" không hỗ trợ' };
    var r = rule(a);
    if (r.error) return { ok: false, error: r.error };
    return { ok: true, mode: r.mode, action: a };
  }

  return { parse: parse, check: check, ACTIONS: Object.keys(RULES), TABS: TABS, TAB_NAMES: TAB_NAMES };
})();

(function (root) {
  if (root) { root.CLA = CLA; }
  if (typeof module !== "undefined" && module.exports) { module.exports = CLA; }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
