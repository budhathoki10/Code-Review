import "dotenv/config";
import { Worker } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { REVIEW_QUEUE_NAME, type ReviewJobData } from "@/lib/queue/review-queue";
import { runReviewPipeline } from "@/lib/review/pipeline";
import { reviews } from "@/lib/db/collections";
import { logger } from "@/lib/logger";

const AI_RATE_LIMIT_MAX = Number(process.env.AI_RATE_LIMIT_MAX ?? 10);
const AI_RATE_LIMIT_DURATION_MS = Number(process.env.AI_RATE_LIMIT_DURATION_MS ?? 60_000);

const worker = new Worker<ReviewJobData>(
  REVIEW_QUEUE_NAME,
  async (job) => {
    const log = logger.child({ requestId: job.data.requestId, jobId: job.id });
    log.info({ attempt: job.attemptsMade + 1 }, "job starting");
    await runReviewPipeline(job.data, log);
  },
  {
    connection: getRedisConnection(),
    concurrency: 5,
    // Bounds how often this process calls the AI provider, independent of
    // job concurrency — avoids tripping the provider's own rate limits.
    limiter: { max: AI_RATE_LIMIT_MAX, duration: AI_RATE_LIMIT_DURATION_MS },
  },
);

worker.on("completed", (job) => {
  logger.info({ requestId: job.data.requestId, jobId: job.id }, "job completed");
});

/**
 * BullMQ fires "failed" after every failed attempt, not just the last one —
 * only mark the review doc "failed" once retries are exhausted, so a
 * transient error mid-backoff doesn't show as a dead review in the
 * dashboard while it's still going to retry. Once exhausted, the failure is
 * written as a structured `error` field on the review doc — this doubles as
 * the dead-letter record, durable in Mongo independent of Redis's TTL on
 * failed jobs.
 */
worker.on("failed", async (job, err) => {
  if (!job) return;

  const log = logger.child({ requestId: job.data.requestId, jobId: job.id });
  const maxAttempts = job.opts.attempts ?? 1;
  log.error({ attempt: job.attemptsMade, maxAttempts, err }, "job failed");

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
        error: {
          message: err instanceof Error ? err.message : String(err),
          attempts: job.attemptsMade,
          failedAt: new Date(),
        },
      },
    },
  );
  log.error("job exhausted retries — review marked failed (dead letter)");
});

worker.on("error", (err) => {
  logger.error({ err }, "worker connection/process error");
});

logger.info({ concurrency: 5, aiRateLimit: `${AI_RATE_LIMIT_MAX}/${AI_RATE_LIMIT_DURATION_MS}ms` }, "review worker started, waiting for jobs...");
