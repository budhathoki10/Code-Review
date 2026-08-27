import { describe, it, expect } from "vitest";
import { visibleFindings, groupFindingsBySeverity } from "@/lib/review/review-display";
import type { FindingDoc, ReviewDoc } from "@/lib/db/collections";

function finding(overrides: Partial<FindingDoc> = {}): FindingDoc {
  return {
    severity: "low",
    category: "quality",
    file: "src/untouched.ts",
    title: "example finding",
    explanation: "example explanation",
    ...overrides,
  };
}

function review(overrides: Partial<ReviewDoc> = {}): ReviewDoc {
  return {
    pullRequestId: "pr-1",
    headSha: "sha",
    status: "completed",
    findings: [],
    createdAt: new Date(),
    ...overrides,
  };
}

describe("visibleFindings", () => {
  it("only shows findings on files this round's diff touched", () => {
    const r = review({
      findings: [finding({ file: "src/a.ts" }), finding({ file: "src/b.ts" })],
      touchedFiles: ["src/b.ts"],
    });

    expect(visibleFindings(r)).toEqual([finding({ file: "src/b.ts" })]);
  });

  it("shows every finding when touchedFiles is absent (reviews saved before the field existed)", () => {
    const r = review({
      findings: [finding({ file: "src/a.ts" }), finding({ file: "src/b.ts" })],
    });

    expect(visibleFindings(r)).toEqual(r.findings);
  });

  it("shows nothing when touchedFiles is an empty array (e.g. an empty incremental delta)", () => {
    const r = review({
      findings: [finding({ file: "src/a.ts" })],
      touchedFiles: [],
    });

    expect(visibleFindings(r)).toEqual([]);
  });

  it("shows every finding on a first review, where touchedFiles covers the whole diff", () => {
    const r = review({
      findings: [finding({ file: "src/a.ts" }), finding({ file: "src/b.ts" })],
      touchedFiles: ["src/a.ts", "src/b.ts"],
    });

    expect(visibleFindings(r)).toEqual(r.findings);
  });
});

describe("groupFindingsBySeverity", () => {
  it("groups findings by severity, worst first", () => {
    const groups = groupFindingsBySeverity([
      finding({ file: "src/a.ts", severity: "low" }),
      finding({ file: "src/b.ts", severity: "critical" }),
      finding({ file: "src/c.ts", severity: "medium" }),
    ]);

    expect(groups.map((g) => g.severity)).toEqual(["critical", "medium", "low"]);
  });

  it("keeps every finding of the same severity together, in their original relative order", () => {
    const groups = groupFindingsBySeverity([
      finding({ file: "src/a.ts", severity: "high", title: "first" }),
      finding({ file: "src/b.ts", severity: "high", title: "second" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].findings.map((f) => f.title)).toEqual(["first", "second"]);
  });

  it("omits a severity with zero findings entirely, rather than an empty group", () => {
    const groups = groupFindingsBySeverity([finding({ severity: "high" })]);

    expect(groups.map((g) => g.severity)).toEqual(["high"]);
  });

  it("returns no groups at all for a clean review", () => {
    expect(groupFindingsBySeverity([])).toEqual([]);
  });

  it("preserves each finding's file/line — nothing is grouped away", () => {
    const groups = groupFindingsBySeverity([finding({ file: "src/a.ts", line: 42, severity: "critical" })]);

    expect(groups[0].findings[0].file).toBe("src/a.ts");
    expect(groups[0].findings[0].line).toBe(42);
  });
});
