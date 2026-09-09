import { describe, expect, it } from "vitest";
import { MATCH_THRESHOLD, mergeFindings, reconcile, similarity } from "@/lib/review/reconciliation";
import { isPresentable, validateLocation } from "@/lib/review/location-validation";
import { toFindingDoc, type CandidateFinding, type TrackedFinding, type VerificationVerdict } from "@/lib/review/stage-types";
import { primaryResultSchema } from "@/lib/ai/primary-review";
import { secondaryResultSchema } from "@/lib/ai/secondary-review";
import { arbitrationResultSchema } from "@/lib/review/arbitration";
import type { PullRequestFile } from "@/lib/github/diff";

/**
 * The mock cases from the specification, plus the parsing and location checks
 * they depend on.
 *
 * These are all deterministic: reconciliation, validation and the schemas are
 * pure, so the interesting behaviour — what happens when the two reviewers
 * disagree, what happens when a cited line does not exist — is testable
 * without a provider. The stages that do call a model are covered by their
 * schemas here and exercised for real by the manual benchmark.
 */

function candidate(over: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    id: "F001",
    severity: "high",
    category: "bug",
    title: "Off-by-one loop condition reads past the end of the array",
    file: "src/app.ts",
    startLine: 10,
    endLine: 12,
    problem: "The loop condition uses <= against length.",
    whyItIsABug: "The final iteration indexes one past the end and dereferences undefined.",
    evidence: [],
    relatedFiles: [],
    confidence: 0.9,
    source: "ultra",
    ...over,
  };
}

function verdict(over: Partial<VerificationVerdict> = {}): VerificationVerdict {
  return {
    findingId: "F001",
    decision: "confirm",
    confidence: 0.9,
    fileValid: true,
    lineValid: true,
    reason: "Confirmed against the loop body.",
    evidence: [],
    ...over,
  };
}

describe("reconciliation — agreement and disagreement", () => {
  it("TEST A: both reviewers confirm, so the finding is agreed and needs no debate", () => {
    const result = reconcile([candidate()], [verdict()], []);
    expect(result.tracked).toHaveLength(1);
    expect(result.tracked[0].status).toBe("agreed");
    expect(result.disputedCount).toBe(0);
  });

  it("TEST B: confirm against reject becomes disputed rather than picking a winner", () => {
    // A flat reject from one reviewer is a correctness claim, not a dedup
    // decision — it goes to debate like any other disagreement instead of
    // dropping the finding on one reviewer's word alone.
    const result = reconcile([candidate()], [verdict({ decision: "reject", reason: "Guarded upstream." })], []);
    expect(result.rejected).toHaveLength(0);
    expect(result.tracked).toHaveLength(1);
    expect(result.tracked[0].status).toBe("disputed");
    expect(result.disputedCount).toBe(1);
  });

  it("TEST B': a modify verdict is material disagreement and goes to debate", () => {
    const result = reconcile([candidate()], [verdict({ decision: "modify", severity: "low" })], []);
    expect(result.tracked[0].status).toBe("disputed");
    expect(result.disputedCount).toBe(1);
  });

  it("TEST C: a two-step severity gap is disputed; one step is not worth arguing about", () => {
    const twoSteps = reconcile([candidate({ severity: "critical" })], [verdict({ severity: "medium" })], []);
    expect(twoSteps.tracked[0].status).toBe("disputed");

    const oneStep = reconcile([candidate({ severity: "high" })], [verdict({ severity: "medium" })], []);
    expect(oneStep.tracked[0].status).toBe("agreed");
  });

  it("an uncertain verdict is disputed, never quietly confirmed", () => {
    const result = reconcile([candidate()], [verdict({ decision: "uncertain" })], []);
    expect(result.tracked[0].status).toBe("disputed");
  });

  it("silence from the verifier is not agreement", () => {
    // A finding nobody returned a verdict on must not inherit "confirmed" by
    // default — that is how an unverified claim reaches a reader wearing a
    // verified badge.
    const result = reconcile([candidate()], [], []);
    expect(result.tracked[0].status).toBe("disputed");
    expect(result.tracked[0].super).toBeUndefined();
  });

  it("a verdict on an id that was never submitted cannot affect anything", () => {
    const result = reconcile([candidate()], [verdict({ findingId: "GHOST" })], []);
    expect(result.tracked[0].status).toBe("disputed");
  });
});

