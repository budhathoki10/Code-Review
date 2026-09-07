import type { FindingDoc, ReviewDoc } from "@/lib/db/collections";
import { SEVERITY_ORDER } from "@/lib/ui";
import type { ReviewStage } from "@/lib/review/stage-types";

/**
 * The decisions the review card makes, pulled out of the JSX so they can be
 * tested.
 *
 * The project has no React testing library and adding one for this would be a
 * new dependency in a change that is meant to be incremental. But the parts
 * worth testing were never the markup — they are "does this link point at the
 * right lines", "does this review get to say it found nothing", "what does
 * the verification trail claim". Those are pure functions, and they are the
 * ones that have actually been wrong.
 */

/**
 * A GitHub blob URL for a finding's exact lines, or undefined when we cannot
 * build a real one.
 *
 * Every part comes from data we hold: the repository we were told about, the
 * commit the review ran against, and a path and line that survived
 * deterministic validation. If any is missing the caller renders plain text —
 * a link to the wrong line is worse than no link, because it looks
 * authoritative and a reader who follows it blames the code they land on.
 */
export function findingSourceUrl(finding: FindingDoc, repoFullName?: string): string | undefined {
  if (!repoFullName || !finding.commitSha || !finding.file) return undefined;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repoFullName)) return undefined;
  const range = finding.startLine && finding.endLine && finding.endLine > finding.startLine
    ? `#L${finding.startLine}-L${finding.endLine}`
    : finding.line
      ? `#L${finding.line}`
      : "";
  return `https://github.com/${repoFullName}/blob/${finding.commitSha}/${finding.file}${range}`;
}

/**
 * How a finding was settled, as a few words.
 *
 * Never includes a model's reasoning. What a reader needs is whether two
 * reviewers looked at this and whether they had to be reconciled; publishing
 * the argument itself invites them to relitigate a decision the pipeline
 * already made on evidence, and exposes chain-of-thought the spec forbids
 * showing.
 */
export function verificationTrail(stage: FindingDoc["stage"]): string[] {
  if (!stage) return [];
  const parts: string[] = [];
  if (stage.ultra && stage.super) parts.push("Verified by two reviewers");
  else if (stage.ultra) parts.push("Primary review");
  else if (stage.super) parts.push("Found by the verifier");
  if (stage.debate?.used) {
    parts.push(
      stage.debate.consensusReached
        ? `Agreed after ${stage.debate.rounds} round${stage.debate.rounds === 1 ? "" : "s"} of review`
        : "Reviewers disagreed",
    );
  }
  if (stage.arbitration?.used) parts.push("Resolved by independent adjudication");
  if (stage.validation?.correctedFrom !== undefined) parts.push("Line corrected against source");
  return parts;
}

/**
 * Whether the card may say the review found nothing.
 *
 * Only a review that actually finished, with nothing confirmed and nothing
 * left unresolved, has earned that sentence. A failure, a review still
 * running, or one holding findings it could not establish are three different
 * states and none of them is "your code is clean" — which is the claim this
 * guard exists to stop the UI making on their behalf.
 */
export function canSayNoFindings(review: Pick<ReviewDoc, "status" | "findings" | "unresolvedFindings">): boolean {
  if (review.status !== "completed") return false;
  if (review.findings.length > 0) return false;
  return !review.unresolvedFindings?.length;
}

/** Counts per severity, derived from findings — never the other way round. */
export function severityCounts(findings: FindingDoc[]): { severity: FindingDoc["severity"]; count: number }[] {
  // ui.ts orders worst-first already. review/pipeline.ts has a same-named
  // constant ordered the other way, which is exactly the sort of collision
  // that reverses a list without anyone noticing until it is on screen.
  return SEVERITY_ORDER
    .map((severity) => ({ severity, count: findings.filter((f) => f.severity === severity).length }))
    .filter((entry) => entry.count > 0);
}

/** The stages a reader sees progress through. Terminal states are not steps. */
export const STAGE_SEQUENCE: ReviewStage[] = [
  "context_building",
  "phase1_running",
  "phase2_running",
  "reconciling",
  "debate_running",
  "arbitration_running",
  "validating",
];

/** Position of a running review in that sequence, 1-based; 0 when it is not a running stage. */
export function stageProgress(stage: ReviewStage | undefined): { step: number; total: number } {
  const total = STAGE_SEQUENCE.length;
  if (!stage) return { step: 0, total };
  const index = STAGE_SEQUENCE.indexOf(stage);
  return { step: index < 0 ? 0 : index + 1, total };
}

/** Whether progress should be shown at all: only while the review is genuinely mid-flight. */
export function showsProgress(review: Pick<ReviewDoc, "status" | "stage">): boolean {
  return review.status === "pending" && Boolean(review.stage) && review.stage !== "completed" && review.stage !== "failed";
}

/**
 * Whether a finding can render as a committable before/after block.
 *
 * Both halves must be present: the replacement, and the line it replaces. A
 * suggestion with no original renders as read-only text instead, because
 * GitHub applies a suggestion verbatim and pairing one with the wrong "before"
 * is how a reader commits something that was never proposed.
 */
export function rendersAsSuggestionDiff(finding: FindingDoc): boolean {
  return Boolean(finding.suggestion) && finding.originalLine !== undefined && finding.line !== undefined;
}
