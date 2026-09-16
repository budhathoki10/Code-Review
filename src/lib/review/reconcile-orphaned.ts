import { ObjectId } from "mongodb";
import type { Queue } from "bullmq";
import { pullRequests, repositories, reviews } from "@/lib/db/collections";
import { completeCheckRun } from "@/lib/github/checks";
import type { ReviewJobData } from "@/lib/queue/review-queue";
import { logger } from "@/lib/logger";
import { envNumber } from "@/lib/env";

/**
 * A review can be left `status: "pending"` forever if its BullMQ job
 * disappears without ever going through the worker's own "failed" handler
 * (see review-worker-factory.ts) — e.g. the worker process is killed in the
 * narrow window between BullMQ removing the job (`removeOnFail: true`, see
 * review-queue.ts) and that handler finishing its Mongo/GitHub writes. Once
 * the job is gone, nothing will ever pick the review back up: it sits
 * `pending` with its GitHub check run stuck "in progress" indefinitely.
 *
 * Run this on a schedule (the cron sweep and the long-running worker both
 * call it) to close out anything left behind. `jobId` is deterministic
 * (`<pullRequestId>-<headSha>`, see enqueueReviewJob), so a pending review
 * with no matching job anywhere in the queue — active, waiting, or delayed —
 * has nothing left that will ever finish it. A review whose job still
 * exists is left untouched; it may legitimately still be working through a
 * large PR one checkpointed chunk at a time.
 */
const MIN_AGE_MS = envNumber("REVIEW_RECONCILE_MIN_AGE_MS", 10 * 60_000);

const ORPHANED_MESSAGE =
  "The review's worker job disappeared before finishing (the worker likely crashed or restarted mid-review). Nothing here says anything about the code — push a commit, or re-open the pull request, to run it again.";

export async function reconcileOrphanedReviews(queue: Queue<ReviewJobData>): Promise<{ reconciled: number }> {
  const reviewsCol = await reviews();
  const cutoff = new Date(Date.now() - MIN_AGE_MS);
  const stale = await reviewsCol.find({ status: "pending", createdAt: { $lte: cutoff } }).toArray();

  let reconciled = 0;
  for (const review of stale) {
    const jobId = `${review.pullRequestId}-${review.headSha}`;
    const job = await queue.getJob(jobId);
    if (job) continue;

    const log = logger.child({ reviewId: review._id, pullRequestId: review.pullRequestId, headSha: review.headSha });

    await reviewsCol.updateOne(
      { _id: review._id },
      {
        $set: {
          status: "failed",
          summary: "Review generation failed: worker job lost before completion",
          error: {
            message: "orphaned: no matching job in the review queue while the review was still pending",
            attempts: 0,
            failedAt: new Date(),
          },
        },
      },
    );
    reconciled += 1;
    log.warn("reconciled an orphaned pending review — marked failed");

    if (review.checkRunId === undefined || review._id === undefined || !ObjectId.isValid(review.pullRequestId)) continue;

    const pullRequestDoc = await (await pullRequests()).findOne({ _id: new ObjectId(review.pullRequestId) as unknown as string });
    if (!pullRequestDoc || !ObjectId.isValid(pullRequestDoc.repositoryId)) continue;

    const repositoryDoc = await (await repositories()).findOne({ _id: new ObjectId(pullRequestDoc.repositoryId) as unknown as string });
    if (!repositoryDoc) continue;

    const [owner, repo] = repositoryDoc.fullName.split("/");
    try {
      await completeCheckRun(repositoryDoc.githubInstallationId, owner, repo, review.checkRunId, {
        conclusion: "neutral",
        title: "Review did not complete",
        summary: ORPHANED_MESSAGE,
      });
    } catch (err) {
      // Best effort, same as the worker's own "failed" handler: the review
      // is already recorded as failed, and a GitHub outage here must not
      // stop the rest of the sweep.
      log.error({ err, checkRunId: review.checkRunId }, "could not close the check run for an orphaned review");
    }
  }

  return { reconciled };
}
