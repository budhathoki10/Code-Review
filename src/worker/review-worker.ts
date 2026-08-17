import "dotenv/config";
import { Worker } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { REVIEW_QUEUE_NAME, type ReviewJobData } from "@/lib/queue/review-queue";
import { runReviewPipeline } from "@/lib/review/pipeline";
import { reviews } from "@/lib/db/collections";

const worker = new Worker<ReviewJobData>(
  REVIEW_QUEUE_NAME,
  async (job) => {
    console.log(`[worker] job=${job.id} attempt=${job.attemptsMade + 1} starting`);
    await runReviewPipeline(job.data);
  },
  { connection: getRedisConnection(), concurrency: 5 },
);

worker.on("completed", (job) => {
  console.log(`[worker] job=${job.id} completed`);
});

/**
 * BullMQ fires "failed" after every failed attempt, not just the last one —
 * only mark the review doc "failed" once retries are exhausted, so a
 * transient error mid-backoff doesn't show as a dead review in the
 * dashboard while it's still going to retry.
 */
worker.on("failed", async (job, err) => {
  if (!job) return;

  const maxAttempts = job.opts.attempts ?? 1;
  console.error(`[worker] job=${job.id} attempt=${job.attemptsMade}/${maxAttempts} failed —`, err);

  if (job.attemptsMade < maxAttempts) {
    return;
  }

  const reviewsCol = await reviews();
  await reviewsCol.updateOne(
    { pullRequestId: job.data.pullRequestId, headSha: job.data.headSha },
    {
      $set: {
        status: "failed",
        summary: `Review generation failed: ${err instanceof Error ? err.message : "unknown error"}`,
      },
    },
  );
  console.error(`[worker] job=${job.id} exhausted retries — review marked failed`);
});

worker.on("error", (err) => {
  console.error("[worker] connection/worker error —", err);
});

console.log("[worker] review worker started, waiting for jobs...");
