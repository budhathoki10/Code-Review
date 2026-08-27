import type { RepoReviewConfig } from "@/lib/review/config";
import { describeSkipReason } from "@/lib/review/triage";
import {
  REVIEW_CAPACITY,
  fileCoverage,
  charCoverage,
  MAX_REVIEW_CHUNKS,
  type SelectedDiff,
} from "@/lib/review/diff-selection";
import { MAX_FINDINGS_TOOL_ROUNDS } from "@/lib/ai/review";
import { REVIEW_JOB_ATTEMPTS } from "@/lib/queue/review-queue";

export const FORCE_COMMAND = "@prsentry review --force";

export type BailReason =
  | "too-many-files"
  | "too-many-changed-lines"
  | "un-enumerable"
  | "coverage-too-low"
  | "cost-ceiling";

export interface GateDecision {
  bail: boolean;
  reason?: BailReason;
  detail?: string;
  /** Non-fatal concerns worth logging and surfacing — currently an expensive-but-allowed review. */
  warnings: string[];
}

/**
 * Minimum share of a PR's reviewable files a review must actually cover to be
 * worth posting.
 *
 * This is the replacement for the old fixed changed-line cutoff. The question
 * that matters is not "how many lines changed" but "will the review I'm about
 * to post be a fair account of this PR?" — a review reaching 95% of the files
 * is a real review with a footnote, while one reaching 20% is misleading,
 * because "no issues found" gets read as a claim about the whole PR.
 *
 * Set generously low on purpose: partial coverage plus an explicit coverage
 * note (the pre-Phase-2 behavior) beats silence for almost every real PR.
 */
const MIN_COVERAGE_RATIO = Number(process.env.REVIEW_MIN_COVERAGE ?? 0.5);

/**
 * Separate, far lower floor for CHARACTER coverage.
 *
 * Breadth and depth are different kinds of gap and deserve different
 * treatment. A file the budget never reached is one nobody opened — that
 * makes a review misleading about what it examined, and the 50% file floor
 * above is the right response. A file that WAS opened but whose diff was
 * truncated is a disclosable limitation, not a lie: the review genuinely
 * looked at that file, just not every line of it.
 *
 * Holding truncation to the same 50% bar refused an entire class of PR the
 * pipeline handles perfectly well — a single enormous file, where the review
 * would have covered the first 60k characters and said so. That contradicts
 * the rule the rest of this gate follows: review what fits, report what
 * didn't. Below this floor, though, a "review" of a few percent of the
 * content is theatre, so there is still a bottom.
 */
const MIN_CHAR_COVERAGE = Number(process.env.REVIEW_MIN_CHAR_COVERAGE ?? 0.1);

/** Characters per token. Crude, but the estimate below only needs an order of magnitude. */
const CHARS_PER_TOKEN = 4;

/** Roughly what the system prompt, tool schemas, PR metadata and static findings add to every call. */
const PROMPT_OVERHEAD_TOKENS = 1_200;

/**
 * Refuse a review whose *expected* token cost exceeds this. Separate from the
 * capacity ceiling on purpose: capacity asks "can we cover this PR?", cost
 * asks "should we pay what covering it would take?". A PR can pass the first
 * and fail the second — a handful of enormous files fits inside 4 chunks
 * while still being the most expensive review the bot has ever run.
 *
 * This matters more now than it used to. Gating on capacity instead of a
 * fixed line count turns a rare zero-cost bail-out into a common
 * bounded-but-real cost, so there needs to be a ceiling on that cost that
 * isn't the file count.
 */
const MAX_ESTIMATED_TOKENS = Number(process.env.REVIEW_MAX_ESTIMATED_TOKENS ?? 250_000);

/** Warn (but proceed) once a review is projected to cost this share of the ceiling. */
const COST_WARN_RATIO = Number(process.env.REVIEW_COST_WARN_RATIO ?? 0.6);

export interface CostEstimate {
  /** Expected input tokens: one findings pass per chunk plus the single verdict call. */
  expectedTokens: number;
  /** If every chunk used its full tool-calling round budget. Not used for gating — reported for context. */
  worstCaseTokens: number;
  /**
   * The absolute per-PR-event bound: worst case multiplied by BullMQ's retry
   * count, i.e. what this PR could cost if every attempt burned every round
   * AND the checkpoint failed to persist each time.
   *
   * Not what the gate uses. With the AI checkpoint in place (see
   * ReviewDoc.aiCheckpoint) a retry reuses the previous attempt's model
   * output instead of regenerating, so the realistic per-event cost is
   * `worstCaseTokens`, not this. Reported because "3x if the checkpoint
   * write itself keeps failing" is a real, if remote, ceiling and should be
   * visible rather than assumed away.
   */
  worstCaseAcrossRetries: number;
  chunks: number;
}

