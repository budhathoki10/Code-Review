import { Worker, type WorkerOptions } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { REVIEW_QUEUE_NAME, type ReviewJobData } from "@/lib/queue/review-queue";
import { runReviewPipeline } from "@/lib/review/pipeline";
import { reviews } from "@/lib/db/collections";
import { logger } from "@/lib/logger";

const AI_RATE_LIMIT_MAX = Number(process.env.AI_RATE_LIMIT_MAX ?? 10);
const AI_RATE_LIMIT_DURATION_MS = Number(process.env.AI_RATE_LIMIT_DURATION_MS ?? 60_000);

/**
 * Shared by the long-running worker process (src/worker/review-worker.ts)
 * and the cron-triggered sweep route (src/app/api/cron/process-reviews) —
 * same processor, same retry/dead-letter handling, just started/stopped
 * differently depending on whether the caller can hold a process open.
 */
export function createReviewWorker(options: Partial<WorkerOptions> = {}): Worker<ReviewJobData> {
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
      // Counts job starts, not raw provider calls: generateReview (see
      // src/lib/ai/review.ts) issues 2 concurrent calls per job (findings +
      // verdict/summary), so the effective NVIDIA-endpoint call rate is
      // 2 × AI_RATE_LIMIT_MAX per AI_RATE_LIMIT_DURATION_MS. If tuning
      // against a provider-side RPM cap, divide the target RPM by 2 before
      // setting AI_RATE_LIMIT_MAX.
      limiter: { max: AI_RATE_LIMIT_MAX, duration: AI_RATE_LIMIT_DURATION_MS },
      ...options,
    },
  );

  worker.on("completed", (job) => {
    logger.info({ requestId: job.data.requestId, jobId: job.id }, "job completed");
  });

  /**
   * BullMQ fires "failed" after every failed attempt, not just the last one —
   * only mark the review doc "failed" once BullMQ is actually done with the
   * job, so a transient error mid-backoff doesn't show as a dead review in
   * the dashboard while it's still going to retry. `job.attemptsMade >=
   * maxAttempts` alone isn't a reliable "done" signal: a job that stalls
   * (its lock expires because the worker process died/was killed mid-job —
   * expected on serverless hosts where a run can outlive the invocation)
   * gets moved to the failed set by BullMQ once it exceeds maxStalledCount,
   * independent of the attempts/backoff counter — attemptsMade can still be
   * well under maxAttempts when that happens. Ask BullMQ directly via
   * `job.isFailed()` whether it's actually in the terminal failed state
   * instead of inferring it from the attempt counter, so a stalled review
   * doesn't sit at "pending" forever. Once terminal, the failure is written
   * as a structured `error` field on the review doc — this doubles as the
   * dead-letter record, durable in Mongo independent of Redis's TTL on
   * failed jobs.
   */
  worker.on("failed", async (job, err) => {
    if (!job) return;

    const log = logger.child({ requestId: job.data.requestId, jobId: job.id });
    const maxAttempts = job.opts.attempts ?? 1;
    log.error({ attempt: job.attemptsMade, maxAttempts, err }, "job failed");

    if (!(await job.isFailed())) {
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

  return worker;
}

export { AI_RATE_LIMIT_MAX, AI_RATE_LIMIT_DURATION_MS };