describe("reconciliation — the verifier's own discoveries", () => {
  it("TEST H: keeps confirmed findings and adds what only the second reviewer saw", () => {
    const primary = [candidate({ id: "F001" }), candidate({ id: "F002", startLine: 50, endLine: 52 }), candidate({ id: "F003", file: "src/other.ts", startLine: 5, endLine: 6 })];
    const verdicts = [
      verdict({ findingId: "F001", decision: "confirm" }),
      verdict({ findingId: "F002", decision: "confirm" }),
      verdict({ findingId: "F003", decision: "reject" }),
    ];
    const discoveries = [
      candidate({ id: "S001", file: "src/new.ts", startLine: 3, endLine: 4, title: "Unawaited promise", source: "super" }),
      candidate({ id: "S002", file: "src/new.ts", startLine: 80, endLine: 81, title: "Missing null guard", source: "super" }),
    ];

    const result = reconcile(primary, verdicts, discoveries);
    // F003's reject goes to debate rather than the rejected pile.
    expect(result.rejected).toHaveLength(0);
    expect(result.tracked).toHaveLength(5);
    expect(result.tracked.find((t) => t.candidate.id === "F003")?.status).toBe("disputed");
    expect(result.tracked.filter((t) => t.candidate.source === "super")).toHaveLength(2);
  });

  it("a discovery on a finding already in play is the same defect seen twice", () => {
    const primary = [candidate({ id: "F001", title: "Missing authorization check" })];
    const discovery = candidate({
      id: "S001",
      title: "Ownership is not enforced before the update",
      problem: "The handler updates the record without checking the caller owns it.",
      source: "super",
      severity: "critical",
    });

    const result = reconcile(primary, [verdict()], [discovery]);
    expect(result.tracked).toHaveLength(1);
    expect(result.tracked[0].candidate.source).toBe("both");
    // The merge keeps the worse severity, not the first one seen.
    expect(result.tracked[0].candidate.severity).toBe("critical");
  });

  it("a discovery only the second reviewer made starts as a candidate, not as agreed", () => {
    const result = reconcile([], [], [candidate({ id: "S001", source: "super" })]);
    expect(result.tracked[0].status).toBe("candidate");
  });
});

describe("similarity and merging", () => {
  it("matches two descriptions of one defect that share no wording", () => {
    const a = candidate({ title: "Missing authorization check", problem: "No ownership check before update." });
    const b = candidate({ id: "S001", title: "Ownership is not enforced", problem: "The record is written without verifying the caller." });
    expect(similarity(a, b)).toBeGreaterThan(MATCH_THRESHOLD);
  });

  it("does not match findings in different files however similar the words", () => {
    const a = candidate({ file: "src/a.ts" });
    const b = candidate({ file: "src/b.ts" });
    expect(similarity(a, b)).toBe(0);
  });

  it("does not match distant findings in the same file", () => {
    const a = candidate({ startLine: 10, endLine: 11, title: "Null dereference", problem: "x is undefined" });
    const b = candidate({ startLine: 900, endLine: 901, title: "Race condition", problem: "two writers" });
    expect(similarity(a, b)).toBeLessThan(MATCH_THRESHOLD);
  });

  it("keeps the best half of each report rather than picking a winner", () => {
    const a = candidate({ startLine: 10, endLine: 12, severity: "medium", evidence: [{ file: "src/app.ts", line: 10, quote: "for (;;)" }] });
    const b = candidate({
      startLine: 8, endLine: 20, severity: "critical", suggestedFix: "use < instead of <=",
      whyItIsABug: "A much fuller account of why the dereference throws at runtime.",
      evidence: [{ file: "src/app.ts", line: 11, quote: "arr[i].name" }],
    });
    const merged = mergeFindings(a, b);
    expect(merged.severity).toBe("critical");
    expect(merged.startLine).toBe(8);
    expect(merged.endLine).toBe(20);
    expect(merged.evidence).toHaveLength(2);
    expect(merged.suggestedFix).toBe("use < instead of <=");
    expect(merged.source).toBe("both");
  });
});

