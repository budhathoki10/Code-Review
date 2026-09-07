import { describe, expect, it } from "vitest";
import type { FindingDoc, ReviewDoc } from "@/lib/db/collections";
import {
  canSayNoFindings,
  findingSourceUrl,
  rendersAsSuggestionDiff,
  severityCounts,
  showsProgress,
  stageProgress,
  verificationTrail,
} from "@/lib/review/finding-presentation";
import { groupFindingsBySeverity, visibleFindings } from "@/lib/review/review-display";

/**
 * The decisions the review card makes, tested as functions rather than
 * through a renderer.
 *
 * These are the parts that have actually been wrong: a severity group that
 * hid its own findings, an empty state that claimed a clean review when the
 * provider had failed, a location that pointed at the wrong lines. Rendering
 * them proves nothing that checking them here does not.
 */

function finding(over: Partial<FindingDoc> = {}): FindingDoc {
  return {
    severity: "high",
    category: "bug",
    file: "src/auth/login.ts",
    line: 42,
    title: "Possible undefined access",
    explanation: "profile is read without checking it exists.",
    ...over,
  };
}

function review(over: Partial<ReviewDoc> = {}): ReviewDoc {
  return {
    pullRequestId: "pr1",
    headSha: "abc123",
    status: "completed",
    findings: [],
    createdAt: new Date(),
    ...over,
  } as ReviewDoc;
}

describe("linking a finding to its source", () => {
  it("points at the exact line at the reviewed commit", () => {
    const url = findingSourceUrl(finding({ commitSha: "deadbeef" }), "acme/widgets");
    expect(url).toBe("https://github.com/acme/widgets/blob/deadbeef/src/auth/login.ts#L42");
  });

  it("uses the range when the defect spans lines", () => {
    const url = findingSourceUrl(finding({ commitSha: "deadbeef", startLine: 42, endLine: 47 }), "acme/widgets");
    expect(url).toBe("https://github.com/acme/widgets/blob/deadbeef/src/auth/login.ts#L42-L47");
  });

  it("builds nothing without a commit — a link to the wrong revision is worse than none", () => {
    expect(findingSourceUrl(finding(), "acme/widgets")).toBeUndefined();
  });

  it("builds nothing without a repository", () => {
    expect(findingSourceUrl(finding({ commitSha: "deadbeef" }), undefined)).toBeUndefined();
  });

  it("refuses a repository name that is not owner/repo", () => {
    // Anything else would be interpolated straight into a URL.
    expect(findingSourceUrl(finding({ commitSha: "deadbeef" }), "not a repo/../../etc")).toBeUndefined();
  });
});

describe("the verification trail", () => {
  it("says two reviewers looked when both did", () => {
    const parts = verificationTrail({ status: "confirmed", ultra: { decision: "confirm", confidence: 0.9 }, super: { decision: "confirm", confidence: 0.9 } });
    expect(parts).toEqual(["Verified by two reviewers"]);
  });

  it("reports a resolved disagreement without reproducing the argument", () => {
    const parts = verificationTrail({
      status: "confirmed",
      ultra: { decision: "confirm", confidence: 0.9 },
      super: { decision: "reject", confidence: 0.8 },
      debate: { used: true, rounds: 2, consensusReached: false },
      arbitration: { used: true, decision: "confirmed", confidence: 0.9, reason: "The guard runs after the dereference." },
    });
    expect(parts).toEqual(["Verified by two reviewers", "Reviewers disagreed", "Resolved by independent adjudication"]);
    // The adjudicator's reasoning is stored but must never reach the reader here.
    expect(parts.join(" ")).not.toContain("dereference");
  });

  it("mentions a corrected line so the reader knows the location moved", () => {
    const parts = verificationTrail({
      status: "confirmed",
      validation: { fileValid: true, lineValid: true, snippetValid: true, commitValid: true, relevantToPR: true, correctedFrom: 40 },
    });
    expect(parts).toContain("Line corrected against source");
  });

  it("says nothing about a finding that went through no stages", () => {
    expect(verificationTrail(undefined)).toEqual([]);
  });
});

