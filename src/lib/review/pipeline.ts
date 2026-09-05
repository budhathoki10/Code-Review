// this is the main heart of the code
import { ObjectId } from "mongodb";
import type { Logger } from "pino";
import { getPullRequestDiff, getIncrementalDiff, type PullRequestDiff } from "@/lib/github/diff";
import { GitHubRateLimitError } from "@/lib/github/file-content";
import { DEFAULT_MODEL, generateChunkedReview, type ReviewResult } from "@/lib/ai/review";
import { getFileContent } from "@/lib/github/file-content";
import { canBlock, dedupeFindings } from "@/lib/review/finding-policy";
import { skippedVerification, verificationCandidates, verifyBlockingFindings } from "@/lib/review/verification";
import { codeWindow, riskReasons } from "@/lib/review/risk";
import { proofImage } from "@/lib/review/test-proof";
import { getInstallationOctokit } from "@/lib/github/app";
import { selectDiffForReview, formatCoverageNote, coverageRatio, REVIEW_CAPACITY } from "@/lib/review/diff-selection";
import { describeSkipReason } from "@/lib/review/triage";
import { loadRepoConfig, formatConfigErrors } from "@/lib/review/config";
import { evaluateSizeGate, formatBailoutComment, estimateReviewCost } from "@/lib/review/gate";
import { formatSummaryComment, postSummaryComment, updateSummaryComment } from "@/lib/github/comment";
import {
  computeLineContents,
  computeContextLines,
  looksLikeCleanCodeSuggestion,
  mapFindingsToInlineComments,
  capInlineComments,
} from "@/lib/github/diff-lines";
import { postInlineReview } from "@/lib/github/inline-comments";
import { createCheckRun, completeCheckRun, type CheckConclusion } from "@/lib/github/checks";
import { runStaticAnalysis } from "@/lib/review/static-analysis";
import { addUsage, recordUsage, estimateCost, EMPTY_USAGE, REVIEW_TOKEN_CEILING, type TokenUsage } from "@/lib/db/usage";
import {
  reviews,
  pullRequests,
  repositories,
  type FindingDoc,
  type RepositoryDoc,
} from "@/lib/db/collections";
import { REVIEW_JOB_ATTEMPTS, type ReviewJobData } from "@/lib/queue/review-queue";
import { normalizeDisabledSeverities } from "@/lib/review/severity";

const SEVERITY_ORDER: FindingDoc["severity"][] = ["info", "low", "medium", "high", "critical"];

/**
 * How long the AI call waits for static analysis to finish before giving up
 * on including its findings as context (see runReviewPipeline). Bounds the
 * cost of the Phase 1 context-build change: without this cap, a slow
 * static-analysis run (multiple CLI-tool subprocess spawns) would fully
 * serialize in front of the AI call and regress PR #34's parallelism win.
 * A review that misses this window still gets its static findings in the
 * final posted list — it just didn't have them available for the AI's own
 * "don't repeat these" context that one time.
 */
const STATIC_ANALYSIS_CONTEXT_TIMEOUT_MS = Number(process.env.STATIC_ANALYSIS_CONTEXT_TIMEOUT_MS ?? 8_000);

function meetsThreshold(severity: FindingDoc["severity"], threshold: FindingDoc["severity"]): boolean {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(threshold);
}

/**
 * `severityThreshold` is a single configured value with two different
 * unconfigured defaults: posting defaults to "info" (post everything —
 * matches pre-Phase-6 behavior) while the check-run gate defaults to "high"
 * (a brand new repo shouldn't see its first check fail over an info-level
 * nit). Once a repo explicitly configures the field, both uses respect it.
 */
function resolvePostingThreshold(config: RepositoryDoc["config"] | undefined): FindingDoc["severity"] {
  return config?.severityThreshold ?? "info";
}

function resolveGateThreshold(config: RepositoryDoc["config"] | undefined): FindingDoc["severity"] {
  return config?.severityThreshold ?? "high";
}

async function loadPullRequestDoc(pullRequestId: string) {
  if (!ObjectId.isValid(pullRequestId)) return null;
  const pullRequestsCol = await pullRequests();
  return pullRequestsCol.findOne({ _id: new ObjectId(pullRequestId) as unknown as string });
}

async function loadRepositoryConfig(pullRequestId: string): Promise<RepositoryDoc["config"] | undefined> {
  if (!ObjectId.isValid(pullRequestId)) return undefined;

  const pullRequestsCol = await pullRequests();
  const pullRequestDoc = await pullRequestsCol.findOne({
    _id: new ObjectId(pullRequestId) as unknown as string,
  });
  if (!pullRequestDoc || !ObjectId.isValid(pullRequestDoc.repositoryId)) return undefined;

  const repositoriesCol = await repositories();
  const repositoryDoc = await repositoriesCol.findOne({
    _id: new ObjectId(pullRequestDoc.repositoryId) as unknown as string,
  });
  return repositoryDoc?.config;
}

export function computeConclusion(
  verdict: ReviewResult["verdict"],
  findings: FindingDoc[],
  gateThreshold: FindingDoc["severity"],
): CheckConclusion {
  if (findings.some((f) => canBlock(f) && meetsThreshold(f.severity, gateThreshold))) {
    return "failure";
  }
  if (verdict !== "approve" || findings.length > 0) return "neutral";
  return "success";
}

function conclusionTitle(conclusion: CheckConclusion): string {
  if (conclusion === "failure") return "Changes requested";
  if (conclusion === "neutral") return "Feedback available";
  return "No blocking issues";
}

/**
 * Findings on files this delta didn't touch are still valid from the
 * previous review — carried forward verbatim rather than re-scanned. A
 * finding on a file the delta DID touch is dropped in favor of whatever a
 * fresh scan of that file's new hunks finds (no attempt to track whether
 * the old finding's exact line survived the edit — a deliberate v1
 * simplification, not a correctness guarantee).
 */
