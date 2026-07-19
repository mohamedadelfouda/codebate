import test from "node:test";
import assert from "node:assert/strict";
import { buildUsage, estimateCostUsd, sumUsage, MODEL_PRICING } from "../../server/usage.js";

test("buildUsage normalizes provider fields into the uniform shape", () => {
  const u = buildUsage("cursor", { inputTokens: 100, outputTokens: 50, reasoningTokens: 10, cachedInputTokens: 40, cacheWriteTokens: 5 });
  assert.equal(u.source, "cursor");
  assert.equal(u.inputTokens, 100);
  assert.equal(u.outputTokens, 50);
  assert.equal(u.reasoningTokens, 10);
  assert.equal(u.cachedInputTokens, 40);
  assert.equal(u.cacheWriteTokens, 5);
  assert.equal(u.totalTokens, 160); // input + output + reasoning; cached/write are subsets, not re-added
  assert.equal(u.costUsd, null);
});

test("buildUsage coerces missing/negative/NaN counts to 0 and keeps a real cost", () => {
  const u = buildUsage("", { inputTokens: -5, outputTokens: undefined, reasoningTokens: NaN, costUsd: 0.0123 });
  assert.equal(u.source, "unknown");
  assert.equal(u.inputTokens, 0);
  assert.equal(u.outputTokens, 0);
  assert.equal(u.totalTokens, 0);
  assert.equal(u.costUsd, 0.0123);
});

test("estimateCostUsd prefers the provider figure, then a priced model, else null", () => {
  assert.equal(estimateCostUsd({ source: "claude", model: "opus", providerCostUsd: 0.42 }), 0.42);
  // no pricing entry and no provider figure → null (unknown, never 0)
  assert.equal(estimateCostUsd({ source: "codex", model: "gpt-x", inputTokens: 1000, outputTokens: 500 }), null);
  assert.deepEqual(Object.keys(MODEL_PRICING), []); // ships empty on purpose — no stale rates
});

test("sumUsage aggregates tokens and known costs, leaving cost null until one is real", () => {
  const a = buildUsage("claude", { inputTokens: 10, outputTokens: 20, costUsd: 0.01 });
  const b = buildUsage("codex", { inputTokens: 5, outputTokens: 5 }); // no cost
  const total = sumUsage([a, b, null, "junk"]);
  assert.equal(total.inputTokens, 15);
  assert.equal(total.outputTokens, 25);
  assert.equal(total.totalTokens, 40); // a=(10+20)=30, b=(5+5)=10
  assert.equal(total.costUsd, 0.01); // only `a` carried a cost
  assert.equal(sumUsage([b]).costUsd, null); // no real cost anywhere → null
});
