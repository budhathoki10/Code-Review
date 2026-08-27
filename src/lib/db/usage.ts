import { usage, type UsageDoc } from "@/lib/db/collections";

/** Token counts for one provider call, or summed across a whole review. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Provider calls these totals came from — 1 for a single call, up to 65 for a full chunked review (see review-worker-factory.ts). */
  calls: number;
}

export const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 };

/**
 * Folds one call's usage into a running total. `total_tokens` is taken from
 * the provider when present rather than recomputed, since a provider may
 * count cached/reasoning tokens the two components don't add up to.
 */
export function addUsage(total: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    totalTokens: total.totalTokens + next.totalTokens,
    calls: total.calls + next.calls,
  };
}

/** Normalizes an OpenAI-shaped `usage` object (absent on some providers/streams) into TokenUsage. */
export function usageFromResponse(
  responseUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
): TokenUsage {
  if (!responseUsage) return { ...EMPTY_USAGE, calls: 1 };
  const inputTokens = responseUsage.prompt_tokens ?? 0;
  const outputTokens = responseUsage.completion_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: responseUsage.total_tokens ?? inputTokens + outputTokens,
    calls: 1,
  };
}

/** Fixed key for the one shared usage document — every review accumulates into this row. */
export const GLOBAL_USAGE_KEY = "global";

/**
 * Accumulates one review's usage into the single app-wide document, creating
 * it on first use. `$inc` (not read-modify-write) so concurrent reviews —
 * routine, since the worker runs 5 at a time — can't lose an update to a
 * lost-update race.
 */
export async function recordUsage(reviewUsage: TokenUsage): Promise<void> {
  if (reviewUsage.calls === 0) return;

  const usageCol = await usage();
  const now = new Date();
  await usageCol.updateOne(
    { key: GLOBAL_USAGE_KEY },
    {
      $inc: {
        inputTokens: reviewUsage.inputTokens,
        outputTokens: reviewUsage.outputTokens,
        totalTokens: reviewUsage.totalTokens,
        calls: reviewUsage.calls,
        reviews: 1,
      },
      $set: { updatedAt: now },
      $setOnInsert: { key: GLOBAL_USAGE_KEY, createdAt: now },
    },
    { upsert: true },
  );
}

/**
 * Per-million-token rates for the configured model. Defaults are zero rather
 * than a guess: a fabricated price is worse than an explicit "not
 * configured", because it looks authoritative on a dashboard. Set
 * AI_INPUT_COST_PER_MTOK / AI_OUTPUT_COST_PER_MTOK to get real numbers.
 */
const INPUT_COST_PER_MTOK = Number(process.env.AI_INPUT_COST_PER_MTOK ?? 0);
const OUTPUT_COST_PER_MTOK = Number(process.env.AI_OUTPUT_COST_PER_MTOK ?? 0);

/** Approximate USD for one review's token usage. Returns 0 when no rates are configured. */
export function estimateCost(usage: TokenUsage): number {
  const cost =
    (usage.inputTokens / 1_000_000) * INPUT_COST_PER_MTOK +
    (usage.outputTokens / 1_000_000) * OUTPUT_COST_PER_MTOK;
  // Rounded to a tenth of a cent — more precision than that is noise given
  // the provider reports token counts, not prices.
  return Math.round(cost * 10_000) / 10_000;
}

/**
 * Cost above which a single review is considered anomalous and logged at
 * error level. Expressed in tokens rather than dollars so it still works
 * with no pricing configured — the thing being watched for is a runaway
 * review, and token count is the direct signal.
 */
export const REVIEW_TOKEN_CEILING = Number(process.env.REVIEW_TOKEN_CEILING ?? 300_000);

/** App-wide lifetime totals across every user, or null before any review has run. */
export async function getUsageSummary(): Promise<UsageDoc | null> {
  const usageCol = await usage();
  return usageCol.findOne({ key: GLOBAL_USAGE_KEY });
}
