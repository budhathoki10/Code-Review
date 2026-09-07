import {
  SEVERITIES,
  type CandidateFinding,
  type TrackedFinding,
  type VerificationVerdict,
} from "@/lib/review/stage-types";

/**
 * Decides which findings are the same defect, and where the two reviewers
 * actually disagree.
 *
 * Matching on title is useless here. "Missing authorization check" and
 * "ownership is not enforced before the update" are the same defect described
 * by two models that share no vocabulary, and treating them as separate
 * reports the bug twice; meanwhile two genuinely different defects on the
 * same line often share a title. So the comparison is structural — same file,
 * overlapping or adjacent lines, same category — with wording used only as a
 * tie-breaker among candidates that already overlap.
 *
 * The other half of the job is deciding what counts as disagreement worth
 * arguing about. A one-step severity difference between adjacent levels is
 * not worth two debate rounds and an arbitration; confirm-versus-reject
 * always is.
 */

const OVERLAP_SLACK = 6;

/** Content words, so two descriptions of one defect can be compared without their phrasing. */
function terms(text: string): Set<string> {
  const stop = new Set([
    "the", "and", "for", "that", "this", "with", "from", "when", "will", "have", "has", "not", "but",
    "are", "was", "were", "can", "could", "would", "should", "into", "than", "then", "there", "which",
    "its", "it", "is", "of", "to", "in", "on", "a", "an", "be", "by", "or", "if", "as", "at",
  ]);
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9_\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !stop.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const term of a) if (b.has(term)) shared++;
  return shared / (a.size + b.size - shared);
}

function rangesOverlap(a: CandidateFinding, b: CandidateFinding): boolean {
  return a.startLine - OVERLAP_SLACK <= b.endLine && b.startLine - OVERLAP_SLACK <= a.endLine;
}

/**
 * How strongly two findings look like the same defect.
 *
 * Location dominates because it is the one signal neither model can express
 * differently: two reports of the same defect land on the same lines whatever
 * words they choose. Wording only separates candidates that already collide.
 */
export function similarity(a: CandidateFinding, b: CandidateFinding): number {
  if (a.file !== b.file) return 0;
  let score = 0;
  if (rangesOverlap(a, b)) score += 0.55;
  else if (Math.abs(a.startLine - b.startLine) <= 25) score += 0.2;
  if (a.category === b.category) score += 0.1;
  const text = (f: CandidateFinding) => terms(`${f.title} ${f.problem} ${f.whyItIsABug}`);
  score += 0.35 * jaccard(text(a), text(b));
  return score;
}

export const MATCH_THRESHOLD = 0.6;

/** Keeps the longer of two descriptions — the one that says more about the defect. */
function richer(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.length > a.length ? b : a;
}

function higherSeverity(a: CandidateFinding["severity"], b: CandidateFinding["severity"]): CandidateFinding["severity"] {
  return SEVERITIES.indexOf(a) <= SEVERITIES.indexOf(b) ? a : b;
}

/**
 * Fuses two reports of one defect, keeping the best of each rather than
 * picking a winner: the higher severity, the tighter location, the fuller
 * explanation, and the union of evidence.
 */
export function mergeFindings(primary: CandidateFinding, other: CandidateFinding): CandidateFinding {
  const evidence = [...primary.evidence];
  for (const e of other.evidence) {
    if (!evidence.some((x) => x.file === e.file && x.line === e.line && x.quote.trim() === e.quote.trim())) evidence.push(e);
  }
  return {
    ...primary,
    severity: higherSeverity(primary.severity, other.severity),
    title: primary.title.length >= other.title.length ? primary.title : other.title,
    startLine: Math.min(primary.startLine, other.startLine),
    endLine: Math.max(primary.endLine, other.endLine),
    codeSnippet: primary.codeSnippet ?? other.codeSnippet,
    problem: richer(primary.problem, other.problem)!,
    whyItIsABug: richer(primary.whyItIsABug, other.whyItIsABug)!,
    triggerScenario: richer(primary.triggerScenario, other.triggerScenario),
    evidence: evidence.slice(0, 8),
    relatedFiles: [...new Set([...primary.relatedFiles, ...other.relatedFiles])].slice(0, 12),
    suggestedFix: richer(primary.suggestedFix, other.suggestedFix),
    confidence: Math.max(primary.confidence, other.confidence),
    source: "both",
  };
}

