import { Worker, type WorkerOptions } from "bullmq";
import { ObjectId } from "mongodb";
import { getRedisConnection } from "@/lib/queue/connection";
import { THROTTLE_QUEUE_NAME, type ThrottleTrailerJobData } from "@/lib/queue/throttle-queue";
import { enqueueReviewJob } from "@/lib/queue/review-queue";
import { pullRequests, repositories, reviews } from "@/lib/db/collections";
import { isDuplicateKeyError } from "@/lib/db/mongo-errors";
import { logger } from "@/lib/logger";

/**
 * Processes the trailing job scheduled by the webhook handler whenever a
 * push was debounced by the per-PR throttle window (see pr-throttle.ts).
 * Reads whatever the PR's head commit is *now* — not whatever it was when
 * the trailer was scheduled, since more pushes may have landed inside the
 * same window — and reviews that one commit, exactly like a fresh webhook
 * delivery would. The `reviews` collection's unique (pullRequestId, headSha)
 * index means this is a safe no-op if that head commit was already covered
 * (e.g. it was the window's own leading, immediately-reviewed push).
 */
export function createThrottleTrailerWorker(options: Partial<WorkerOptions> = {}): Worker<ThrottleTrailerJobData> {
  const worker = new Worker<ThrottleTrailerJobData>(
    THROTTLE_QUEUE_NAME,
    async (job) => {
      const log = logger.child({ requestId: job.data.requestId, jobId: job.id });
      const { pullRequestId } = job.data;

      if (!ObjectId.isValid(pullRequestId)) {
        log.warn({ pullRequestId }, "throttle trailer: invalid pull request id, skipping");
        return;
      }

      const pullRequestsCol = await pullRequests();
      const pullRequestDoc = await pullRequestsCol.findOne({
        _id: new ObjectId(pullRequestId) as unknown as string,
      });
      if (!pullRequestDoc) {
        log.warn("throttle trailer: pull request no longer exists, skipping");
        return;
      }

      if (!ObjectId.isValid(pullRequestDoc.repositoryId)) {
        log.warn("throttle trailer: pull request has no valid repository, skipping");
        return;
      }

      const repositoriesCol = await repositories();
      const repositoryDoc = await repositoriesCol.findOne({
        _id: new ObjectId(pullRequestDoc.repositoryId) as unknown as string,
      });
      if (!repositoryDoc) {
        log.warn("throttle trailer: repository no longer exists, skipping");
        return;
      }

      const [owner, repo] = repositoryDoc.fullName.split("/");
      const headSha = pullRequestDoc.headSha;

      const reviewsCol = await reviews();
      let reviewId: string;
      try {
        const insertResult = await reviewsCol.insertOne({
          pullRequestId,
          headSha,
          status: "pending",
          findings: [],
          createdAt: new Date(),
        });
        reviewId = String(insertResult.insertedId);
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          log.info({ headSha }, "throttle trailer: head commit already reviewed, nothing to do");
          return;
        }
        throw error;
      }

      await enqueueReviewJob({
        reviewId,
        pullRequestId,
        headSha,
        githubInstallationId: repositoryDoc.githubInstallationId,
        owner,
        repo,
        prNumber: pullRequestDoc.githubPrNumber,
        requestId: job.data.requestId,
        prTitle: pullRequestDoc.title,
        prBody: pullRequestDoc.body,
      });
      log.info({ headSha }, "throttle trailer: queued review for latest head commit");
    },
    {
      connection: getRedisConnection(),
      concurrency: 5,
      ...options,
    },
  );

  worker.on("error", (err) => {
    logger.error({ err }, "throttle trailer worker connection/process error");
  });

  return worker;
}
