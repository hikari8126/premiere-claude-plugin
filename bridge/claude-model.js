// bridge/claude-model.js — model Claude dùng chung cho mọi lời gọi (chat, organize,
// parse cutsheet…) + tham số request theo đời Opus 5.5. Thuần, test ở
// test/claude-model.test.js.
//
// Opus 5.5: thinking luôn bật (không tắt được, budget_tokens → 400), effort mặc định
// 'medium'; content có thể mở đầu bằng block `thinking` rỗng → KHÔNG đọc content[0].text.
// Claude CLI cũ hơn 2.1.280 từ chối model này ("does not support this model") → chỉ
// truyền --model khi CLI đủ mới, không thì để CLI dùng model mặc định của nó.

const CLAUDE_MODEL = 'claude-opus-5-5';
const MIN_CLI_FOR_MODEL = '2.1.280';

// "2.1.218 (Claude Code)" → [2,1,218]; không đọc được → null.
function parseCliVersion(s) {
  const m = String(s || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cliAtLeast(versionStr, min) {
  const a = parseCliVersion(versionStr), b = parseCliVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

// Tham số --model cho `claude --print`: [] khi CLI cũ / không rõ phiên bản.
function cliModelArgs(versionStr, model) {
  return cliAtLeast(versionStr, MIN_CLI_FOR_MODEL) ? ['--model', model || CLAUDE_MODEL] : [];
}

// Model client gửi lên (setting cũ có thể còn 'claude-sonnet-4-6'…): chỉ nhận đời hiện
// hành, còn lại dùng fallback (model mặc định của bridge).
const CURRENT_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'];
function pickModel(m, fallback) {
  return CURRENT_MODELS.indexOf(m) >= 0 ? m : (fallback || CLAUDE_MODEL);
}

// Body cho client.beta.messages.create/stream. fallbacks:'default' → model từ chối
// (refusal) thì server tự chạy lại trên model dự phòng theo loại từ chối.
function apiParams(p) {
  return Object.assign({
    model: p.model || CLAUDE_MODEL,
    max_tokens: Math.max(p.maxTokens || 0, 16000),   // thinking cũng tính vào max_tokens
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: p.effort || 'medium' },
  }, p.system ? { system: p.system } : {}, { messages: p.messages });
}

// Ghép mọi block text; cả chuỗi model đều từ chối → ném lỗi rõ thay vì trả rỗng.
function textOf(resp) {
  if (resp && resp.stop_reason === 'refusal') {
    const cat = resp.stop_details && resp.stop_details.category;
    throw new Error('Claude từ chối yêu cầu này' + (cat ? ' (' + cat + ')' : ''));
  }
  return ((resp && resp.content) || [])
    .filter(b => b && b.type === 'text')
    .map(b => b.text || '')
    .join('');
}

module.exports = { CLAUDE_MODEL, CURRENT_MODELS, MIN_CLI_FOR_MODEL, pickModel, parseCliVersion, cliAtLeast, cliModelArgs, apiParams, textOf };
