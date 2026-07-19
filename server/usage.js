// Normalized token-usage + cost accounting (P1-7). Each provider adapter maps its own field names
// (Claude snake_case, Codex counters, Cursor camelCase) into this ONE uniform shape, so the orchestrator,
// storage, UI, and benchmark never branch on provider. Token counts are always captured (the primary,
// provider-agnostic metric); cost is the provider-reported figure when it gives one (e.g. Claude's
// total_cost_usd), else derived from a per-model price table — empty by default, because shipping stale
// third-party rates would show the user wrong money. "cost unknown" is honest; a fabricated number is not.

const asCount = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

// Build the uniform usage record from a provider's already-extracted numbers. `cachedInputTokens` /
// `cacheWriteTokens` are a SUBSET of input (a billing hint) and are reported but NOT re-added to the total.
export function buildUsage(source, raw = {}) {
  const inputTokens = asCount(raw.inputTokens);
  const outputTokens = asCount(raw.outputTokens);
  const reasoningTokens = asCount(raw.reasoningTokens);
  return {
    source: String(source || "unknown"),
    inputTokens,
    cachedInputTokens: asCount(raw.cachedInputTokens),
    cacheWriteTokens: asCount(raw.cacheWriteTokens),
    outputTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens + reasoningTokens,
    costUsd: Number.isFinite(raw.costUsd) && raw.costUsd >= 0 ? raw.costUsd : null,
  };
}

// Per-model price, USD per 1e6 tokens: { input, output }. Empty by default — the owner fills verified rates
// here (or the provider reports cost directly). Keyed by "<source>:<model>" first, then bare "<model>".
export const MODEL_PRICING = Object.freeze({
  // "claude:opus": { input: 15, output: 75 },   // example shape — fill with rates you trust
});

// Cost for a run: the provider's own figure wins; else a priced model; else null (unknown — shown as such,
// never as 0).
export function estimateCostUsd({ source, model, inputTokens = 0, outputTokens = 0, providerCostUsd } = {}) {
  if (Number.isFinite(providerCostUsd) && providerCostUsd >= 0) return providerCostUsd;
  const price = MODEL_PRICING[`${source}:${model}`] || MODEL_PRICING[String(model || "")];
  if (!price) return null;
  return (asCount(inputTokens) / 1e6) * price.input + (asCount(outputTokens) / 1e6) * price.output;
}

// Aggregate usage records (per-session / per-model / global). A cost stays null until at least one record
// carries a real cost; nulls are otherwise ignored so a partial-cost mix still sums the known part.
export function sumUsage(usages = []) {
  const total = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, costUsd: null };
  for (const usage of usages) {
    if (!usage || typeof usage !== "object") continue;
    total.inputTokens += asCount(usage.inputTokens);
    total.cachedInputTokens += asCount(usage.cachedInputTokens);
    total.cacheWriteTokens += asCount(usage.cacheWriteTokens);
    total.outputTokens += asCount(usage.outputTokens);
    total.reasoningTokens += asCount(usage.reasoningTokens);
    total.totalTokens += asCount(usage.totalTokens);
    if (Number.isFinite(usage.costUsd) && usage.costUsd >= 0) total.costUsd = (total.costUsd || 0) + usage.costUsd;
  }
  return total;
}