/**
 * Projects a review's token cost from the chunk sizes, before any call is
 * made.
 *
 * Estimates the EXPECTED cost (one findings round per chunk plus one verdict
 * call), not the pathological worst case. Gating on the worst case would
 * refuse most large reviews on the strength of a tool-calling budget that a
 * typical review never touches — the model usually submits on its first
 * round. The worst case is still computed and reported so the number is
 * visible rather than assumed.
 */
export function estimateReviewCost(selection: SelectedDiff): CostEstimate {
  const chunks = selection.chunks.length;
  if (chunks === 0) return { expectedTokens: 0, worstCaseTokens: 0, worstCaseAcrossRetries: 0, chunks: 0 };

  const perChunk = selection.chunks.map((chunk) => chunk.diffText.length / CHARS_PER_TOKEN + PROMPT_OVERHEAD_TOKENS);
  const findingsTokens = perChunk.reduce((total, tokens) => total + tokens, 0);
  // The verdict call sees chunk 1's diff only.
  const verdictTokens = perChunk[0];

  // Each tool-calling round re-sends the whole conversation, so a chunk that
  // uses all its rounds costs roughly its prompt size times the round count.
  const rounds = MAX_FINDINGS_TOOL_ROUNDS + 1;

  const worstCaseTokens = Math.round(findingsTokens * rounds + verdictTokens);

  return {
    expectedTokens: Math.round(findingsTokens + verdictTokens),
    worstCaseTokens,
    worstCaseAcrossRetries: worstCaseTokens * REVIEW_JOB_ATTEMPTS,
    chunks,
  };
}

/**
 * Decides whether a PR can be reviewed at all, AFTER filtering.
 *
 * Four gates, in order of how badly they invalidate a review:
 *
 *   1. Un-enumerable — GitHub cannot list the files, so nothing downstream
 *      can be trusted to be complete.
 *   2. Coverage — the chunk budget reaches too little of the PR for the
 *      result to be a fair account of it.
 *   3. Cost — the projected token spend exceeds what one review may cost.
 *   4. Repo overrides — an explicit, stricter per-repo cutoff.
 *
 * What is deliberately NOT a gate any more: a fixed changed-line count.
 * That check refused a 20,000-line PR of real code while passing a
 * 20,000-line PR that was 95% lockfile churn, because it measured the diff
 * GitHub reported rather than the work this pipeline can actually do. Below
 * the pipeline's real capacity the review now proceeds and reports whatever
 * didn't fit in the summary, which is the pre-Phase-2 behavior and the right
 * one.
 *
 * Note this reads `selection`, which is built by Phase 1's diff fetching —
 * complete pagination and reconstructed `patch: null` diffs included. It
 * never consults a raw pre-Phase-1 file list.
 */
export function evaluateSizeGate(
  selection: SelectedDiff,
  config: RepoReviewConfig,
  options: { oversized?: boolean; forced?: boolean } = {},
): GateDecision {
  const warnings: string[] = [];

  // An explicit @prsentry review --force overrides every limit below. The
  // author has seen the counts and asked for it anyway.
  if (options.forced) return { bail: false, warnings };

  if (options.oversized) {
    return {
      bail: true,
      reason: "un-enumerable",
      detail: `GitHub's API cannot list every file in this pull request (it caps at 3000), so any review would silently cover only part of it.`,
      warnings,
    };
  }

  // Nothing survived filtering — not a size problem, and not a bail-out.
  // The pipeline posts a "nothing to review" result for this.
  if (selection.reviewableCount === 0) return { bail: false, warnings };

  // Breadth first: files the budget never reached at all.
  const files = fileCoverage(selection);
  if (files < MIN_COVERAGE_RATIO) {
    return {
      bail: true,
      reason: "coverage-too-low",
      detail:
        `Only ${selection.coveredCount} of ${selection.reviewableCount} reviewable files (${Math.round(files * 100)}%) fit within the review budget of ` +
        `${REVIEW_CAPACITY.files} files across ${MAX_REVIEW_CHUNKS} passes. That is below the ${Math.round(MIN_COVERAGE_RATIO * 100)}% needed for a review to be a fair account of this pull request.`,
      warnings,
    };
  }

  // Depth second, against a much lower floor: every file was opened, but a
  // truncated one still hides content. Worth disclosing loudly; only worth
  // refusing when almost nothing was readable.
  const chars = charCoverage(selection);
  if (chars < MIN_CHAR_COVERAGE) {
    return {
      bail: true,
      reason: "coverage-too-low",
      detail:
        `Only ${selection.coveredChars.toLocaleString()} of ${selection.reviewableChars.toLocaleString()} characters of diff (${Math.round(chars * 100)}%) could be read within the review budget of ` +
        `${REVIEW_CAPACITY.chars.toLocaleString()} characters across ${MAX_REVIEW_CHUNKS} passes. Oversized files are truncated to fit, and at this ratio almost none of this pull request's content was visible.`,
      warnings,
    };
  }

  // Reviewed, but with a large blind spot — say so before spending anything.
  if (chars < MIN_COVERAGE_RATIO) {
    warnings.push(
      `Only ${Math.round(chars * 100)}% of this pull request's diff characters fit the review budget; oversized files were truncated.`,
    );
  }

  const cost = estimateReviewCost(selection);
  if (cost.expectedTokens > MAX_ESTIMATED_TOKENS) {
    return {
      bail: true,
      reason: "cost-ceiling",
      detail:
        `Reviewing this pull request is projected to cost about ${cost.expectedTokens.toLocaleString()} tokens across ${cost.chunks} passes, ` +
        `over the per-review ceiling of ${MAX_ESTIMATED_TOKENS.toLocaleString()}.`,
      warnings,
    };
  }
  if (cost.expectedTokens > MAX_ESTIMATED_TOKENS * COST_WARN_RATIO) {
    warnings.push(
      `This review is projected to cost about ${cost.expectedTokens.toLocaleString()} tokens (ceiling ${MAX_ESTIMATED_TOKENS.toLocaleString()}).`,
    );
  }

  // Repo overrides last: they exist to be STRICTER than the ceilings above,
  // never to be the only thing standing between a PR and an unbounded review.
  if (config.maxFiles !== undefined && selection.reviewableCount > config.maxFiles) {
    return {
      bail: true,
      reason: "too-many-files",
      detail: `${selection.reviewableCount} reviewable files exceeds this repository's configured limit of ${config.maxFiles}.`,
      warnings,
    };
  }

  if (config.maxChangedLines !== undefined && selection.reviewableChangedLines > config.maxChangedLines) {
    return {
      bail: true,
      reason: "too-many-changed-lines",
      detail: `${selection.reviewableChangedLines} changed lines across reviewable files exceeds this repository's configured limit of ${config.maxChangedLines}.`,
      warnings,
    };
  }

  return { bail: false, warnings };
}