describe("when the card may claim there is nothing to report", () => {
  it("says so for a completed review with no findings at all", () => {
    expect(canSayNoFindings(review())).toBe(true);
  });

  it("TEST K: never says so for a failed review", () => {
    expect(canSayNoFindings(review({ status: "failed" }))).toBe(false);
  });

  it("never says so while the review is still running", () => {
    expect(canSayNoFindings(review({ status: "pending" }))).toBe(false);
  });

  it("never says so when findings exist", () => {
    expect(canSayNoFindings(review({ findings: [finding()] }))).toBe(false);
  });

  it("never says so when something could not be established either way", () => {
    // Unresolved is not clean. Saying "no findings" here would report the
    // reviewer's own uncertainty as an all-clear.
    expect(canSayNoFindings(review({ unresolvedFindings: [finding()] }))).toBe(false);
  });
});

describe("severity grouping and counts", () => {
  it("groups findings under their severity, worst first, and omits empty groups", () => {
    const groups = groupFindingsBySeverity([
      finding({ severity: "low" }),
      finding({ severity: "critical" }),
      finding({ severity: "low" }),
    ]);
    expect(groups.map((g) => `${g.severity}:${g.findings.length}`)).toEqual(["critical:1", "low:2"]);
  });

  it("every non-empty group carries its actual findings, not just a count", () => {
    const groups = groupFindingsBySeverity([finding({ severity: "medium", title: "Unawaited promise" })]);
    expect(groups[0].findings[0].title).toBe("Unawaited promise");
  });

  it("counts are derived from findings", () => {
    const counts = severityCounts([finding({ severity: "critical" }), finding({ severity: "medium" }), finding({ severity: "medium" })]);
    expect(counts).toEqual([{ severity: "critical", count: 1 }, { severity: "medium", count: 2 }]);
  });

  it("shows only findings this round's diff actually covered", () => {
    const doc = review({
      findings: [finding({ file: "src/touched.ts" }), finding({ file: "src/carried-forward.ts" })],
      touchedFiles: ["src/touched.ts"],
    });
    expect(visibleFindings(doc).map((f) => f.file)).toEqual(["src/touched.ts"]);
  });
});

describe("review progress", () => {
  it("does not regress between a phase finishing and the next starting", () => {
    // Found by this repo's own reviewer on PR #90 and confirmed by both
    // reviewers: phase1_completed and phase2_completed are persisted stages
    // that fell outside the sequence, so the step collapsed to zero and the
    // bar visibly emptied itself mid-review before refilling.
    expect(stageProgress("phase1_completed").step).toBe(stageProgress("phase1_running").step);
    expect(stageProgress("phase2_completed").step).toBe(stageProgress("phase2_running").step);
    expect(stageProgress("phase1_completed").step).toBeGreaterThan(0);
  });

  it("places a running review in the sequence", () => {
    expect(stageProgress("phase2_running")).toEqual({ step: 3, total: 7 });
    expect(stageProgress("context_building").step).toBe(1);
  });

  it("shows progress only while the review is genuinely mid-flight", () => {
    expect(showsProgress(review({ status: "pending", stage: "debate_running" }))).toBe(true);
    expect(showsProgress(review({ status: "completed", stage: "completed" }))).toBe(false);
    expect(showsProgress(review({ status: "failed", stage: "failed" }))).toBe(false);
    expect(showsProgress(review({ status: "pending" }))).toBe(false);
  });
});

describe("current versus suggested code", () => {
  it("renders a committable diff only when both halves are present", () => {
    expect(rendersAsSuggestionDiff(finding({ suggestion: "if (!x) return;", originalLine: "  doThing();" }))).toBe(true);
  });

  it("falls back to read-only text without the original line", () => {
    // GitHub applies a suggestion verbatim; pairing it with the wrong "before"
    // is how someone commits something that was never proposed.
    expect(rendersAsSuggestionDiff(finding({ suggestion: "if (!x) return;" }))).toBe(false);
  });

  it("is false when there is no suggestion at all", () => {
    expect(rendersAsSuggestionDiff(finding({ originalLine: "  doThing();" }))).toBe(false);
  });
});
