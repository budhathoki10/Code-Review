import { describe, expect, it } from "vitest";
import {
  MAX_PROMPT_EXAMPLES,
  renderRejectionExamples,
  suppressLearnedRejections,
  SUPPRESSION_THRESHOLD,
} from "@/lib/review/learned-rejections";
import type { CandidateFinding } from "@/lib/review/stage-types";
import type { FindingFeedbackDoc } from "@/lib/db/collections";

/**
 * Suppression withholds output, so these tests are weighted towards what it
 * must NOT do.
 *
 * Dropping a finding because a maintainer rejected one like it is the only
 * place in this pipeline where a human's past click can hide a present
 * defect. Getting it slightly too eager is not a cosmetic bug — it is the
 * tool going quiet about something real, in a way nobody would notice,
 * because a suppressed finding looks exactly like a clean review.
 */

function finding(over: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    id: "f1",
    severity: "medium",
    category: "bug",
    title: "Loop reads one past the end of the array",
    file: "src/a.ts",
    startLine: 10,
    endLine: 12,
    problem: "The condition uses <= so the last iteration indexes past the end.",
    whyItIsABug: "It dereferences undefined and throws.",
    evidence: [],
    relatedFiles: [],
    confidence: 0.9,
    source: "ultra",
    ...over,
  };
}

function rejection(over: Partial<FindingFeedbackDoc> = {}): FindingFeedbackDoc {
  return {
    repositoryId: "r1",
    reviewId: "rev1",
    findingId: "old1",
    file: "src/a.ts",
    startLine: 10,
    endLine: 12,
    category: "bug",
    severity: "medium",
    title: "Loop reads one past the end of the array",
    explanation: "The condition uses <= so the last iteration indexes past the end.",
    label: "false-positive",
    userId: "u1",
    at: new Date(),
    ...over,
  };
}

describe("dropping what a maintainer already rejected", () => {
  it("drops the same finding reported again", () => {
    const result = suppressLearnedRejections([finding()], [rejection()]);
    expect(result.kept).toEqual([]);
    expect(result.suppressed).toHaveLength(1);
  });

  it("says which judgement dropped it, so the decision can be explained", () => {
    const because = rejection({ title: "Loop reads one past the end of the array" });
    const result = suppressLearnedRejections([finding()], [because]);
    expect(result.suppressed[0].because.findingId).toBe("old1");
    expect(result.suppressed[0].finding.id).toBe("f1");
  });

  it("keeps everything when nothing has been rejected", () => {
    const findings = [finding(), finding({ id: "f2", file: "src/b.ts" })];
    const result = suppressLearnedRejections(findings, []);
    expect(result.kept).toEqual(findings);
    expect(result.suppressed).toEqual([]);
  });
});

describe("what suppression must not do", () => {
  it("does not drop a different defect at the same lines", () => {
    // Same file, same lines, unrelated problem. Location alone is not
    // identity — the whole point of reviewing a file twice is that it can
    // have two bugs in it.
    const other = finding({
      id: "f2",
      title: "Missing await on the database write",
      problem: "The promise is never awaited so the handler returns before the write lands.",
      whyItIsABug: "The response reports success for a write that may still fail.",
    });
    expect(suppressLearnedRejections([other], [rejection()]).kept).toHaveLength(1);
  });

  it("does not drop the same wording in a different file", () => {
    const elsewhere = finding({ id: "f2", file: "src/z.ts" });
    expect(suppressLearnedRejections([elsewhere], [rejection()]).kept).toHaveLength(1);
  });

  it("does not drop the same wording far away in the same file", () => {
    const faraway = finding({ id: "f2", startLine: 600, endLine: 602 });
    expect(suppressLearnedRejections([faraway], [rejection()]).kept).toHaveLength(1);
  });

  it("requires a closer match than merging two reviewers' wording does", () => {
    // Reconciliation merges at 0.6. Withholding a finding is a costlier
    // mistake than merging one, so this bar sits well above it.
    expect(SUPPRESSION_THRESHOLD).toBeGreaterThan(0.6);
  });

  it("leaves untouched findings in their original order", () => {
    const findings = [
      finding({ id: "a", file: "src/x.ts" }),
      finding({ id: "b" }),
      finding({ id: "c", file: "src/y.ts" }),
    ];
    const result = suppressLearnedRejections(findings, [rejection()]);
    expect(result.kept.map((f) => f.id)).toEqual(["a", "c"]);
  });
});

describe("showing the repository's judgement to the verifier", () => {
  it("renders nothing when there is nothing to show", () => {
    expect(renderRejectionExamples([])).toBe("");
  });

  it("names the file and title of each rejection", () => {
    const text = renderRejectionExamples([rejection()]);
    expect(text).toContain("src/a.ts");
    expect(text).toContain("Loop reads one past the end");
  });

  it("caps the list so examples do not become a wall", () => {
    const many = Array.from({ length: 40 }, (_, i) => rejection({ findingId: `old${i}`, title: `Rejected ${i}` }));
    const text = renderRejectionExamples(many);
    expect(text).toContain("Rejected 0");
    expect(text).not.toContain(`Rejected ${MAX_PROMPT_EXAMPLES}`);
  });

  it("tells the reviewer not to generalise them into silence", () => {
    // The failure mode of teaching a reviewer what not to report is that it
    // learns to report nothing, and silence reads exactly like clean code.
    const text = renderRejectionExamples([rejection()]);
    expect(text.toLowerCase()).toContain("still a real defect");
  });
});
