import { getPullRequestDiff, MAX_DIFF_FILES, MAX_DIFF_CHARS } from "@/lib/github/diff";
import { generateReview } from "@/lib/ai/review";
import { formatSummaryComment, postSummaryComment } from "@/lib/github/comment";
import { computeCommentableLines, mapFindingsToInlineComments } from "@/lib/github/diff-lines";
import { postInlineReview } from "@/lib/github/inline-comments";
import { reviews } from "@/lib/db/collections";
import type { ReviewJobData } from "@/lib/queue/review-queue";

/**
 * The Phase 2–4 pipeline (fetch diff → AI → post comment → inline comments),
 * run by the BullMQ worker for a single job. Diff fetch and AI generation
 * failures are left to throw — the caller (the worker) lets BullMQ retry
 * those. A too-large diff is a permanent, non-retryable failure, so it's
 * written straight to the review doc and returned instead of thrown.
 *
 * Posting to GitHub is intentionally a separate try/catch: the review is
 * already generated and valid in our own dashboard regardless of whether
 * publishing it back to GitHub also succeeds, so a posting failure is
 * logged but never fails the job/retries the whole pipeline.
 */
export async function runReviewPipeline(data: ReviewJobData): Promise<void> {
  const { reviewId, pullRequestId, headSha, githubInstallationId, owner, repo, prNumber } = data;
  const reviewsCol = await reviews();

  const diff = await getPullRequestDiff(githubInstallationId, owner, repo, prNumber);
  console.log(`[review ${reviewId}] diff fetched — ${diff.fileCount} files, ${diff.diffText.length} chars`);

  if (diff.fileCount > MAX_DIFF_FILES || diff.diffText.length > MAX_DIFF_CHARS) {
    console.log(`[review ${reviewId}] diff too large, skipping AI call`);
    await reviewsCol.updateOne(
      { pullRequestId, headSha },
      { $set: { status: "failed", summary: "PR too large to review automatically." } },
    );
    return;
  }

  console.log(`[review ${reviewId}] calling the model...`);
  const result = await generateReview(diff.diffText);
  console.log(`[review ${reviewId}] model returned ${result.findings.length} finding(s)`);

  await reviewsCol.updateOne(
    { pullRequestId, headSha },
    {
      $set: {
        status: "completed",
        verdict: result.verdict,
        summary: result.summary,
        findings: result.findings,
      },
    },
  );

  try {
    const commentBody = formatSummaryComment({ summary: result.summary, findings: result.findings });
    const commentId = await postSummaryComment(githubInstallationId, owner, repo, prNumber, commentBody);
    console.log(`[review ${reviewId}] posted summary comment id=${commentId}`);
    await reviewsCol.updateOne({ pullRequestId, headSha }, { $set: { githubCommentId: commentId } });

    const commentableLines = computeCommentableLines(diff.files);
    const { mappable, unmappable } = mapFindingsToInlineComments(result.findings, commentableLines);
    console.log(`[review ${reviewId}] inline mapping — ${mappable.length} mappable, ${unmappable.length} unmappable`);

    if (mappable.length > 0) {
      await postInlineReview(githubInstallationId, owner, repo, prNumber, headSha, mappable);
      console.log(`[review ${reviewId}] posted inline review with ${mappable.length} comment(s)`);
    }
  } catch (postError) {
    console.log(`[review ${reviewId}] posting to GitHub FAILED —`, postError);
  }
}
