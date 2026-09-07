import type { FindingDoc } from "@/lib/db/collections";
import { explanationParagraphs } from "@/lib/review/finding-prose";

/**
 * The contract every stage of the multi-stage review passes along.
 *
 * The rule this file exists to enforce is the one in the spec that is easiest
 * to violate by accident: at no point may a complete finding be reduced to a
 * count and then reconstructed. Counts are derived from findings at the very
 * end and never flow backwards. So each stage takes finding objects and
 * returns finding objects with strictly more known about them — a verdict, a
 * debate position, an arbitration, a validation result — and nothing is ever
 * summarised in between.
 *
 * Severity stays lowercase throughout, matching the values the rest of the
 * application already stores and renders. The prompts speak in uppercase
 * because that is how the models are addressed; the boundary is converted in
 * one place per stage rather than the storage format being changed.
 */

export type Severity = FindingDoc["severity"];
export type Category = FindingDoc["category"];

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

/** Which reviewer produced a finding. `both` is set by reconciliation on a merge. */
export type FindingSource = "ultra" | "super" | "both" | "static-analysis";

/**
 * Where a finding is in its lifecycle.
 *
 * `candidate` is anything a reviewer proposed. Everything else is a
 * conclusion something reached about it, and only `confirmed` may be
 * presented to a reader as a defect.
 */
export type FindingStatus =
  | "candidate"
  | "agreed"
  | "disputed"
  | "confirmed"
  | "rejected"
  | "modified"
  | "uncertain";

/** A reviewer's verdict on someone else's finding. */
export type VerificationDecision = "confirm" | "reject" | "modify" | "duplicate" | "uncertain";

/** A reviewer's stance once it has been challenged. */
export type DebatePosition = "confirm" | "modify" | "withdraw" | "maintain_rejection";

export type ArbitrationDecision = "confirmed" | "rejected" | "modified" | "uncertain";

/** A quoted line the reviewer offered in support. Validated against real source before it counts. */
export interface Evidence {
  file: string;
  line: number;
  quote: string;
}

/**
 * A finding as proposed, before anyone has checked it.
 *
 * `startLine`/`endLine` are a range because a defect is frequently a
 * relationship between lines — a loop header and the dereference inside it —
 * and collapsing that to a single number loses the half that explains it. The
 * existing single `line` is still derived from `startLine` when the finding is
 * stored, so every consumer that predates this keeps working.
 */
export interface CandidateFinding {
  id: string;
  severity: Severity;
  category: Category;
  title: string;
  file: string;
  startLine: number;
  endLine: number;
  /** Verbatim from the repository at the review's commit. Never model-authored. */
  codeSnippet?: string;
  problem: string;
  whyItIsABug: string;
  triggerScenario?: string;
  evidence: Evidence[];
  relatedFiles: string[];
  suggestedFix?: string;
  /** The reviewer's own confidence. Never converted into severity — see spec §29. */
  confidence: number;
  source: FindingSource;
}

export interface VerificationVerdict {
  findingId: string;
  decision: VerificationDecision;
  severity?: Severity;
  confidence: number;
  fileValid: boolean;
  lineValid: boolean;
  reason: string;
  evidence: Evidence[];
  suggestedChange?: string;
}

export interface DebateTurn {
  findingId: string;
  position: DebatePosition;
  severity?: Severity;
  reason: string;
  evidence: Evidence[];
}

export interface ArbitrationVerdict {
  findingId: string;
  decision: ArbitrationDecision;
  severity: Severity;
  confidence: number;
  reason: string;
  evidence: Evidence[];
  finalTitle?: string;
  finalExplanation?: string;
  finalSuggestion?: string;
}

/** Deterministic checks. The model has no authority over any of these. */
export interface LocationValidation {
  fileValid: boolean;
  lineValid: boolean;
  snippetValid: boolean;
  commitValid: boolean;
  relevantToPR: boolean;
  /** Set when a cited line was unambiguously corrected to a nearby real one. */
  correctedFrom?: number;
}

/** Everything the pipeline concluded about one finding, carried whole to the end. */
export interface TrackedFinding {
  candidate: CandidateFinding;
  status: FindingStatus;
  ultra?: { decision: VerificationDecision; confidence: number };
  super?: { decision: VerificationDecision; confidence: number };
  debate?: { used: boolean; rounds: number; consensusReached: boolean; turns: DebateTurn[] };
  arbitration?: { used: boolean; decision: ArbitrationDecision; confidence: number; reason: string };
  validation?: LocationValidation;
}

