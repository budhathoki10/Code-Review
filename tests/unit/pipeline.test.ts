import { describe, it, expect } from "vitest";
import { filterCarriedForwardFindings, categoryFilter } from "@/lib/review/pipeline";
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

describe("categoryFilter", () => {
  it("keeps everything when the repo disabled nothing", () => {
    const findings = [finding({ category: "testing" }), finding({ category: "security" })];

    expect(findings.filter(categoryFilter([]))).toEqual(findings);
    expect(findings.filter(categoryFilter(undefined))).toEqual(findings);
  });

  it("drops only the disabled category, leaving the other axes alone", () => {
    const findings = [
      finding({ category: "testing", severity: "critical" }),
      finding({ category: "security", severity: "info" }),
      finding({ category: "quality" }),
    ];

    const kept = findings.filter(categoryFilter(["testing"]));

    // A critical finding is still dropped: category is not a severity filter.
    // An info-level one survives: disabling a category says nothing about how
    // bad the remaining findings have to be.
    expect(kept.map((f) => f.category)).toEqual(["security", "quality"]);
  });

  it("drops several categories at once", () => {
    const findings = [
      finding({ category: "testing" }),
      finding({ category: "performance" }),
      finding({ category: "bug" }),
    ];

    expect(findings.filter(categoryFilter(["testing", "performance"])).map((f) => f.category)).toEqual(["bug"]);
  });

  it("unions the dashboard and .prsentry.yaml lists rather than letting one win", () => {
    const findings = [
      finding({ category: "testing" }),
      finding({ category: "performance" }),
      finding({ category: "bug" }),
    ];

    // Dashboard disables testing, the repo file disables performance. Neither
    // config can re-enable what the other switched off, so both are dropped.
    const kept = findings.filter(categoryFilter(["testing"], ["performance"]));

    expect(kept.map((f) => f.category)).toEqual(["bug"]);
  });

  it("tolerates either config source being absent", () => {
    const findings = [finding({ category: "testing" }), finding({ category: "bug" })];

    expect(findings.filter(categoryFilter(undefined, ["testing"])).map((f) => f.category)).toEqual(["bug"]);
    expect(findings.filter(categoryFilter(["testing"], undefined)).map((f) => f.category)).toEqual(["bug"]);
    expect(findings.filter(categoryFilter(undefined, undefined))).toEqual(findings);
  });

  it("applies to static-analysis findings the same as to AI ones", () => {
    // Static findings are only ever "security" or "quality" — a repo that
    // turns off quality must stop receiving the linter's quality output too,
    // not just the model's.
    const findings = [
      finding({ category: "quality", source: "static-analysis" }),
      finding({ category: "security", source: "static-analysis" }),
    ];

    expect(findings.filter(categoryFilter(["quality"])).map((f) => f.source)).toEqual(["static-analysis"]);
    expect(findings.filter(categoryFilter(["quality"])).map((f) => f.category)).toEqual(["security"]);
  });
});