/**
 * Builds the predicate that drops findings in categories the repo switched
 * off, from either config surface: the dashboard's review settings
 * (`RepositoryDoc.config`) or `reviews.disabled_categories` in
 * .prsentry.yaml. The sources are UNIONED — a category either one turns off
 * stays off. That is the only merge rule that can't surprise anyone: no
 * config can silently re-enable a category the other disabled, which is what
 * a precedence rule would do to whichever surface lost.
 *
 * Applied to every source at once — carried-forward, AI and static — so a
 * category disabled after an earlier review can't reappear through the
 * carry-forward path, and so the drop happens before the review is stored
 * rather than at posting time like the severity threshold does. That
 * difference is deliberate: severity hides low-value findings but still lets
 * a stale critical one fail the check run, whereas a category the repo has
 * turned off must not be able to fail anything. Off means off, not hidden.
 *
 * Severity and category are independent axes — a repo can say "nothing below
 * medium" and "no testing findings" at once, and neither can express the
 * other.
 */
export function categoryFilter(
  ...sources: (FindingDoc["category"][] | undefined)[]
): (finding: FindingDoc) => boolean {
  const disabled = new Set(sources.flatMap((source) => source ?? []));
  if (disabled.size === 0) return () => true;
  return (finding) => !disabled.has(finding.category);
}

/**
 * Drops findings whose severity the repo switched off.
 *
 * Deliberately separate from the posting threshold: that one hides a finding
 * from GitHub while still storing it, this one discards it. Same "off means
 * off" rule categoryFilter follows — a check run must never fail on a
 * finding the repo explicitly asked not to receive.
 *
 * Every severity off would leave nothing at all, which is never what someone
 * means, so an all-off set is ignored rather than obeyed — the same guard
 * readDisabledCategories applies to categories.
 */
export function severityFilter(
  ...sources: (FindingDoc["severity"][] | undefined)[]
): (finding: FindingDoc) => boolean {
  const disabled = new Set(normalizeDisabledSeverities(sources.flatMap((source) => source ?? [])));
  if (disabled.size === 0) return () => true;
  return (finding) => !disabled.has(finding.severity);
}

export function filterCarriedForwardFindings(previousFindings: FindingDoc[], touchedFiles: Set<string>): FindingDoc[] {
  return previousFindings.filter((f) => !touchedFiles.has(f.file));
}

/** Identity used to decide whether two findings describe the same defect across reviews. */
function findingKey(finding: FindingDoc): string {
  return `${finding.file}::${finding.title.trim().toLowerCase()}`;
}

/**
 * Carries `githubCommentId` across a retry.
 *
 * A retry rebuilds the findings array from `aiCheckpoint`, which is written
 * before anything is posted and so has no comment IDs on it. Storing that
 * rebuilt array as-is would erase the mapping the first attempt persisted —
 * and because `inlineCommentsPostedAt` correctly stops the second attempt
 * from posting again, nothing downstream would ever put the IDs back.
 *
 * The cost of losing them is invisible and permanent: `findFindingByCommentId`
 * (reply-pipeline.ts) resolves a developer's reply by querying
 * `findings.githubCommentId`, so every reply in every thread on that review
 * would be silently dropped as "no finding maps to this comment".
 *
 * Matched by value rather than object identity — these are freshly
 * constructed objects, not the ones that were posted. Line is part of the
 * key because one file can carry two findings with the same title.
 */
function withPersistedCommentIds(findings: FindingDoc[], stored: FindingDoc[] | undefined): FindingDoc[] {
  const byPosition = new Map<string, number>();
  for (const finding of stored ?? []) {
    if (finding.githubCommentId !== undefined) {
      byPosition.set(`${finding.file}::${finding.line}::${finding.title}`, finding.githubCommentId);
    }
  }
  return findings.map((finding) => {
    const githubCommentId = byPosition.get(`${finding.file}::${finding.line}::${finding.title}`);
    const feedback = stored?.find((item) => findingKey(item) === findingKey(finding))?.feedback;
    return { ...finding, ...(githubCommentId === undefined ? {} : { githubCommentId }), ...(feedback ? { feedback } : {}) };
  });
}

/**
 * Findings from the previous review that this round's re-scan no longer
 * reports, on files this round actually looked at.
 *
 * The inference is deliberately narrow. A finding only counts as resolved if
 * its file was in this delta — meaning the code was edited AND re-reviewed —
 * and the fresh scan of that file did not raise it again. A finding on an
 * untouched file is carried forward unchanged rather than declared fixed,
 * because nothing about it was re-examined; treating "not re-reported" as
 * "fixed" without that guard would silently retire real findings every time
 * the model's attention moved elsewhere.
 *
 * Still a heuristic, not a proof: the model could simply have missed on the
 * second pass. That's why this drives a sentence in the summary and not, say,
 * the check-run gate.
 */
export function findResolvedFindings(
  previousFindings: FindingDoc[],
  touchedFiles: Set<string>,
  currentFindings: FindingDoc[],
): FindingDoc[] {
  const stillReported = new Set(currentFindings.map(findingKey));
  return previousFindings.filter((f) => touchedFiles.has(f.file) && !stillReported.has(findingKey(f)));
}

/** The sentence appended to a summary when a push fixed things the last review flagged. */
export function formatResolvedNote(resolved: FindingDoc[]): string {
  if (resolved.length === 0) return "";

  const shown = resolved.slice(0, 5).map((f) => `- \`${f.file}\` — ${f.title}`);
  const remainder = resolved.length - shown.length;
  if (remainder > 0) shown.push(`- ...and ${remainder} more`);

  return `\n\n---\n\n**${resolved.length} finding(s) from the previous review look resolved:**\n\n${shown.join("\n")}`;
}

