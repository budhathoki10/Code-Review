import { ObjectId } from "mongodb";
import type { Logger } from "pino";
import { getPullRequestDiff, MAX_DIFF_FILES, MAX_DIFF_CHARS } from "@/lib/github/diff";
import { generateReview, type ReviewResult } from "@/lib/ai/review";
import { formatSummaryComment, postSummaryComment } from "@/lib/github/comment";
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

function buildCheckSummary(findings: FindingDoc[]): string {
  if (findings.length === 0) return "No issues found.";
  const bySeverity = SEVERITY_ORDER.filter((severity) => findings.some((f) => f.severity === severity))
    .reverse()
    .map((severity) => `${findings.filter((f) => f.severity === severity).length} ${severity}`)
    .join(", ");
  return `${findings.length} finding(s) — ${bySeverity}.`;
}

/**
 * The Phase 2–6 pipeline (fetch diff → static analysis + AI in parallel →
 * post comment → inline comments → check run), run by the BullMQ worker for
 * a single job. Diff fetch and AI generation failures are left to throw —
 * the caller (the worker) lets BullMQ retry those. A too-large diff is a
 * permanent, non-retryable failure, so it's written straight to the review
 * doc and returned instead of thrown.
 *
 * Posting to GitHub (summary comment, inline comments, check run) is
 * intentionally isolated in its own try/catch blocks: the review is already
 * generated and valid in our own dashboard regardless of whether publishing
 * it back to GitHub also succeeds, so a posting failure is logged but never
 * fails the job/retries the whole pipeline.
 */
export async function runReviewPipeline(data: ReviewJobData, log: Logger): Promise<void> {
  const { reviewId, pullRequestId, headSha, githubInstallationId, owner, repo, prNumber } = data;
  const reviewsCol = await reviews();

  const [repoConfig, existingReview] = await Promise.all([
    loadRepositoryConfig(pullRequestId),
    reviewsCol.findOne({ pullRequestId, headSha }),
  ]);

  const diff = await getPullRequestDiff(githubInstallationId, owner, repo, prNumber);
  log.info({ reviewId, fileCount: diff.fileCount, chars: diff.diffText.length }, "diff fetched");

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

  log.info({ reviewId }, "calling the model and running static analysis...");
  const [aiResult, staticFindings] = await Promise.all([
    generateReview(diff.diffText, { customInstructions: repoConfig?.customInstructions }),
    runStaticAnalysis(githubInstallationId, owner, repo, headSha, diff.files, commentableLines).catch(
      (staticError) => {
        log.warn({ reviewId, err: staticError }, "static analysis stage failed, continuing without it");
        return [] as FindingDoc[];
      },
    ),
  ]);
  log.info(
    { reviewId, aiFindings: aiResult.findings.length, staticFindings: staticFindings.length },
    "model + static analysis returned",
  );

  const allFindings = [...aiResult.findings, ...staticFindings];

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
    const commentId = await postSummaryComment(githubInstallationId, owner, repo, prNumber, commentBody);
    log.info({ reviewId, commentId }, "posted summary comment");
    await reviewsCol.updateOne({ pullRequestId, headSha }, { $set: { githubCommentId: commentId } });

    const { mappable, unmappable } = mapFindingsToInlineComments(postableFindings, commentableLines);
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
