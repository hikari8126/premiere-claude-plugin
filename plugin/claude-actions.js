// plugin/claude-actions.js — whitelist action Claude được gọi trong tab Claude (global CLA).
// Claude chỉ "hiểu ý" → khối ```actions; plugin đối chiếu danh sách này trước khi chạy.
// mode 'auto' = chạy luôn; 'confirm' = hiện nút hỏi trước (việc tốn credit / đổi project).
// Danh sách phải khớp prompt ở bridge/chat-prompt.js — test chat-prompt.test.js kiểm hai chiều.

var CLA = (function () {
  var TABS = ['voicegen', 'autocut', 'subtext', 'unnest', 'watch', 'resize', 'rawcut'];
  var TAB_NAMES = { voicegen: 'Voice Gen', autocut: 'Autocut', subtext: 'Tạo Sub', unnest: 'Un-nest',
                    watch: 'Watch', resize: 'Resize', rawcut: 'RAW' };

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
