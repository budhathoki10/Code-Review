import type { FindingFeedbackDoc } from "@/lib/db/collections";
import { similarity } from "@/lib/review/reconciliation";
import type { CandidateFinding } from "@/lib/review/stage-types";

/**
 * What a maintainer already said is not a bug, applied to the next review.
 *
 * The rating buttons wrote to the database and nothing read them. That is a
 * worse state than having no buttons: a reader who clicks "false positive"
 * reasonably believes they have taught the tool something, and the next
 * review repeats the finding word for word. This is the read side.
 *
 * Two uses, and the order matters. The deterministic one comes first: a new
 * finding that is the same defect, in the same place, as one a maintainer
 * rejected is dropped before anything is presented. That needs no model and
 * cannot be talked out of by a confident reviewer. The prompt-side use is
 * second and weaker — the rejections are shown to the verifier as examples of
 * what this repository does not consider defects, which shapes judgement on
 * findings that are merely similar rather than the same.
 *
 * The threshold is deliberately stricter than reconciliation's. Merging two
 * reviewers' descriptions of one defect is cheap to get slightly wrong;
 * silently withholding a finding is not, because the cost lands on whoever
 * ships the bug. So a suppression requires a much closer match than a merge
 * does, and near-misses are left alone rather than guessed at.
 */

/**
 * How close a new finding must be to a rejected one before it is suppressed.
 *
 * `similarity` already returns 0 for a different file and weights location
 * above wording. 0.85 on top of that means: same file, overlapping lines,
 * same category, and substantially the same words. A finding that clears this
 * is not "like" the rejected one, it is the rejected one.
 */
export const SUPPRESSION_THRESHOLD = 0.85;

/** How many past rejections are shown to a reviewer. Beyond this they stop being examples and become a wall. */
export const MAX_PROMPT_EXAMPLES = 12;

/** The shape `similarity` needs, built from a stored rejection. */
function asCandidate(doc: FindingFeedbackDoc): CandidateFinding {
  return {
    id: doc.findingId,
    severity: doc.severity,
    category: doc.category,
    title: doc.title,
    file: doc.file,
    startLine: doc.startLine,
    endLine: doc.endLine,
    problem: doc.explanation,
    whyItIsABug: "",
    evidence: [],
    relatedFiles: [],
    confidence: 1,
    source: "ultra",
  };
}

export interface SuppressionResult {
  kept: CandidateFinding[];
  /** Dropped findings paired with the judgement that dropped them, so the decision is auditable. */
  suppressed: { finding: CandidateFinding; because: FindingFeedbackDoc }[];
}

/**
 * Removes findings a maintainer has already rejected in this repository.
 *
 * Runs on the findings as proposed, before verification, so a rejected
 * finding does not spend a debate round or an arbitration call before being
 * dropped. The pairing is returned rather than a count: a maintainer asking
 * "why didn't it report X" deserves an answer better than a number.
 */
export function suppressLearnedRejections(
  findings: CandidateFinding[],
  rejections: FindingFeedbackDoc[],
): SuppressionResult {
  if (rejections.length === 0) return { kept: findings, suppressed: [] };

  const known = rejections.map((doc) => ({ doc, candidate: asCandidate(doc) }));
  const kept: CandidateFinding[] = [];
  const suppressed: { finding: CandidateFinding; because: FindingFeedbackDoc }[] = [];

  for (const finding of findings) {
    let best: { doc: FindingFeedbackDoc; score: number } | undefined;
    for (const { doc, candidate } of known) {
      const score = similarity(finding, candidate);
      if (score >= SUPPRESSION_THRESHOLD && (!best || score > best.score)) best = { doc, score };
    }
    if (best) suppressed.push({ finding, because: best.doc });
    else kept.push(finding);
  }
  return { kept, suppressed };
}

/**
 * The rejections as a prompt block for the verifier.
 *
 * Phrased as this repository's judgement, not as a rule, because it is the
 * former: a maintainer decided these were not defects *here*, which is local
 * knowledge a reviewer reading the diff cannot derive. It is explicitly not a
 * licence to stay quiet — a reviewer that treats every past rejection as a
 * ban on a whole category of defect would learn its way into silence, and
 * silence is indistinguishable from clean code.
 */
export function renderRejectionExamples(rejections: FindingFeedbackDoc[]): string {
  if (rejections.length === 0) return "";

  const shown = rejections.slice(0, MAX_PROMPT_EXAMPLES).map((doc) =>
    `- ${doc.file} [${doc.category}] ${doc.title}`);

  return [
    "",
    "PREVIOUSLY REJECTED IN THIS REPOSITORY",
    "A maintainer who knows this codebase marked each of these as not a defect.",
    "They are local judgement, not general rules: they tell you what this team",
    "considers acceptable in this code, which you cannot work out from the diff.",
    "Weigh them when a finding resembles one. Do not over-apply them — a real",
    "defect that happens to look like a past rejection is still a real defect,",
    "and a reviewer that generalises these into silence is worse than useless.",
    "",
    ...shown,
  ].join("\n");
}
