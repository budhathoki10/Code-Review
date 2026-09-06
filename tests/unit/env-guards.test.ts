import { afterEach, describe, expect, it, vi } from "vitest";
import { envNumber } from "@/lib/env";

afterEach(() => vi.unstubAllEnvs());

describe("envNumber", () => {
  it("reads a configured number", () => {
    vi.stubEnv("PRSENTRY_TEST_N", "42");
    expect(envNumber("PRSENTRY_TEST_N", 7)).toBe(42);
  });

  it("falls back when the variable is absent", () => {
    expect(envNumber("PRSENTRY_TEST_ABSENT", 7)).toBe(7);
  });

  it("honours a configured zero", () => {
    // "0" is a truthy string but a falsy number, so an emptiness check written
    // on the number instead of the raw string would silently ignore a
    // deliberate zero — which is how a caller disables a budget entirely.
    vi.stubEnv("PRSENTRY_TEST_N", "0");
    expect(envNumber("PRSENTRY_TEST_N", 7)).toBe(0);
  });

  it.each(["", "   ", "8s", "abc", "25 chars", "NaN", "Infinity", "-Infinity"])(
    "falls back on the unusable value %o rather than yielding NaN",
    (raw) => {
      // The whole point: NaN loses every comparison it takes part in without
      // raising anything, so a typo in one variable disables a budget, a
      // timeout or the entire inline-comment path with no signal anywhere.
      vi.stubEnv("PRSENTRY_TEST_N", raw);
      expect(envNumber("PRSENTRY_TEST_N", 7)).toBe(7);
    },
  );

  it("never returns a non-finite number", () => {
    for (const raw of ["1e999", "-1e999", "abc"]) {
      vi.stubEnv("PRSENTRY_TEST_N", raw);
      expect(Number.isFinite(envNumber("PRSENTRY_TEST_N", 7))).toBe(true);
    }
  });
});

describe("the constants that guard silently-failing budgets", () => {
  it("keeps inline comments working when MAX_INLINE_COMMENTS is unusable", async () => {
    // Number("8s") is NaN; `comments.length <= NaN` is false and
    // `ranked.slice(0, NaN)` is empty, so the old shape posted ZERO inline
    // comments for every review and logged nothing at all.
    vi.stubEnv("MAX_INLINE_COMMENTS", "8s");
    vi.resetModules();
    const { MAX_INLINE_COMMENTS, capInlineComments } = await import("@/lib/github/diff-lines");
    expect(MAX_INLINE_COMMENTS).toBe(25);
    const comments = Array.from({ length: 3 }, (_, index) => ({
      path: "src/a.ts", line: index + 1, body: "b",
      finding: { file: "src/a.ts", line: index + 1, title: "T", explanation: "E", category: "bug" as const, severity: "high" as const },
    }));
    expect(capInlineComments(comments).posted).toHaveLength(3);
  });
});
