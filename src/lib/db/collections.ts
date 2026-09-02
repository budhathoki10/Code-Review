import type { Collection } from "mongodb";
import getMongoClient from "@/lib/mongodb";

export interface InstallationDoc {
  _id?: string;
  githubInstallationId: number;
  githubUserId: string;
  accountLogin: string;
  createdAt: Date;
}

/**
 * Running AI token totals across the WHOLE app — every review by every user
 * `$inc`s this one shared document, so reading total consumption is a single
 * point lookup. Deliberately not split per user and not a per-call ledger:
 * it's one global cost counter, so it can't attribute usage to a user or a
 * specific review — add a separate collection if that's ever needed.
 */
export interface UsageDoc {
  _id?: string;
  /** Always GLOBAL_USAGE_KEY — the fixed key making this a single shared row. */
  key: string;
  /** Prompt tokens sent to the provider (system prompts + tool schemas + diff, re-sent each findings round). */
  inputTokens: number;
  /** Completion tokens returned. */
  outputTokens: number;
  totalTokens: number;
  /** Individual provider calls — up to 65 per review (see the worst-case breakdown in review-worker-factory.ts). */
  calls: number;
  /** Reviews contributing to these totals — `calls / reviews` gives average calls per review. */
  reviews: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RepositoryDoc {
  _id?: string;
  installationId: string;
  githubInstallationId: number;
  githubRepoId: number;
  fullName: string;
  config?: {
    /** Minimum severity that gets posted to GitHub and can fail the check run. Unset = post everything. */
    severityThreshold?: "info" | "low" | "medium" | "high" | "critical";
    customInstructions?: string[];
    /**
     * Categories switched off from the dashboard. Unioned with the same
     * setting in the repo's own `.prsentry.yaml` — a category either side
     * turns off stays off, which is the only merge rule that can't surprise
     * someone: neither config can silently re-enable what the other disabled.
     *
     * Unlike severityThreshold, this drops findings before they are stored,
     * so a disabled category can't fail the check run either. Off means off.
     */
    disabledCategories?: FindingDoc["category"][];
  };
}

export interface PullRequestDoc {
  _id?: string;
  repositoryId: string;
  githubPrNumber: number;
  githubPrId: number;
  title: string;
  headSha: string;
  /** Kept in sync with the PR body on every push so a throttle-debounced trailing review (see throttle-worker-factory.ts) still has it for AI context. */
  body?: string | null;
  /**
   * The head commit of the last review that completed for this PR — the base
   * of the next incremental diff. Derivable from the reviews collection, but
   * stored here so the incremental path is a point lookup on the PR rather
   * than a sort over its review history, and so "what has this PR actually
   * been reviewed up to?" is answerable without reconstructing it.
   */
  lastReviewedSha?: string;
}

export interface FindingDoc {
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: "security" | "bug" | "performance" | "quality" | "testing";
  file: string;
  line?: number;
  title: string;
  explanation: string;
  suggestion?: string;
  confidence?: string;
  /** Absent means "ai" — only set for findings produced by the deterministic static-analysis stage. */
  source?: "ai" | "static-analysis";
  /**
   * The GitHub review-comment this finding was posted as, when it was posted
   * inline. This is the anchor the reply feature resolves against: a
   * `pull_request_review_comment` webhook only tells us `in_reply_to_id`, so
   * without this stored mapping there is no way to know which finding a
   * developer is asking about. Absent for findings that were never posted
   * inline (no line, line outside the diff, or lost the inline cap — see
   * mapFindingsToInlineComments/capInlineComments) and for reviews written
   * before this field existed; both simply aren't replyable.
   */
  githubCommentId?: number;
  /**
   * The existing line `suggestion` would replace, captured from the diff at
   * review time. Lets the dashboard show before/after side by side the way
   * GitHub's suggestion widget does — GitHub gets the "before" from the PR
   * page it renders on, whereas the dashboard has no diff at render time.
   *
   * Only set when the suggestion is committable code (see
   * looksLikeCleanCodeSuggestion) and the finding's line was in the diff.
   * Absent on prose suggestions, unmappable findings, and reviews saved
   * before this field existed.
   */
  originalLine?: string;
  /**
   * The lines around `line` in the new file, so the dashboard can show a
   * suggestion the way GitHub's split diff does — a few lines of unchanged
   * code above and below, rather than the replaced line floating alone with
   * nothing to locate it against.
   *
   * Excludes `line` itself, which is already stored as `originalLine`;
   * keeping one copy means the two can never disagree. Each entry carries
   * its own new-file number because the window is not necessarily
   * contiguous: only lines present in the diff can be captured, so a removed
   * line or a hunk boundary leaves a gap the renderer draws as a break.
   *
   * Set alongside `originalLine` and under the same conditions, so a finding
   * has both or neither. Absent on reviews saved before this field existed.
   */
  originalContext?: { line: number; text: string }[];
}

/** Per-review cost and coverage accounting. Every field is recorded even when zero, so a missing value means "review predates this", not "nothing happened". */
export interface ReviewMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Provider calls this review made. */
  calls: number;
  model: string;
  /** Wall-clock milliseconds from pipeline start to finish, including GitHub I/O and static analysis. */
  durationMs: number;
  /** Files GitHub reported as changed. */
  filesSeen: number;
  /** Files removed by the noise list, user path filters, or cheap triage. */
  filesFiltered: number;
  /** Files actually sent to the model. */
  filesReviewed: number;
  findingsProduced: number;
  /** Inline comments actually posted (after the per-review cap). */
  commentsPosted: number;
  /** USD, from the configured per-million-token rates. Approximate by construction — see estimateCost. */
  estimatedCostUsd: number;
}