function skipBreakdown(selection: SelectedDiff): string[] {
  const rows: string[] = [];
  if (selection.skippedAsNoise.length > 0) {
    rows.push(`- ${selection.skippedAsNoise.length} generated, vendored, or binary`);
  }
  const byReason = new Map<string, number>();
  for (const { reason } of selection.triaged) {
    const label = describeSkipReason(reason);
    byReason.set(label, (byReason.get(label) ?? 0) + 1);
  }
  for (const [label, count] of byReason) rows.push(`- ${count} ${label}`);
  return rows;
}

/**
 * The comment posted instead of a review when the gate fires. States the
 * actual numbers rather than "this PR is too large", because the author's
 * next question is always "too large by how much, and what did you count?" —
 * and offers the override so the decision stays theirs.
 */
export function formatBailoutComment(
  selection: SelectedDiff,
  config: RepoReviewConfig,
  decision: GateDecision,
  totals: { filesSeen: number; totalChangedLines: number },
): string {
  const skipped = skipBreakdown(selection);
  const cost = estimateReviewCost(selection);

  const parts = [
    "##  AI Code Review",
    "",
    "**This pull request could not be reviewed reliably, so no review was run.**",
    "",
    decision.detail ?? "",
    "",
    "| | Count |",
    "| --- | ---: |",
    `| Files changed | ${totals.filesSeen} |`,
    `| Files after filtering | ${selection.reviewableCount} |`,
    `| Files that fit the review budget | ${selection.coveredCount} |`,
    `| Changed lines (reviewable) | ${selection.reviewableChangedLines} |`,
    `| Review capacity | ${REVIEW_CAPACITY.files} files / ${REVIEW_CAPACITY.chars.toLocaleString()} chars (${MAX_REVIEW_CHUNKS} passes) |`,
    `| Projected cost | ~${cost.expectedTokens.toLocaleString()} tokens |`,
  ];

  if (config.maxFiles !== undefined) parts.push(`| Repo limit: files | ${config.maxFiles} |`);
  if (config.maxChangedLines !== undefined) parts.push(`| Repo limit: changed lines | ${config.maxChangedLines} |`);

  if (skipped.length > 0) {
    parts.push("", `**Filtered out (${selection.skippedAsNoise.length + selection.triaged.length} files):**`, ...skipped);
  }

  parts.push(
    "",
    "Reviewing a fraction of a pull request this size and calling it a review would be worse than saying nothing — \"no issues found\" would read as a statement about the whole thing.",
    "",
    "**What you can do:**",
    "",
    "- Split this into smaller pull requests, which will also get you a better review.",
    `- Or comment \`${FORCE_COMMAND}\` to review it anyway, accepting partial coverage.`,
  );

  if (decision.reason === "too-many-files" || decision.reason === "too-many-changed-lines") {
    parts.push("- Or raise `reviews.max_files` / `reviews.max_changed_lines` in `.prsentry.yaml`.");
  }

  return parts.join("\n");
}

/** Recognizes the override command anywhere in a PR comment body. */
export function isForceCommand(body: string | null | undefined): boolean {
  if (!body) return false;
  return body.toLowerCase().includes(FORCE_COMMAND.toLowerCase());
}
