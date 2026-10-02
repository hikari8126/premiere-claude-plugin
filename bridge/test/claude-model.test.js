// bridge/test/claude-model.test.js — model Claude (Opus 5.5) + tham số request + đọc text.
const test = require("node:test");
const assert = require("node:assert");
const CM = require("../claude-model.js");

test("model mặc định là Opus 5.5", () => {
  assert.strictEqual(CM.CLAUDE_MODEL, "claude-opus-5-5");
});

test("CLI cũ hơn 2.1.280 không nhận --model, CLI mới thì có", () => {
  assert.deepStrictEqual(CM.cliModelArgs("2.1.218 (Claude Code)"), []);
  assert.deepStrictEqual(CM.cliModelArgs("2.1.280 (Claude Code)"), ["--model", "claude-opus-5-5"]);
  assert.deepStrictEqual(CM.cliModelArgs("2.2.0"), ["--model", "claude-opus-5-5"]);
  assert.deepStrictEqual(CM.cliModelArgs("3.0.1"), ["--model", "claude-opus-5-5"]);
  assert.deepStrictEqual(CM.cliModelArgs(""), [], "không rõ phiên bản → để CLI tự chọn");
  assert.deepStrictEqual(CM.cliModelArgs(null), []);
});

test("apiParams: không tắt thinking, không budget_tokens/temperature, max_tokens đủ chỗ cho thinking", () => {
  const p = CM.apiParams({ maxTokens: 2048, messages: [{ role: "user", content: "hi" }] });
  assert.strictEqual(p.model, "claude-opus-5-5");
  assert.strictEqual(p.max_tokens, 16000);
  assert.deepStrictEqual(p.output_config, { effort: "medium" });
  assert.deepStrictEqual(p.betas, ["server-side-fallback-2026-07-01"]);
  assert.strictEqual(p.fallbacks, "default");
  assert.strictEqual(p.thinking, undefined);
  assert.strictEqual(p.temperature, undefined);
  assert.strictEqual(p.system, undefined);
  const q = CM.apiParams({ model: "claude-sonnet-5-5", effort: "low", system: "S", maxTokens: 40000, messages: [] });
  assert.strictEqual(q.model, "claude-sonnet-5-5");
  assert.strictEqual(q.max_tokens, 40000);
  assert.strictEqual(q.system, "S");
  assert.deepStrictEqual(q.output_config, { effort: "low" });
});

test("textOf bỏ block thinking, ghép các block text", () => {
  const r = { stop_reason: "end_turn", content: [
    { type: "thinking", thinking: "" }, { type: "text", text: "Xin " }, { type: "fallback" }, { type: "text", text: "chào" }] };
  assert.strictEqual(CM.textOf(r), "Xin chào");
});

test("textOf: refusal → ném lỗi tiếng Việt có category", () => {
  assert.throws(() => CM.textOf({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] }), /từ chối.*cyber/);
});

test("pickModel: model cũ trong setting (sonnet 4.6, opus 4.7) → model mặc định", () => {
  assert.strictEqual(CM.pickModel("claude-sonnet-4-6"), "claude-opus-5-5");
  assert.strictEqual(CM.pickModel("claude-opus-4-7"), "claude-opus-5-5");
  assert.strictEqual(CM.pickModel(undefined), "claude-opus-5-5");
  assert.strictEqual(CM.pickModel("claude-sonnet-5-5"), "claude-sonnet-5-5");
  assert.strictEqual(CM.pickModel("x", "claude-haiku-4-5"), "claude-haiku-4-5");
});