export interface ReviewDoc {
  _id?: string;
  pullRequestId: string;
  headSha: string;
  status: "pending" | "completed" | "failed";
  verdict?: "approve" | "request_changes" | "comment";
  summary?: string;
  score?: number;
  findings: FindingDoc[];
  createdAt: Date;
  /** Files this specific round's diff actually covered (the incremental delta, or every file on a first review) — lets the dashboard show only what changed *this round*, even though `findings` also carries forward still-open findings from untouched files for gating purposes. Absent on reviews created before this field existed. */
  touchedFiles?: string[];
  /**
   * Files this round's diff touched but that never reached the model —
   * noise (lockfiles, generated code), cheap-triage skips (whitespace/
   * comment/import-reorder-only), or an unobtainable diff. Not derivable
   * from `findings` alone: a file with zero findings is either "reviewed,
   * clean" or "never reviewed", and those look identical without this list.
   * Absent on reviews saved before this field existed.
   */
  filteredFiles?: { file: string; reason: string }[];
  /** Set only once the Phase 3 summary comment successfully posts. Its absence on a
   *  "completed" review means generation succeeded but posting to GitHub hasn't (yet). */
  githubCommentId?: number;
  /** Set once a GitHub check run is created, so a retried job PATCHes it instead of creating a duplicate. */
  checkRunId?: number;
  /**
   * Set once inline review comments have gone out for this head SHA, so a
   * retried job doesn't post them a second time.
   *
   * The summary comment was already safe — it is edited in place by ID — but
   * inline comments have no equivalent handle, and BullMQ retries re-run the
   * pipeline from the top. With `aiCheckpoint` making a retry cheap and fast,
   * the second attempt reaches posting in seconds with byte-identical
   * findings: PR #58 received every one of its reviews twice, roughly the
   * retry backoff apart. Posting itself is wrapped in try/catch and never
   * triggers the retry, so whatever failure caused it happened elsewhere —
   * which is exactly why this guard has to be persisted rather than held in
   * memory for the length of one attempt.
   */
  inlineCommentsPostedAt?: Date;
  /**
   * What this one review cost and covered. The global `usage` counter answers
   * "what have we spent in total"; this answers "what did THIS review spend,
   * and on how much work" — the question you actually need to find the review
   * that burned 400k tokens, which a single shared counter can never surface.
   */
  metrics?: ReviewMetrics;
  /**
   * The model's output for this exact head commit, persisted the instant
   * generation finishes and before anything that can fail.
   *
   * BullMQ retries a failed job up to `attempts` (3) times, and a retry
   * re-runs the whole pipeline from the top. Without this, any failure after
   * the model calls — a Mongo blip writing the review, say — would re-spend
   * the entire token budget, making the real worst case per PR event 3x the
   * per-attempt ceiling. Posting failures were already isolated and never
   * retried; this closes the remaining window.
   *
   * Keyed implicitly by (pullRequestId, headSha), the same pair the unique
   * index uses, so it can only ever be reused for the commit that produced
   * it. A new push writes a new review row and gets no checkpoint.
   */
  aiCheckpoint?: {
    verdict: "approve" | "request_changes" | "comment";
    summary: string;
    findings: FindingDoc[];
    /** Files the model could not review even after chunk splitting — see runFindingsWithBisect. */
    unreviewedFiles: string[];
    /** Static-analysis findings from the same attempt. Free of model cost, but not free of GitHub calls and CPU. */
    staticFindings: FindingDoc[];
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    calls: number;
    at: Date;
  };
  /** Populated once retries are exhausted — the durable dead-letter record for a failed review. */
  error?: { message: string; attempts: number; failedAt: Date };
  /**
   * Set when a review deliberately stopped short instead of reviewing the
   * whole PR: rate limiting (retryable — the job is failed so BullMQ runs it
   * again) or a size bail-out (terminal until someone forces it). Recorded so
   * "why did this PR never get a real review?" is answerable from the
   * database rather than only from logs.
   */
  incomplete?: {
    reason:
      | "rate-limited"
      | "too-many-files"
      | "too-many-changed-lines"
      | "un-enumerable"
      /** The chunk budget reached too little of the PR for the review to be a fair account of it. */
      | "coverage-too-low"
      /** Projected token spend exceeded the per-review cost ceiling. */
      | "cost-ceiling";
    detail: string;
    filesSeen?: number;
    filesFiltered?: number;
    changedLines?: number;
    at: Date;
  };
}

