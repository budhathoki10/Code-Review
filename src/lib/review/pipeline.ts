// this is the main heart of the code
import { ObjectId } from "mongodb";
import type { Logger } from "pino";
import { getPullRequestDiff, getIncrementalDiff, MAX_DIFF_FILES, MAX_DIFF_CHARS, type PullRequestDiff } from "@/lib/github/diff";
import { generateReview, type ReviewResult } from "@/lib/ai/review";
import { formatSummaryComment, postSummaryComment, updateSummaryComment } from "@/lib/github/comment";
import { computeCommentableLines, mapFindingsToInlineComments } from "@/lib/github/diff-lines";
import { postInlineReview } from "@/lib/github/inline-comments";
import { createCheckRun, completeCheckRun, type CheckConclusion } from "@/lib/github/checks";
import { runStaticAnalysis } from "@/lib/review/static-analysis";
import {
  reviews,
  pullRequests,
  repositories,
  type FindingDoc,
  type RepositoryDoc,
} from "@/lib/db/collections";
import type { ReviewJobData } from "@/lib/queue/review-queue";

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

function computeConclusion(
  verdict: ReviewResult["verdict"],
  findings: FindingDoc[],
  gateThreshold: FindingDoc["severity"],
): CheckConclusion {
  if (verdict === "request_changes" || findings.some((f) => meetsThreshold(f.severity, gateThreshold))) {
    return "failure";
  }
  if (verdict === "comment") return "neutral";
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
export function filterCarriedForwardFindings(previousFindings: FindingDoc[], touchedFiles: Set<string>): FindingDoc[] {
  return previousFindings.filter((f) => !touchedFiles.has(f.file));
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
 * the caller (the worker) lets BullMQ retry those. A too-large diff is a
 * permanent, non-retryable failure, so it's written straight to the review
 * doc and returned instead of thrown.
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
  const { reviewId, pullRequestId, headSha, githubInstallationId, owner, repo, prNumber, prTitle, prBody } = data;
  const reviewsCol = await reviews();

  // first finding the most recent document
  const [repoConfig, existingReview, previousReview] = await Promise.all([
    loadRepositoryConfig(pullRequestId),
    reviewsCol.findOne({ pullRequestId, headSha }),
    reviewsCol.findOne({ pullRequestId, status: "completed" }, { sort: { createdAt: -1 } }),
  ]);

  let diff: PullRequestDiff;
  // if there is previous diff then submit it to getIncrementalDiff else review normally 
  if (previousReview) {
    
    //get the head id  and pass the previous heasha and current headsha
    const incrementalDiff = await getIncrementalDiff(githubInstallationId, owner, repo, previousReview.headSha, headSha).catch(
      (incrementalError) => {
        log.warn({ reviewId, err: incrementalError }, "incremental diff failed, falling back to full PR diff");
        return null;
      },
    );
    diff = incrementalDiff ?? (await getPullRequestDiff(githubInstallationId, owner, repo, prNumber));
  } else {
    diff = await getPullRequestDiff(githubInstallationId, owner, repo, prNumber);
  }
  log.info(
    { reviewId, fileCount: diff.fileCount, chars: diff.diffText.length, incremental: Boolean(previousReview) },
    "diff fetched",
  );

  if (diff.fileCount > MAX_DIFF_FILES || diff.diffText.length > MAX_DIFF_CHARS) {
    log.info({ reviewId }, "diff too large, skipping AI call");
    await reviewsCol.updateOne(
      { pullRequestId, headSha },
      { $set: { status: "failed", summary: "PR too large to review automatically." } },
    );
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

  const commentableLines = computeCommentableLines(diff.files);

  const touchedFiles = new Set(diff.files.map((file) => file.filename));
  const carriedForwardFindings = filterCarriedForwardFindings(previousReview?.findings ?? [], touchedFiles);

  let aiResult: Pick<ReviewResult, "verdict" | "summary" | "findings">;
  let staticFindings: FindingDoc[];

  if (previousReview && diff.fileCount === 0) {
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
  } else {
    log.info({ reviewId }, "running static analysis, then calling the model...");

    // Not run inside the same Promise.all as the AI call below: the AI call
    // now wants static analysis's findings as context (see generateReview's
    // staticFindings option), so it has to start after they're at least
    // partially available. Bounded by STATIC_ANALYSIS_CONTEXT_TIMEOUT_MS below
    // rather than awaited unconditionally, so a slow static-analysis run
    // degrades gracefully instead of blocking the AI call indefinitely.
    const staticFindingsPromise = runStaticAnalysis(githubInstallationId, owner, repo, headSha, diff.files, commentableLines).catch(
      (staticError) => {
        log.warn({ reviewId, err: staticError }, "static analysis stage failed, continuing without it");
        return [] as FindingDoc[];
      },
    );

    const staticFindingsForContext = await Promise.race([
      staticFindingsPromise,
      new Promise<FindingDoc[]>((resolve) => setTimeout(() => resolve([]), STATIC_ANALYSIS_CONTEXT_TIMEOUT_MS)),
    ]);

    aiResult = await generateReview(diff.diffText, {
      customInstructions: repoConfig?.customInstructions,
      staticFindings: staticFindingsForContext,
      prTitle,
      prBody: prBody ?? undefined,
      repoContext: { installationId: githubInstallationId, owner, repo, ref: headSha },
    });

    // Always wait for the real result for the final merged findings list —
    // posting/gating correctness is unaffected even when the race above timed
    // out and the AI call proceeded without seeing static findings that time.
    staticFindings = await staticFindingsPromise;
    log.info(
      { reviewId, aiFindings: aiResult.findings.length, staticFindings: staticFindings.length },
      "model + static analysis returned",
    );
  }

  const allFindings = [...carriedForwardFindings, ...aiResult.findings, ...staticFindings];
// saves  the review in mongo db
  await reviewsCol.updateOne(
    { pullRequestId, headSha },
    {
      $set: {
        status: "completed",
        verdict: aiResult.verdict,
        summary: aiResult.summary,
        findings: allFindings,
      },
    },
  );

  const postingThreshold = resolvePostingThreshold(repoConfig);
  const postableFindings = allFindings.filter((f) => meetsThreshold(f.severity, postingThreshold));

  try {
    const commentBody = formatSummaryComment({ summary: aiResult.summary, findings: postableFindings });

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

    // Only genuinely new findings from this delta get inline comments —
    // carried-forward findings already have their original inline comments
    // sitting on the PR from the previous review's post. On a first-ever
    // review (no previousReview), touchedFiles covers the whole diff, so
    // this is a no-op filter and every postable finding still gets one.
    const newPostableFindings = postableFindings.filter((f) => touchedFiles.has(f.file));
    const { mappable, unmappable } = mapFindingsToInlineComments(newPostableFindings, commentableLines);
    log.info({ reviewId, mappable: mappable.length, unmappable: unmappable.length }, "inline mapping");

    if (mappable.length > 0) {
      await postInlineReview(githubInstallationId, owner, repo, prNumber, headSha, mappable);
      log.info({ reviewId, count: mappable.length }, "posted inline review");
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
}
