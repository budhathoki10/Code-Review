import { describe, it, expect } from "vitest";
import { windowAroundLine } from "@/lib/ai/reply";

/**
 * Which part of a large file reaches the model when someone asks about a
 * finding in it.
 *
 * Lives in its own file rather than in finding-reply.test.ts, which mocks
 * `@/lib/ai/reply` wholesale to keep the pipeline off the provider — the mock
 * would replace the very function under test here.
 */

/** A file of `count` lines, each identifiably numbered and padded to a realistic width. */
function file(count: number, marker?: { at: number; text: string }): string {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    if (marker && n === marker.at) return marker.text;
    return `  const value${n} = compute(${n}); // line ${n}`;
  }).join("\n");
}

/** The window content with the omission markers stripped, i.e. what counts against the budget. */
function body(windowed: string): string {
  return windowed
    .split("\n")
    .filter((l) => !l.startsWith("... [lines "))
    .join("\n");
}

describe("windowAroundLine", () => {
  it("returns a file that already fits byte-for-byte", () => {
    const small = file(50);

    expect(windowAroundLine(small, 25, 12_000)).toBe(small);
  });

  it("keeps the finding's line when it sits deep in a large file", () => {
    // The bug this exists to prevent: head-slicing a 6,000-line file sends
    // roughly its first 320 lines, so line 4,500 never reaches the model.
    const windowed = windowAroundLine(file(6_000), 4_500, 12_000);

    expect(windowed).toContain("// line 4500");
    expect(windowed).not.toContain("// line 1\n");
    expect(windowed).toMatch(/^\.\.\. \[lines 1-\d+ omitted\]/);
  });

  it("includes a cause well above the finding — the case a ±10 window would miss", () => {
    // Regression guard from PR #56: the finding was at line 63 but the line
    // the model actually cited was at 38, 25 lines above it.
    const windowed = windowAroundLine(
      file(6_000, { at: 4_475, text: "  const queue = byBody.get(comment.body); // the real cause" }),
      4_500,
      12_000,
    );

    expect(windowed).toContain("byBody.get(comment.body)");
  });

  it("spends the whole budget downward for a finding near the top", () => {
    const windowed = windowAroundLine(file(6_000), 3, 12_000);

    expect(windowed).toContain("// line 1");
    expect(windowed).not.toContain("lines 1-");
    // Budget isn't half-wasted on the two lines that exist above line 3.
    expect(body(windowed).length).toBeGreaterThan(11_000);
  });

  it("spends the whole budget upward for a finding near the end", () => {
    const windowed = windowAroundLine(file(6_000), 5_999, 12_000);

    expect(windowed).toContain("// line 6000");
    expect(windowed).not.toMatch(/lines \d+-6000 omitted/);
    expect(body(windowed).length).toBeGreaterThan(11_000);
  });

  it("never exceeds the budget", () => {
    for (const line of [1, 3, 500, 4_500, 6_000]) {
      expect(body(windowAroundLine(file(6_000), line, 12_000)).length).toBeLessThanOrEqual(12_000);
    }
  });

  it("reports the omitted ranges with real 1-based line numbers", () => {
    const windowed = windowAroundLine(file(6_000), 3_000, 12_000);
    const before = windowed.match(/^\.\.\. \[lines 1-(\d+) omitted\]/);
    const after = windowed.match(/\.\.\. \[lines (\d+)-6000 omitted\]$/);

    expect(before).not.toBeNull();
    expect(after).not.toBeNull();

    // The omitted ranges must abut the kept window exactly — no line falls
    // through the gap, and none is claimed as both kept and omitted.
    const firstKept = Number(before![1]) + 1;
    const lastKept = Number(after![1]) - 1;
    expect(windowed).toContain(`// line ${firstKept}`);
    expect(windowed).toContain(`// line ${lastKept}`);
    expect(firstKept).toBeLessThan(3_000);
    expect(lastKept).toBeGreaterThan(3_000);
  });

  it("falls back to the top of the file when the finding has no line", () => {
    const windowed = windowAroundLine(file(6_000), undefined, 12_000);

    expect(windowed).toContain("// line 1");
    expect(windowed).toContain("... [truncated]");
  });

  it("handles a line number past the end of the file without throwing", () => {
    // A stale finding whose file shrank since the review.
    const windowed = windowAroundLine(file(6_000), 99_999, 12_000);

    expect(windowed).toContain("// line 6000");
  });
});