async function db() {
  const client = await getMongoClient();
  return client.db(process.env.MONGODB_DB);
}

export async function installations(): Promise<Collection<InstallationDoc>> {
  return (await db()).collection<InstallationDoc>("installations");
}

export async function repositories(): Promise<Collection<RepositoryDoc>> {
  return (await db()).collection<RepositoryDoc>("repositories");
}

export async function pullRequests(): Promise<Collection<PullRequestDoc>> {
  return (await db()).collection<PullRequestDoc>("pull_requests");
}

export async function reviews(): Promise<Collection<ReviewDoc>> {
  return (await db()).collection<ReviewDoc>("reviews");
}

export async function usage(): Promise<Collection<UsageDoc>> {
  return (await db()).collection<UsageDoc>("usage");
}

let indexesEnsured: Promise<void> | undefined;

/** Idempotent — safe to call on every cold start. */
export function ensureIndexes(): Promise<void> {
  if (!indexesEnsured) {
    indexesEnsured = (async () => {
      const [installationsCol, repositoriesCol, pullRequestsCol, reviewsCol, usageCol] =
        await Promise.all([
          installations(),
          repositories(),
          pullRequests(),
          reviews(),
          usage(),
        ]);

      await Promise.all([
        installationsCol.createIndex({ githubInstallationId: 1 }, { unique: true }),
        repositoriesCol.createIndex({ githubRepoId: 1 }, { unique: true }),
        pullRequestsCol.createIndex({ githubPrId: 1 }, { unique: true }),
        reviewsCol.createIndex({ pullRequestId: 1, headSha: 1 }, { unique: true }),
        // Unique so the recordUsage upsert always accumulates into the single
        // global document instead of racing concurrent reviews into duplicates.
        usageCol.createIndex({ key: 1 }, { unique: true }),
      ]);
    })();
  }
  return indexesEnsured;
}
