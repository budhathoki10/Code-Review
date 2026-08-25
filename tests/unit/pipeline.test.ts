import { describe, it, expect } from "vitest";
import { filterCarriedForwardFindings } from "@/lib/review/pipeline";
import type { FindingDoc } from "@/lib/db/collections";

function finding(overrides: Partial<FindingDoc> = {}): FindingDoc {
  return {
    severity: "medium",
    category: "quality",
    file: "src/untouched.ts",
    title: "example finding",
    explanation: "example explanation",
    ...overrides,
  };
}

describe("filterCarriedForwardFindings", () => {
  it("keeps findings on files the new delta did not touch", () => {
    const previous = [finding({ file: "src/a.ts" }), finding({ file: "src/b.ts" })];
    const touched = new Set(["src/e.ts", "src/f.ts"]);

    const result = filterCarriedForwardFindings(previous, touched);

    expect(result).toEqual(previous);
  });

  it("drops findings on files the new delta touched", () => {
    const previous = [finding({ file: "src/a.ts" }), finding({ file: "src/e.ts" })];
    const touched = new Set(["src/e.ts", "src/f.ts"]);

    const result = filterCarriedForwardFindings(previous, touched);

    expect(result).toEqual([finding({ file: "src/a.ts" })]);
  });

  it("returns an empty array when every previous finding's file was touched", () => {
    const previous = [finding({ file: "src/e.ts" }), finding({ file: "src/f.ts" })];
    const touched = new Set(["src/e.ts", "src/f.ts"]);

    expect(filterCarriedForwardFindings(previous, touched)).toEqual([]);
  });

  it("returns everything unchanged when the touched set is empty (e.g. an empty incremental delta)", () => {
    const previous = [finding({ file: "src/a.ts" }), finding({ file: "src/b.ts" })];

    expect(filterCarriedForwardFindings(previous, new Set())).toEqual(previous);
  });

  it("returns an empty array when there were no previous findings", () => {
    expect(filterCarriedForwardFindings([], new Set(["src/e.ts"]))).toEqual([]);
  });
});