describe("deterministic location validation", () => {
  const source = ["const a = 1;", "const b = 2;", "for (let i = 0; i <= xs.length; i++) {", "  use(xs[i]);", "}"].join("\n");
  const files = [{ filename: "src/app.ts", status: "modified", patch: "@@ -1,5 +1,5 @@" }] as unknown as PullRequestFile[];
  const input = { sources: new Map([["src/app.ts", source]]), files, commitSha: "abc123" };

  it("TEST I: a finding in a file that does not exist is not presentable", () => {
    const result = validateLocation({ candidate: candidate({ file: "src/ghost.ts" }), status: "confirmed" }, input);
    expect(result.validation?.fileValid).toBe(false);
    expect(isPresentable(result)).toBe(false);
  });

  it("TEST J: corrects a wrong line only when exactly one nearby line matches the quote", () => {
    const tracked: TrackedFinding = {
      candidate: candidate({ startLine: 1, endLine: 1, evidence: [{ file: "src/app.ts", line: 1, quote: "for (let i = 0; i <= xs.length; i++) {" }] }),
      status: "confirmed",
    };
    const result = validateLocation(tracked, input);
    expect(result.candidate.startLine).toBe(3);
    expect(result.validation?.correctedFrom).toBe(1);
    expect(result.validation?.snippetValid).toBe(true);
  });

  it("leaves the location alone when the quote matches nothing — never guesses", () => {
    const tracked: TrackedFinding = {
      candidate: candidate({ startLine: 2, endLine: 2, evidence: [{ file: "src/app.ts", line: 2, quote: "someFunctionThatIsNotThere()" }] }),
      status: "confirmed",
    };
    const result = validateLocation(tracked, input);
    expect(result.validation?.snippetValid).toBe(false);
    expect(result.validation?.correctedFrom).toBeUndefined();
    expect(result.candidate.startLine).toBe(2);
  });

  it("drops evidence that does not match the source it claims to quote", () => {
    const tracked: TrackedFinding = {
      candidate: candidate({ startLine: 3, endLine: 3, evidence: [
        { file: "src/app.ts", line: 3, quote: "for (let i = 0; i <= xs.length; i++) {" },
        { file: "src/app.ts", line: 2, quote: "this line is invented" },
      ] }),
      status: "confirmed",
    };
    const result = validateLocation(tracked, input);
    expect(result.candidate.evidence).toHaveLength(1);
  });

  it("marks a line beyond the end of the file invalid", () => {
    const result = validateLocation({ candidate: candidate({ startLine: 900, endLine: 901 }), status: "confirmed" }, input);
    expect(result.validation?.lineValid).toBe(false);
    expect(isPresentable(result)).toBe(false);
  });

  it("a finding about a file this pull request never touched is not relevant to it", () => {
    const withOther = { ...input, sources: new Map([...input.sources, ["src/untouched.ts", "x"]]) };
    const result = validateLocation({ candidate: candidate({ file: "src/untouched.ts", startLine: 1, endLine: 1 }), status: "confirmed" }, withOther);
    expect(result.validation?.relevantToPR).toBe(false);
    expect(isPresentable(result)).toBe(false);
  });
});

describe("final finding shape", () => {
  it("TEST E: an arbitration confirmation becomes a reportable defect", () => {
    const doc = toFindingDoc(
      {
        candidate: candidate(),
        status: "confirmed",
        ultra: { decision: "confirm", confidence: 0.9 },
        super: { decision: "reject", confidence: 0.8 },
        debate: { used: true, rounds: 2, consensusReached: false, turns: [] },
        arbitration: { used: true, decision: "confirmed", confidence: 0.85, reason: "The guard runs after the dereference." },
      },
      "abc123",
    );
    expect(doc.verification?.status).toBe("accepted");
    expect(doc.stage?.status).toBe("confirmed");
    expect(doc.stage?.arbitration?.decision).toBe("confirmed");
    expect(doc.commitSha).toBe("abc123");
    // The single `line` every existing consumer reads still anchors the range.
    expect(doc.line).toBe(doc.startLine);
  });

  it("TEST G: an uncertain arbitration is never rendered as an accepted defect", () => {
    const doc = toFindingDoc(
      { candidate: candidate(), status: "uncertain", arbitration: { used: true, decision: "uncertain", confidence: 0.2, reason: "Evidence is inconclusive." } },
      "abc123",
    );
    expect(doc.stage?.status).toBe("uncertain");
    expect(doc.verification?.status).toBe("skipped");
    expect(doc.verification?.status).not.toBe("accepted");
  });

  it("says how a finding was settled without quoting any model reasoning", () => {
    const doc = toFindingDoc(
      { candidate: candidate(), status: "confirmed", ultra: { decision: "confirm", confidence: 0.9 }, super: { decision: "confirm", confidence: 0.9 } },
      "abc123",
    );
    expect(doc.verification?.reason).toBe("Verified by two-stage review.");
  });
});

describe("stage output parsing", () => {
  it("rejects a primary finding missing the fields a reader needs", () => {
    expect(() => primaryResultSchema.parse({ findings: [{ id: "F001", severity: "high" }] })).toThrow();
  });

  it("accepts an empty findings array, which is a real answer", () => {
    expect(primaryResultSchema.parse({ findings: [] }).findings).toEqual([]);
  });

  it("rejects a severity the application cannot store", () => {
    expect(() => primaryResultSchema.parse({ findings: [{ ...candidate(), severity: "blocker" }] })).toThrow();
  });

  it("defaults the verifier's two lists rather than failing when one is absent", () => {
    const parsed = secondaryResultSchema.parse({});
    expect(parsed.verifications).toEqual([]);
    expect(parsed.newFindings).toEqual([]);
  });

  it("rejects an arbitration verdict outside the allowed decisions", () => {
    expect(() =>
      arbitrationResultSchema.parse({ verdicts: [{ findingId: "F001", decision: "probably", severity: "high", confidence: 0.5, reason: "x" }] }),
    ).toThrow();
  });

  it("parses a full arbitration verdict", () => {
    const parsed = arbitrationResultSchema.parse({
      verdicts: [{ findingId: "F001", decision: "uncertain", severity: "medium", confidence: 0.4, reason: "Cannot establish the path." }],
    });
    expect(parsed.verdicts[0].decision).toBe("uncertain");
  });
});
