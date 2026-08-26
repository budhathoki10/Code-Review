import { describe, it, expect } from "vitest";
import { visibleFindings } from "@/lib/review/visible-findings";
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