/**
 * Stage a review has reached, surfaced so the UI can say something truer than
 * "pending" for the several minutes this pipeline can take.
 *
 * Deliberately a separate field from `ReviewDoc.status`: that one is the
 * durable pending/completed/failed the queue and the unique index depend on,
 * and widening it would change the meaning of every historical row.
 */
export type ReviewStage =
  | "pending"
  | "context_building"
  | "phase1_running"
  | "phase1_completed"
  | "phase2_running"
  | "phase2_completed"
  | "reconciling"
  | "debate_running"
  | "arbitration_running"
  | "validating"
  | "completed"
  | "failed";

/**
 * What each stage is called on screen.
 *
 * Plainly and accurately, in that order. "Analyzing repository" was neither:
 * the stage reads the pull request's changed files plus one hop of their
 * imports and callers, and calling that "the repository" tells a waiting
 * reader the tool is doing something far larger and slower than it is. Every
 * label now names the thing actually happening, in words someone who has not
 * read this code would use.
 */
export const STAGE_LABEL: Record<ReviewStage, string> = {
  pending: "Queued",
  context_building: "Reading the changed files",
  phase1_running: "First reviewer reading the code",
  phase1_completed: "First review done",
  phase2_running: "Second reviewer checking independently",
  phase2_completed: "Second review done",
  reconciling: "Matching up what they found",
  debate_running: "Working through disagreements",
  arbitration_running: "Settling the last disagreements",
  validating: "Checking each finding against the code",
  completed: "Done",
  failed: "Failed",
};

/** Raised when a stage cannot produce a usable result. Never becomes "no findings". */
export class ReviewStageError extends Error {
  constructor(readonly stage: ReviewStage, message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ReviewStageError";
  }
}

/**
 * Converts a tracked finding into the shape the rest of the application
 * already stores and renders.
 *
 * `line` is `startLine` so every existing consumer — inline comment mapping,
 * the dashboard, the reply pipeline — keeps working untouched. The range and
 * the stage record ride alongside as new optional fields, which is what keeps
 * historical reviews rendering correctly.
 */
export function toFindingDoc(tracked: TrackedFinding, commitSha: string): FindingDoc {
  const { candidate } = tracked;
  // Trimmed to a sentence budget, not merely capped by the schema: the cap
  // stops an essay, this is what decides whether a person reads it. Joined
  // with blank lines and rendered as separate paragraphs — joining without
  // that is how three tidy paragraphs became one unbroken wall.
  const explanation = explanationParagraphs(candidate).join("\n\n");
  return {
    id: candidate.id,
    severity: candidate.severity,
    category: candidate.category,
    file: candidate.file,
    line: candidate.startLine,
    title: candidate.title,
    explanation,
    ...(candidate.suggestedFix ? { suggestion: candidate.suggestedFix } : {}),
    ...(candidate.confidence ? { confidence: String(candidate.confidence) } : {}),
    source: candidate.source === "static-analysis" ? "static-analysis" : "ai",
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    commitSha,
    findingSource: candidate.source,
    stage: {
      status: tracked.status,
      ...(tracked.ultra ? { ultra: tracked.ultra } : {}),
      ...(tracked.super ? { super: tracked.super } : {}),
      ...(tracked.debate ? { debate: { used: tracked.debate.used, rounds: tracked.debate.rounds, consensusReached: tracked.debate.consensusReached } } : {}),
      ...(tracked.arbitration ? { arbitration: tracked.arbitration } : {}),
      ...(tracked.validation ? { validation: tracked.validation } : {}),
    },
    verification: {
      status: tracked.status === "confirmed" ? "accepted" : tracked.status === "rejected" ? "rejected" : tracked.status === "uncertain" ? "skipped" : "downgraded",
      reason: verificationReason(tracked),
      evidence: candidate.evidence,
    },
  };
}

/** A one-line account of how a finding reached its status, with no chain-of-thought in it. */
function verificationReason(tracked: TrackedFinding): string {
  if (tracked.arbitration?.used) return `Resolved after reviewer disagreement: ${tracked.arbitration.reason}`;
  if (tracked.debate?.used) return tracked.debate.consensusReached
    ? "Both reviewers agreed after examining the disputed evidence."
    : "Reviewers disagreed; resolved by independent adjudication.";
  if (tracked.ultra && tracked.super) return "Verified by two-stage review.";
  return "Proposed by a single reviewer.";
}