/** Severity gaps of one step are noise; two or more is a real disagreement about impact. */
function severityDistance(a: CandidateFinding["severity"], b: CandidateFinding["severity"]): number {
  return Math.abs(SEVERITIES.indexOf(a) - SEVERITIES.indexOf(b));
}

export interface ReconciliationResult {
  /** Everything still in play, each carrying what both reviewers said about it. */
  tracked: TrackedFinding[];
  /** Findings both reviewers dismissed. Kept for the audit trail, never shown as defects. */
  rejected: TrackedFinding[];
  disputedCount: number;
}

/**
 * Folds the first reviewer's findings, the verifier's verdicts on them, and
 * the verifier's own discoveries into one list.
 *
 * A finding the verifier never returned a verdict on is not treated as
 * confirmed. It stays disputed and goes to debate: silence is not agreement,
 * and defaulting it to confirmed is how an unverified claim reaches a reader
 * wearing a verified badge.
 */
export function reconcile(
  primaryFindings: CandidateFinding[],
  verifications: VerificationVerdict[],
  newFindings: CandidateFinding[],
): ReconciliationResult {
  const verdictById = new Map(verifications.map((v) => [v.findingId, v]));
  const tracked: TrackedFinding[] = [];
  const rejected: TrackedFinding[] = [];

  for (const candidate of primaryFindings) {
    const verdict = verdictById.get(candidate.id);
    const ultra = { decision: "confirm" as const, confidence: candidate.confidence };

    if (!verdict) {
      tracked.push({ candidate, status: "disputed", ultra });
      continue;
    }

    const superRecord = { decision: verdict.decision, confidence: verdict.confidence };

    if (verdict.decision === "reject" || verdict.decision === "duplicate") {
      rejected.push({ candidate, status: "rejected", ultra, super: superRecord });
      continue;
    }

    if (verdict.decision === "confirm") {
      const disagreesOnSeverity = verdict.severity !== undefined && severityDistance(candidate.severity, verdict.severity) >= 2;
      const disagreesOnLocation = verdict.fileValid === false || verdict.lineValid === false;
      tracked.push({
        candidate,
        status: disagreesOnSeverity || disagreesOnLocation ? "disputed" : "agreed",
        ultra,
        super: superRecord,
      });
      continue;
    }

    // modify and uncertain are both material disagreement: one says the claim
    // is wrong in a way that matters, the other that it cannot be settled.
    tracked.push({
      candidate: verdict.decision === "modify" && verdict.severity
        ? { ...candidate, severity: verdict.severity }
        : candidate,
      status: "disputed",
      ultra,
      super: superRecord,
    });
  }

  // The verifier's own discoveries. One that lands on a finding already in
  // play is the same defect seen twice, not a new one — merge, and record
  // that both reviewers found it independently, which is the strongest
  // signal available short of a test.
  for (const discovery of newFindings) {
    let bestIndex = -1;
    let bestScore = MATCH_THRESHOLD;
    for (const [index, existing] of tracked.entries()) {
      const score = similarity(existing.candidate, discovery);
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    }
    if (bestIndex >= 0) {
      const existing = tracked[bestIndex];
      tracked[bestIndex] = {
        ...existing,
        candidate: mergeFindings(existing.candidate, discovery),
        status: existing.status === "disputed" ? "disputed" : "agreed",
        super: { decision: "confirm", confidence: Math.max(existing.super?.confidence ?? 0, discovery.confidence) },
      };
      continue;
    }
    // Only the verifier has seen it, so it is not agreed. It is a candidate
    // that must earn confirmation on its own evidence.
    tracked.push({ candidate: discovery, status: "candidate", super: { decision: "confirm", confidence: discovery.confidence } });
  }

  // Two reports of one defect can also arrive from the same reviewer.
  const deduped: TrackedFinding[] = [];
  for (const item of tracked) {
    const twin = deduped.findIndex((existing) => similarity(existing.candidate, item.candidate) > MATCH_THRESHOLD);
    if (twin >= 0) {
      deduped[twin] = { ...deduped[twin], candidate: mergeFindings(deduped[twin].candidate, item.candidate) };
      continue;
    }
    deduped.push(item);
  }

  return { tracked: deduped, rejected, disputedCount: deduped.filter((t) => t.status === "disputed").length };
}