function buildCheckSummary(findings: FindingDoc[]): string {
  if (findings.length === 0) return "No issues found.";
  const bySeverity = SEVERITY_ORDER.filter((severity) => findings.some((f) => f.severity === severity))
    .reverse()
    .map((severity) => `${findings.filter((f) => f.severity === severity).length} ${severity}`)
    .join(", ");
  return `${findings.length} finding(s) — ${bySeverity}.`;
}

/**
 * The Phase 2–6 pipeline (fetch diff → static analysis (bounded wait) → AI,
 * fed the static findings + PR title/description as context → post comment
 * → inline comments → check run), run by the BullMQ worker for
 * a single job. Diff fetch and AI generation failures are left to throw —
 * the caller (the worker) lets BullMQ retry those.
 *
 * Large PRs: size never fails a review. selectDiffForReview filters
 * generated/vendored noise, ranks what's left source-first, and splits it
 * into bounded chunks reviewed by generateChunkedReview; static analysis
 * still covers every non-noise file regardless of the AI budget, and
 * anything the budget couldn't reach is named in the posted comment rather
 * than quietly omitted.
 *
 * Incremental reviews: if a previous *completed* review exists for this PR,
 * the diff is computed from that review's headSha forward (just the delta
 * since last time) instead of against the PR's base branch — see
 * getIncrementalDiff. Findings on files outside that delta carry forward
 * from the previous review's findings list unchanged; only files actually
 * touched since the last review get re-scanned. Falls back to the full
 * base-diff behavior whenever there's no previous review, or the
 * incremental compare call itself fails (e.g. after a force-push).
 *
 * Posting to GitHub (summary comment, inline comments, check run) is
 * intentionally isolated in its own try/catch blocks: the review is already
 * generated and valid in our own dashboard regardless of whether publishing
 * it back to GitHub also succeeds, so a posting failure is logged but never
 * fails the job/retries the whole pipeline.
 */
export async function runReviewPipeline(data: ReviewJobData, log: Logger): Promise<void> {
  try {
    await runReviewPipelineInner(data, log);
  } catch (error) {
    if (!(error instanceof GitHubRateLimitError)) throw error;

    // A rate limit means the review would be built from an incomplete
    // picture of the PR. Posting it anyway is the worst outcome: the author
    // reads a partial review as a complete one. Say so instead and let
    // BullMQ retry the job.
    const { reviewId, pullRequestId, headSha, githubInstallationId, owner, repo, prNumber } = data;
    log.warn({ reviewId, resetAt: error.resetAt }, "review stopped — GitHub rate limit not cleared by the retry");

    const reviewsCol = await reviews();
    await reviewsCol.updateOne(
      { pullRequestId, headSha },
      { $set: { incomplete: { reason: "rate-limited" as const, detail: error.message, at: new Date() } } },
    );

    // Every BullMQ attempt lands here, so posting unconditionally would stack
    // up to `REVIEW_JOB_ATTEMPTS` identical notices on the PR. Reuse the
    // comment this review already owns — the same edit-in-place rule the
    // normal path follows — and record the id so the eventual successful
    // review overwrites the paused notice instead of posting beneath it.
    const existing = await reviewsCol.findOne({ pullRequestId, headSha });
    const body = [
      "##  AI Code Review",
      "",
      "This review was paused because GitHub's API rate limit was reached while reading the pull request.",
      "",
      "**No review was posted rather than a partial one** — a review built from an incomplete diff would look like a full review of the whole PR.",
      "",
      `It will retry automatically, up to ${REVIEW_JOB_ATTEMPTS} attempts in total. If every attempt is rate limited, push again or re-open the pull request to trigger a fresh review.`,
    ].join("\n");

    try {
      if (existing?.githubCommentId) {
        await updateSummaryComment(githubInstallationId, owner, repo, existing.githubCommentId, body);
        log.info({ reviewId, commentId: existing.githubCommentId }, "updated the rate-limit notice in place");
      } else {
        const commentId = await postSummaryComment(githubInstallationId, owner, repo, prNumber, body);
        await reviewsCol.updateOne({ pullRequestId, headSha }, { $set: { githubCommentId: commentId } });
        log.info({ reviewId, commentId }, "posted the rate-limit notice");
      }
    } catch (postError) {
      log.warn({ reviewId, err: postError }, "could not post the rate-limit notice");
    }

    // Rethrown so BullMQ retries this job rather than marking it done.
    throw error;
  }
}

