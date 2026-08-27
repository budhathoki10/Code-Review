import { describe, it, expect } from "vitest";
import { findResolvedFindings, formatResolvedNote, filterCarriedForwardFindings } from "@/lib/review/pipeline";
import { estimateCost } from "@/lib/db/usage";
import type { FindingDoc } from "@/lib/db/collections";

function finding(overrides: Partial<FindingDoc> = {}): FindingDoc {
  return {
    severity: "medium",
    category: "quality",
    file: "src/a.ts",
    title: "example finding",
    explanation: "example explanation",
    ...overrides,
  };
}

describe("findResolvedFindings", () => {
  it("treats a finding on a re-reviewed file that is no longer reported as resolved", () => {
    const previous = [finding({ file: "src/a.ts", title: "null deref" })];
    const resolved = findResolvedFindings(previous, new Set(["src/a.ts"]), []);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].title).toBe("null deref");
  });

  it("does not treat a finding on an untouched file as resolved", () => {
    // Nothing re-examined it, so "not re-reported" says nothing about it.
    const previous = [finding({ file: "src/untouched.ts", title: "null deref" })];

    expect(findResolvedFindings(previous, new Set(["src/other.ts"]), [])).toHaveLength(0);
  });

  it("does not treat a still-reported finding as resolved", () => {
    const previous = [finding({ file: "src/a.ts", title: "null deref" })];
    const current = [finding({ file: "src/a.ts", title: "Null Deref" })];

    // Matched case-insensitively — the model rarely re-words a title exactly.
    expect(findResolvedFindings(previous, new Set(["src/a.ts"]), current)).toHaveLength(0);
  });

  it("resolves one finding while keeping another on the same file", () => {
    const previous = [
      finding({ file: "src/a.ts", title: "null deref" }),
      finding({ file: "src/a.ts", title: "unused import" }),
    ];
    const current = [finding({ file: "src/a.ts", title: "unused import" })];

    const resolved = findResolvedFindings(previous, new Set(["src/a.ts"]), current);
    expect(resolved.map((f) => f.title)).toEqual(["null deref"]);
  });

  it("returns nothing when there was no previous review", () => {
    expect(findResolvedFindings([], new Set(["src/a.ts"]), [])).toEqual([]);
  });
});

describe("formatResolvedNote", () => {
  it("says how many were resolved and names them", () => {
    const note = formatResolvedNote([finding({ file: "src/a.ts", title: "null deref" })]);

    expect(note).toContain("1 finding(s)");
    expect(note).toContain("null deref");
    expect(note).toContain("src/a.ts");
  });

  it("caps the list rather than printing fifty lines", () => {
    const many = Array.from({ length: 12 }, (_, i) => finding({ title: `issue ${i}` }));
    const note = formatResolvedNote(many);

    expect(note).toContain("12 finding(s)");
    expect(note).toContain("and 7 more");
  });

  it("is empty when nothing was resolved, so callers can append unconditionally", () => {
    expect(formatResolvedNote([])).toBe("");
  });
});

describe("carry-forward and resolution together", () => {
  it("a finding is either carried forward or considered for resolution, never both", () => {
    const previous = [
      finding({ file: "src/touched.ts", title: "fixed one" }),
      finding({ file: "src/untouched.ts", title: "still open" }),
    ];
    const touched = new Set(["src/touched.ts"]);

    const carried = filterCarriedForwardFindings(previous, touched);
    const resolved = findResolvedFindings(previous, touched, []);

    expect(carried.map((f) => f.title)).toEqual(["still open"]);
    expect(resolved.map((f) => f.title)).toEqual(["fixed one"]);
    // Disjoint: no finding can be both carried forward and declared fixed.
    const overlap = carried.filter((c) => resolved.some((r) => r.title === c.title));
    expect(overlap).toEqual([]);
  });
});

describe("estimateCost", () => {
  it("returns 0 when no rates are configured, rather than inventing a price", () => {
    expect(estimateCost({ inputTokens: 100_000, outputTokens: 5_000, totalTokens: 105_000, calls: 3 })).toBe(0);
  });
});
