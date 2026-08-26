import { describe, it, expect } from "vitest";
import { visibleFindings, groupFindingsByFile } from "@/lib/review/review-display";
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

describe("groupFindingsByFile", () => {
  it("groups findings by file, worst severity first", () => {
    const groups = groupFindingsByFile([
      finding({ file: "src/a.ts", severity: "low" }),
      finding({ file: "src/b.ts", severity: "critical" }),
      finding({ file: "src/a.ts", severity: "medium" }),
    ]);

    expect(groups.map((g) => g.file)).toEqual(["src/b.ts", "src/a.ts"]);
    expect(groups.find((g) => g.file === "src/a.ts")?.findings.map((f) => f.severity)).toEqual(["medium", "low"]);
  });

  it("adds a zero-finding entry for a touched file with no findings, sorted after every file that has findings", () => {
    const groups = groupFindingsByFile([finding({ file: "src/a.ts", severity: "low" })], [
      "src/a.ts",
      "src/clean.ts",
    ]);

    expect(groups.map((g) => g.file)).toEqual(["src/a.ts", "src/clean.ts"]);
    expect(groups.find((g) => g.file === "src/clean.ts")).toEqual({ file: "src/clean.ts", findings: [], worst: 5 });
  });

  it("returns one zero-finding entry per touched file when nothing was flagged at all", () => {
    const groups = groupFindingsByFile([], ["src/a.ts", "src/b.ts"]);

    expect(groups).toEqual([
      { file: "src/a.ts", findings: [], worst: 5 },
      { file: "src/b.ts", findings: [], worst: 5 },
    ]);
  });

  it("does not duplicate a file that both has findings and appears in touchedFiles", () => {
    const groups = groupFindingsByFile([finding({ file: "src/a.ts" })], ["src/a.ts"]);

    expect(groups).toHaveLength(1);
    expect(groups[0].findings).toHaveLength(1);
  });
});