async function runReviewPipelineInner(data: ReviewJobData, log: Logger): Promise<void> {
  const { reviewId, pullRequestId, headSha, githubInstallationId, owner, repo, prNumber, prTitle, prBody, forced } = data;
  const startedAt = Date.now();
  const reviewsCol = await reviews();

  // first finding the most recent document
  // checking the col and also filter  in parallel 
  const [repoConfig, existingReview, previousReview, pullRequestDoc] = await Promise.all([
    loadRepositoryConfig(pullRequestId),
    reviewsCol.findOne({ pullRequestId, headSha }),
    reviewsCol.findOne({ pullRequestId, status: "completed" }, { sort: { createdAt: -1 } }),
    loadPullRequestDoc(pullRequestId),
  ]);

  // The PR's own lastReviewedSha is the authority on how far this PR has been
  // reviewed; the most recent completed review's headSha is the fallback for
  // PRs last reviewed before that field existed. Both are skipped entirely on
  // a forced review, which is a request to re-review the whole PR, not the
  // delta since a run the author just rejected.
  const baselineSha = forced ? undefined : (pullRequestDoc?.lastReviewedSha ?? previousReview?.headSha);

  let diff: PullRequestDiff;
  if (baselineSha && baselineSha !== headSha) {
    const incrementalDiff = await getIncrementalDiff(githubInstallationId, owner, repo, baselineSha, headSha).catch(
      (incrementalError) => {
        log.warn({ reviewId, err: incrementalError }, "incremental diff failed, falling back to full PR diff");
        return null;
      },
    );
    if (incrementalDiff) {
      log.info({ reviewId, baselineSha, headSha, files: incrementalDiff.fileCount }, "reviewing incrementally");
    }
    diff = incrementalDiff ?? (await getPullRequestDiff(githubInstallationId, owner, repo, prNumber));
  } else {
    diff = await getPullRequestDiff(githubInstallationId, owner, repo, prNumber);
  }
  log.info(
    {
      reviewId,
      fileCount: diff.fileCount,
      totalChangedLines: diff.totalChangedLines,
      chars: diff.diffText.length,
      incremental: Boolean(baselineSha),
      oversized: Boolean(diff.oversized),
      locallyDiffed: diff.files.filter((f) => f.patchSource === "local").length,
      diffUnavailable: diff.files.filter((f) => f.patchSource === "unavailable").length,
    },
    "diff fetched",
  );

  // Repo-level overrides from .prsentry.yaml at the head commit. A malformed
  // file never fails the review — its problems are collected and appended to
  // the posted comment so the author can see exactly which key is wrong.
  const { config: reviewConfig, errors: configErrors } = await loadRepoConfig(
    githubInstallationId,
    owner,
    repo,
    headSha,
  );
  if (configErrors.length > 0) {
    log.warn({ reviewId, configErrors }, "problems in .prsentry.yaml — continuing with defaults for those keys");
  }

  // Both config surfaces, merged once here so the prompt and the finding
  // filter below can never disagree about which categories are off.
  // Normalized ONCE, here, because the list has two consumers that must agree:
  // the prompt (which tells the model which severities to skip) and
  // severityFilter (which drops them). Applying the all-off guard only in the
  // filter left the prompt still instructing the model to omit every
  // severity — it returned nothing, and the filter then had nothing to
  // preserve. The guard has to come before the earliest consumer.
  const effectiveDisabledSeverities = normalizeDisabledSeverities(repoConfig?.disabledSeverities);

  const mergedDisabledCategories = [
    ...new Set([...(repoConfig?.disabledCategories ?? []), ...reviewConfig.disabledCategories]),
  ];

  // Filtering runs before the size gate so the gate measures real reviewable
  // work: a 400-file formatting PR is usually under 20 files by this count,
  // and gating on GitHub's raw file count would refuse a PR there is nothing
  // expensive about. Within the reviewable set, size still doesn't decide
  // *whether* to review — only how the diff is split across AI passes.
  const selection = selectDiffForReview(diff.files, {
    pathFilters: reviewConfig.pathFilters,
    skipTriage: forced,
  });
  log.info(
    {
      reviewId,
      chunks: selection.chunks.length,
      analyzable: selection.analyzableFiles.length,
      skippedAsNoise: selection.skippedAsNoise.length,
      triaged: selection.triaged.length,
      reviewableCount: selection.reviewableCount,
      reviewableChangedLines: selection.reviewableChangedLines,
      skippedForBudget: selection.skippedForBudget.length,
      truncated: selection.truncatedFiles.length,
      coveredCount: selection.coveredCount,
      coveragePct: Math.round(coverageRatio(selection) * 100),
    },
    "diff selected for review",
  );

  // Computed once, right after selection, so both the bail-out path and the
  // normal-completion path below can persist the same answer to "which
  // touched files never reached the model, and why". Without this, a
  // filtered file and a genuinely-reviewed-and-clean file are indistinguishable
  // downstream — both have zero findings.
  const filteredFiles: { file: string; reason: string }[] = [
    ...selection.skippedAsNoise.map((file) => ({ file, reason: "generated, vendored, or binary" })),
    ...selection.triaged.map((t) => ({ file: t.filename, reason: describeSkipReason(t.reason) })),
    ...selection.diffUnavailable.map((file) => ({ file, reason: "diff unavailable" })),
  ];

  // Projected before any call is made, so an expensive review is visible in
  // the logs whether or not it ends up being refused.
  const costEstimate = estimateReviewCost(selection);
  log.info(
    { reviewId, ...costEstimate, capacity: REVIEW_CAPACITY },
    "projected review cost",
  );

  // The one place size stops a review outright. Everything above this line
  // is cheap; everything below it costs model tokens.
  const gate = evaluateSizeGate(selection, reviewConfig, { oversized: diff.oversized, forced });
  for (const warning of gate.warnings) {
    log.warn({ reviewId, expectedTokens: costEstimate.expectedTokens }, warning);
  }
  if (gate.bail) {
    log.warn({ reviewId, reason: gate.reason, detail: gate.detail }, "review gate tripped — no review will be run");

    await reviewsCol.updateOne(
      { pullRequestId, headSha },
      {
        $set: {
          status: "completed" as const,
          verdict: "comment" as const,
          summary: gate.detail ?? "Pull request too large to review.",
          findings: [],
          touchedFiles: diff.files.map((f) => f.filename),
          filteredFiles,
          incomplete: {
            reason: gate.reason!,
            detail: gate.detail ?? "",
            filesSeen: diff.fileCount,
            filesFiltered: selection.skippedAsNoise.length + selection.triaged.length,
            changedLines: diff.totalChangedLines,
            at: new Date(),
          },
        },
      },
    );

    try {
      const body =
        formatBailoutComment(selection, reviewConfig, gate, {
          filesSeen: diff.fileCount,
          totalChangedLines: diff.totalChangedLines,
        }) + formatConfigErrors(configErrors);
      const commentId = await postSummaryComment(githubInstallationId, owner, repo, prNumber, body);
      await reviewsCol.updateOne({ pullRequestId, headSha }, { $set: { githubCommentId: commentId } });
      log.info({ reviewId, commentId }, "posted size bail-out comment");
    } catch (postError) {
      log.error({ reviewId, err: postError }, "failed to post size bail-out comment");
    }

    // Deliberately not a job failure: the review reached a correct, final
    // decision. Retrying would just re-post the same comment.
    return;
  }

  // Created early (before the slow AI call) so the PR shows "review in
  // progress" quickly. Reused across retries via the stored checkRunId
  // instead of creating a duplicate check run on every attempt.
  let checkRunId = existingReview?.checkRunId;
  if (checkRunId === undefined) {
    try {
      checkRunId = await createCheckRun(githubInstallationId, owner, repo, headSha);
      await reviewsCol.updateOne({ pullRequestId, headSha }, { $set: { checkRunId } });
      log.info({ reviewId, checkRunId }, "check run created");
    } catch (checkError) {
      log.warn({ reviewId, err: checkError }, "failed to create check run (checks:write permission missing?)");
    }
  }

  // Both views of the diff come from one parse. `lineContents` is the richer
  // of the two and its keys ARE the commentable lines (see walkPatches), so
  // deriving the second costs nothing and cannot disagree with the first.
  // It's captured here, up front, rather than where it is first read further
  // down: the dashboard renders long after the diff is gone, and needs the
  // "before" side of every committable suggestion to show the change the way
  // GitHub does.
  const lineContents = computeLineContents(diff.files);
  const commentableLines = new Map([...lineContents].map(([file, lines]) => [file, new Set(lines.keys())]));

  const touchedFiles = new Set(diff.files.map((file) => file.filename));
  const carriedForwardFindings = filterCarriedForwardFindings(previousReview?.findings ?? [], touchedFiles);

  let aiResult: { verdict: ReviewResult["verdict"]; summary: string; findings: FindingDoc[] };
  let staticFindings: FindingDoc[];
  // Tracked across every branch, including the ones that spend nothing, so a
  // review that made zero provider calls records that as a fact rather than
  // as a missing field.
  let reviewUsage: TokenUsage = EMPTY_USAGE;
  let unreviewedFiles: string[] = [];
  const riskFiles = selection.analyzableFiles.map((file) => ({ file: file.filename, reasons: riskReasons(file) }))
    .filter((file) => file.reasons.length > 0);

  if (selection.chunks.length === 0 && !(baselineSha && diff.fileCount === 0)) {
    // Nothing with a reviewable text patch survived selection — a PR of only
    // binaries, images, or lockfiles. Static analysis has nothing to read
    // either, so this completes as a real (empty) review rather than a
    // failure: there is genuinely nothing to say about it.
    log.info({ reviewId, skippedAsNoise: selection.skippedAsNoise.length }, "no reviewable text changes");
    aiResult = {
      verdict: "approve",
      summary: "No reviewable code changes in this pull request (only generated, binary, or vendored files changed).",
      findings: [],
    };
    staticFindings = [];
  } else if (baselineSha && previousReview && diff.fileCount === 0) {
    // The incremental delta is empty (e.g. an empty merge commit) — nothing
    // to send the model, so reuse the previous review's verdict/summary
    // rather than spending an AI call on zero changed files.
    log.info({ reviewId }, "incremental diff is empty, reusing previous review's verdict/summary");
    aiResult = {
      verdict: previousReview.verdict ?? "comment",
      summary: previousReview.summary ?? "No code changes since the last review.",
      findings: [],
    };
    staticFindings = [];
  } else if (existingReview?.aiCheckpoint) {
    // A previous attempt at THIS head commit already finished the model work
    // and then failed somewhere after it. Reuse that output rather than
    // re-spending the whole token budget — the diff is byte-identical, so a
    // second generation would buy nothing but cost everything.
    const checkpoint = existingReview.aiCheckpoint;
    unreviewedFiles = checkpoint.unreviewedFiles;
    log.info(
      { reviewId, checkpointedAt: checkpoint.at, calls: checkpoint.calls, totalTokens: checkpoint.totalTokens },
      "reusing the model output from a previous attempt — skipping generation",
    );
    aiResult = {
      verdict: checkpoint.verdict,
      summary: `${checkpoint.summary}${formatCoverageNote(selection, checkpoint.unreviewedFiles)}`,
      findings: checkpoint.findings,
    };
    staticFindings = checkpoint.staticFindings;
    // Reported so this review's metrics still show what it cost, but NOT
    // re-added to the global counter: those tokens were already recorded by
    // the attempt that actually spent them.
    reviewUsage = {
      inputTokens: checkpoint.inputTokens,
      outputTokens: checkpoint.outputTokens,
      totalTokens: checkpoint.totalTokens,
      calls: checkpoint.calls,
    };
  } else {
    log.info({ reviewId }, "running static analysis, then calling the model...");

    // Not run inside the same Promise.all as the AI call below: the AI call
    // now wants static analysis's findings as context (see generateReview's
    // staticFindings option), so it has to start after they're at least
    // partially available. Bounded by STATIC_ANALYSIS_CONTEXT_TIMEOUT_MS below
    // rather than awaited unconditionally, so a slow static-analysis run
    // degrades gracefully instead of blocking the AI call indefinitely.
    // Static analysis reads analyzableFiles, NOT the chunk selection: linters
    // have no context window and no per-token cost, so the AI's size budget
    // must never shrink their coverage. A file the AI had no room for still
    // gets linted, which is what keeps an oversized PR from going completely
    // unexamined.
    const staticFindingsPromise = runStaticAnalysis(githubInstallationId, owner, repo, headSha, selection.analyzableFiles, commentableLines, log).catch(
      (staticError) => {
        log.warn({ reviewId, err: staticError }, "static analysis stage failed, continuing without it");
        return [] as FindingDoc[];
      },
    );

    const staticFindingsForContext = await Promise.race([
      staticFindingsPromise,
      new Promise<FindingDoc[]>((resolve) => setTimeout(() => resolve([]), STATIC_ANALYSIS_CONTEXT_TIMEOUT_MS)),
    ]);

    // Two sensitive files at most, pinned to the reviewed SHA. Shared file cache
    // also serves static analysis and verification; no extra model round.
    const riskContextSignal = AbortSignal.timeout(3000);
    const riskContext = (await Promise.all(riskFiles.slice(0, 2).map(async (risk) => {
      const file = selection.analyzableFiles.find((item) => item.filename === risk.file)!;
      const firstLine = Number(file.patch?.match(/@@ -\d+(?:,\d+)? \+(\d+)/)?.[1] ?? 1);
      const content = await getFileContent(githubInstallationId, owner, repo, risk.file, headSha, { signal: riskContextSignal }).catch(() => undefined);
      return `${risk.file}: ${risk.reasons.join(", ")}\n${content === undefined ? "Surrounding code unavailable." : codeWindow(content, firstLine, 25, 3000)}`;
    }))).join("\n\n");
    const generated = await generateChunkedReview(
      selection.chunks.map((chunk) => chunk.files),
      {
        customInstructions: repoConfig?.customInstructions,
        disabledCategories: mergedDisabledCategories,
        disabledSeverities: effectiveDisabledSeverities,
        staticFindings: staticFindingsForContext,
        prTitle,
        prBody: prBody ?? undefined,
        repoContext: { installationId: githubInstallationId, owner, repo, ref: headSha },
        riskContext,
      },
    );
    // Step 4 of the large-PR plan: whatever the budget couldn't cover is
    // stated in the posted comment. A partial review that reads like a full
    // one is worse than no review, because "no issues found" gets taken as a
    // statement about the whole PR.
    aiResult = {
      ...generated,
      summary: `${generated.summary}${formatCoverageNote(selection, generated.unreviewedFiles)}`,
    };
    if (generated.unreviewedFiles.length > 0) {
      log.warn(
        { reviewId, unreviewedFiles: generated.unreviewedFiles },
        "some files could not be reviewed even after chunk splitting",
      );
    }

    reviewUsage = generated.usage;
    unreviewedFiles = generated.unreviewedFiles;

    // Token accounting is a side metric, not part of the review — a failure
    // writing it must never fail an otherwise-good review, so it's logged and
    // swallowed rather than thrown.
    await recordUsage(generated.usage).catch((usageError) => {
      log.warn({ reviewId, err: usageError }, "failed to record token usage");
    });
    log.info({ reviewId, usage: generated.usage }, "ai token usage");

    // Always wait for the real result for the final merged findings list —
    // posting/gating correctness is unaffected even when the race above timed
    // out and the AI call proceeded without seeing static findings that time.
    staticFindings = await staticFindingsPromise;
    log.info(
      { reviewId, aiFindings: aiResult.findings.length, staticFindings: staticFindings.length },
      "model + static analysis returned",
    );

    // Persisted here, immediately after the expensive work and before
    // anything else that can throw. Everything below this line — the review
    // write, the lastReviewedSha write, posting, the check run — can now fail
    // and be retried without re-spending a single token. The checkpoint
    // stores the RAW model output: the coverage note is re-derived from this
    // attempt's own selection, so a reused checkpoint still reports the
    // correct gaps.
    await reviewsCol
      .updateOne(
        { pullRequestId, headSha },
        {
          $set: {
            aiCheckpoint: {
              verdict: generated.verdict,
              summary: generated.summary,
              findings: generated.findings,
              unreviewedFiles: generated.unreviewedFiles,
              staticFindings,
              inputTokens: generated.usage.inputTokens,
              outputTokens: generated.usage.outputTokens,
              totalTokens: generated.usage.totalTokens,
              calls: generated.usage.calls,
              at: new Date(),
            },
          },
        },
      )
      .catch((checkpointError) => {
        // Not fatal: the review continues and posts normally. It only means a
        // later failure would have to re-spend the budget, which is the
        // behaviour we had before this existed.
        log.warn({ reviewId, err: checkpointError }, "failed to checkpoint model output — a retry would re-run generation");
      });
  }

  const withOriginalLine = (finding: FindingDoc): FindingDoc => {
    if (finding.line === undefined || !finding.suggestion) return finding;
    if (!looksLikeCleanCodeSuggestion(finding.suggestion)) return finding;
    const fileLines = lineContents.get(finding.file);
    const originalLine = fileLines?.get(finding.line);
    if (originalLine === undefined) return finding;
    // Captured together so the two can never disagree about which commit they
    // describe: a finding either has both halves of the "before" side or,
    // when the line wasn't in this diff, neither.
    return { ...finding, originalLine, originalContext: computeContextLines(fileLines, finding.line) };
  };

  const keepsCategory = categoryFilter(repoConfig?.disabledCategories, reviewConfig.disabledCategories);
  // Severity is dashboard-only — .prsentry.yaml has no equivalent key — so
  // unlike keepsCategory this has a single source.
  const keepsSeverity = severityFilter(effectiveDisabledSeverities);
  const keepsFinding = (finding: FindingDoc) => keepsCategory(finding) && keepsSeverity(finding);

  let allFindings = dedupeFindings([
    // Carried-forward findings are deliberately NOT re-mapped: their line
    // numbers were resolved against an earlier commit's diff, so looking
    // them up in this one would pair a suggestion with whatever text now
    // occupies that number — a confidently wrong "before" line is worse
    // than none, and they keep whatever originalLine they were stored with.
    ...carriedForwardFindings,
    ...aiResult.findings.map(withOriginalLine),
    // Not mapped: no scanner in static-analysis.ts ever sets `suggestion`,
    // so withOriginalLine would return every one of these unchanged. Mapping
    // them anyway would imply static findings can carry a committable
    // suggestion, which they cannot.
    ...staticFindings,
  ].filter(keepsFinding));

  const currentFindings = allFindings.filter((finding) => touchedFiles.has(finding.file));
  let verification = existingReview?.verificationCheckpoint;
  if (!verification && verificationCandidates(currentFindings).length > 0) {
    const reservation = { ...skippedVerification(currentFindings, "Verification interrupted; not eligible to block."), state: "reserved" as const };
    // Mandatory durable reservation. A crash or lost completion write must not
    // buy a second verification call on BullMQ retry for this PR/head pair.
    const reserved = await reviewsCol.updateOne({ pullRequestId, headSha }, { $set: { verificationCheckpoint: reservation } });
    if (reserved.matchedCount !== 1) throw new Error("Could not reserve verification budget");
    let proofBaseSha: string | undefined;
    if (proofImage()) {
      // Resolve the actual PR merge base, not the previous reviewed push: a
      // failing test should demonstrate a regression introduced by this PR.
      try {
        const octokit = await getInstallationOctokit(githubInstallationId);
        const signal = AbortSignal.timeout(5000);
        const { data: pr } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: prNumber, request: { signal } });
        if (pr.head.sha === headSha) {
          const { data: comparison } = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", { owner, repo, basehead: `${pr.base.sha}...${headSha}`, request: { signal } });
          proofBaseSha = comparison.merge_base_commit.sha;
        }
      } catch (err) { log.warn({ err }, "test proof base unavailable; retaining AI assessment only"); }
    }
    verification = await verifyBlockingFindings(currentFindings, diff.files, { installationId: githubInstallationId, owner, repo, ref: headSha }, proofBaseSha);
    await recordUsage(verification.usage, false).catch((err) => log.warn({ err }, "failed to record verification usage"));
    await reviewsCol.updateOne({ pullRequestId, headSha }, { $set: { verificationCheckpoint: verification } });
  }
  if (verification) {
    allFindings = dedupeFindings([
      ...allFindings.filter((finding) => !touchedFiles.has(finding.file)),
      ...verification.findings.filter(keepsFinding),
    ]);
    reviewUsage = addUsage(reviewUsage, verification.usage);
  }
  const blocking = allFindings.filter((finding) => canBlock(finding) && meetsThreshold(finding.severity, resolveGateThreshold(repoConfig)));
  const previousVerdict = aiResult.verdict;
  aiResult.verdict = blocking.length ? "request_changes" : allFindings.length || previousVerdict !== "approve" ? "comment" : "approve";
  if (verification || previousVerdict === "request_changes") {
    // The first-pass prose can contain a rejected accusation or obsolete merge
    // recommendation. Rebuild it from assessed findings, with no additional call.
    aiResult.summary = `Reviewed ${selection.coveredCount} file(s). ${blocking.length ? `${blocking.length} high/critical finding(s) passed AI evidence assessment and meet the repository's blocking threshold.` : "No findings passed the blocking policy."}\n\n` +
      `Retained ${allFindings.length} finding(s)${verification ? `; rejected ${verification.rejected.length} after assessment` : ""}. AI assessment is not test-backed proof. Unchecked findings are advisory.\n\n` +
      `*Current review: ${aiResult.verdict === "request_changes" ? "REQUEST CHANGES" : aiResult.verdict.toUpperCase()}.*` +
      formatCoverageNote(selection, unreviewedFiles);
  }

  // Anything the last review flagged on a file this push edited, that this
  // review no longer reports, is called out as fixed — otherwise a review
  // that says nothing about a resolved issue is indistinguishable from one
  // that forgot about it.
  const resolvedFindings = findResolvedFindings(
    previousReview?.findings ?? [],
    new Set(selection.chunks.flatMap((chunk) => chunk.files.map((file) => file.filename)).filter((file) => !unreviewedFiles.includes(file))),
    [...allFindings, ...(verification?.rejected ?? [])],
  ).filter(keepsFinding);
  if (resolvedFindings.length > 0) {
    log.info({ reviewId, resolved: resolvedFindings.length }, "previous findings appear resolved");
  }
  const summaryWithResolved = `${aiResult.summary}${formatResolvedNote(resolvedFindings)}`;

  // Preserve feedback written during this attempt. A concurrent array rewrite
  // makes this write retry instead of silently discarding someone's rating.
  const storedBeforePublish = await reviewsCol.findOne({ pullRequestId, headSha });
  if (!storedBeforePublish) throw new Error("Review disappeared before publication");
  const savedReview = await reviewsCol.updateOne(
    { pullRequestId, headSha, findings: storedBeforePublish.findings },
    {
      $set: {
        status: "completed",
        verdict: aiResult.verdict,
        summary: summaryWithResolved,
        findings: withPersistedCommentIds(allFindings, storedBeforePublish.findings),
        touchedFiles: Array.from(touchedFiles),
        filteredFiles,
        riskFiles,
      },
    },
  );
  if (savedReview.matchedCount !== 1) throw new Error("Review changed during publication; retrying without regenerating");

  // Records how far this PR has actually been reviewed, so the next push's
  // incremental diff starts from here.
  if (ObjectId.isValid(pullRequestId)) {
    const pullRequestsCol = await pullRequests();
    await pullRequestsCol.updateOne(
      { _id: new ObjectId(pullRequestId) as unknown as string },
      { $set: { lastReviewedSha: headSha } },
    );
  }

  const postingThreshold = resolvePostingThreshold(repoConfig);
  const postableFindings = allFindings.filter((f) => meetsThreshold(f.severity, postingThreshold));

  // Only genuinely new findings from this delta get shown in the comment
  // text (both the summary and inline comments) — carried-forward findings
  // are still fully tracked in allFindings for the stored review doc and the
  // check-run gate (a stale critical bug must still fail the check even if
  // untouched this round), they just aren't re-announced in the comment
  // every time nothing changed about them. On a first-ever review (no
  // previousReview), touchedFiles covers the whole diff, so this is a no-op
  // filter and every postable finding is shown, same as before.
  const newPostableFindings = postableFindings.filter((f) => touchedFiles.has(f.file));

  // Mapped before the comment is rendered, because the inline cap decides
  // what the comment body has to carry: anything that loses a slot has to
  // appear in the collapsed section instead, so no finding is dropped just
  // because it didn't fit inline.
  const { mappable, unmappable } = mapFindingsToInlineComments(newPostableFindings, commentableLines);
  const { posted, overflow } = capInlineComments(mappable);
  const overflowKeys = new Set(overflow.map((f) => `${f.file}::${f.line}::${f.title}`));

  try {
    const commentBody =
      formatSummaryComment({
        summary: summaryWithResolved,
        findings: newPostableFindings.filter((f) => !overflowKeys.has(`${f.file}::${f.line}::${f.title}`)),
        overflowFindings: overflow,
      }) + formatConfigErrors(configErrors);

    let commentId: number;
    if (previousReview?.githubCommentId) {
      // Edit the existing comment in place rather than posting a new one —
      // keeps a PR with many small pushes to one up-to-date comment instead
      // of a new comment spammed on every push.
      await updateSummaryComment(githubInstallationId, owner, repo, previousReview.githubCommentId, commentBody);
      commentId = previousReview.githubCommentId;
      log.info({ reviewId, commentId }, "updated summary comment in place");
    } else {
      commentId = await postSummaryComment(githubInstallationId, owner, repo, prNumber, commentBody);
      log.info({ reviewId, commentId }, "posted summary comment");
    }
    await reviewsCol.updateOne({ pullRequestId, headSha }, { $set: { githubCommentId: commentId } });

    log.info(
      {
        reviewId,
        mappable: mappable.length,
        unmappable: unmappable.length,
        postedInline: posted.length,
        overflowToSummary: overflow.length,
      },
      "inline mapping",
    );

    // A retry resumes from `aiCheckpoint` and arrives here with identical
    // findings; without this guard it posts the whole review a second time
    // (see ReviewDoc.inlineCommentsPostedAt). Read from the row rather than
    // `existingReview`, which was loaded before this attempt did any work.
    const alreadyPosted = await reviewsCol.findOne(
      { pullRequestId, headSha },
      { projection: { inlineCommentsPostedAt: 1 } },
    );

    if (posted.length > 0 && alreadyPosted?.inlineCommentsPostedAt) {
      log.info(
        { reviewId, count: posted.length, postedAt: alreadyPosted.inlineCommentsPostedAt },
        "inline comments already posted for this head SHA — skipping",
      );
    } else if (posted.length > 0) {
      const postedComments = await postInlineReview(githubInstallationId, owner, repo, prNumber, headSha, posted);
      log.info({ reviewId, count: posted.length, mapped: postedComments.length }, "posted inline review");

      // Written immediately after the call returns, before the finding
      // bookkeeping below — a failure there must not let a retry re-post
      // comments that are already on the PR.
      await reviewsCol.updateOne({ pullRequestId, headSha }, { $set: { inlineCommentsPostedAt: new Date() } });

      // Persist which GitHub comment each finding landed as, so a developer
      // replying in that thread can be answered about the right finding (see
      // reply-pipeline.ts). Matched by object identity: `posted` carries the
      // very same FindingDoc references that are in `allFindings`.
      if (postedComments.length > 0) {
        const commentIdByFinding = new Map<FindingDoc, number>(
          postedComments.map((p) => [p.comment.finding, p.commentId]),
        );
        const findingsWithCommentIds = allFindings.map((finding) => {
          const githubCommentId = commentIdByFinding.get(finding);
          return githubCommentId === undefined ? finding : { ...finding, githubCommentId };
        });
        await reviewsCol.updateOne({ pullRequestId, headSha }, { $set: { findings: findingsWithCommentIds } });
      }
    }
  } catch (postError) {
    log.error({ reviewId, err: postError }, "posting to GitHub FAILED");
  }

  if (checkRunId !== undefined) {
    try {
      const gateThreshold = resolveGateThreshold(repoConfig);
      const conclusion = computeConclusion(aiResult.verdict, allFindings, gateThreshold);
      await completeCheckRun(githubInstallationId, owner, repo, checkRunId, {
        conclusion,
        title: conclusionTitle(conclusion),
        summary: buildCheckSummary(allFindings),
      });
      log.info({ reviewId, checkRunId, conclusion }, "check run completed");
    } catch (checkError) {
      log.warn({ reviewId, err: checkError }, "failed to complete check run");
    }
  }

  const metrics = {
    inputTokens: reviewUsage.inputTokens,
    outputTokens: reviewUsage.outputTokens,
    totalTokens: reviewUsage.totalTokens,
    calls: reviewUsage.calls,
    model: process.env.NVIDIA_MODEL ?? DEFAULT_MODEL,
    durationMs: Date.now() - startedAt,
    filesSeen: diff.fileCount,
    filesFiltered: selection.skippedAsNoise.length + selection.triaged.length,
    filesReviewed: selection.analyzableFiles.length - selection.skippedForBudget.length,
    findingsProduced: allFindings.length,
    commentsPosted: posted.length,
    estimatedCostUsd: estimateCost(reviewUsage),
  };

  // Written after posting so `commentsPosted` reflects what actually went
  // out. Like the usage counter, a failure here must never fail a review
  // that already succeeded.
  await reviewsCol
    .updateOne({ pullRequestId, headSha }, { $set: { metrics } })
    .catch((metricsError) => log.warn({ reviewId, err: metricsError }, "failed to record review metrics"));

  // The ceiling alert. Logged at error level so it reaches whatever watches
  // logs, rather than only being visible to someone who thinks to look at
  // the dashboard.
  if (metrics.totalTokens > REVIEW_TOKEN_CEILING) {
    log.error(
      { reviewId, prNumber, ...metrics, ceiling: REVIEW_TOKEN_CEILING },
      "review exceeded the per-review token ceiling",
    );
  } else {
    log.info({ reviewId, ...metrics }, "review metrics");
  }
}
