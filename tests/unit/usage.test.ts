import { describe, it, expect } from "vitest";
import { addUsage, usageFromResponse, EMPTY_USAGE } from "@/lib/db/usage";

describe("usageFromResponse", () => {
  it("maps an OpenAI-shaped usage object and counts it as one call", () => {
    expect(usageFromResponse({ prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 })).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
      calls: 1,
    });
  });

  it("still counts the call when the provider omits usage entirely", () => {
    // The call happened and cost money even if we can't see the numbers —
    // dropping it would undercount `calls` and skew the per-review average.
    expect(usageFromResponse(undefined)).toEqual({ ...EMPTY_USAGE, calls: 1 });
  });

  it("derives total_tokens from the components when the provider omits it", () => {
    expect(usageFromResponse({ prompt_tokens: 100, completion_tokens: 40 })).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      calls: 1,
    });
  });

  it("prefers the provider's own total over recomputing it", () => {
    // A provider may count cached/reasoning tokens the two components don't sum to.
    const result = usageFromResponse({ prompt_tokens: 100, completion_tokens: 40, total_tokens: 999 });
    expect(result.totalTokens).toBe(999);
  });
});

describe("addUsage", () => {
  it("sums every field across two calls", () => {
    const a = { inputTokens: 100, outputTokens: 20, totalTokens: 120, calls: 1 };
    const b = { inputTokens: 300, outputTokens: 50, totalTokens: 350, calls: 1 };

    expect(addUsage(a, b)).toEqual({ inputTokens: 400, outputTokens: 70, totalTokens: 470, calls: 2 });
  });

  it("leaves the total unchanged when adding an empty usage", () => {
    const a = { inputTokens: 100, outputTokens: 20, totalTokens: 120, calls: 1 };

    expect(addUsage(a, EMPTY_USAGE)).toEqual(a);
  });

  it("accumulates across a multi-round findings loop", () => {
    const rounds = [
      { inputTokens: 1000, outputTokens: 50, totalTokens: 1050, calls: 1 },
      { inputTokens: 1400, outputTokens: 60, totalTokens: 1460, calls: 1 },
      { inputTokens: 1800, outputTokens: 200, totalTokens: 2000, calls: 1 },
    ];

    const total = rounds.reduce(addUsage, EMPTY_USAGE);

    // Input grows each round because the whole conversation (diff included)
    // is re-sent — that's the dominant cost of a multi-round review.
    expect(total).toEqual({ inputTokens: 4200, outputTokens: 310, totalTokens: 4510, calls: 3 });
  });
});
