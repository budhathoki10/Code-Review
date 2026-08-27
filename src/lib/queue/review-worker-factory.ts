import { Worker, DelayedError, type WorkerOptions } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { REVIEW_QUEUE_NAME, type ReviewJobData } from "@/lib/queue/review-queue";
import { runReviewPipeline } from "@/lib/review/pipeline";
import { acquirePrLock } from "@/lib/queue/pr-lock";
import { reviews } from "@/lib/db/collections";
import { logger } from "@/lib/logger";

const AI_RATE_LIMIT_MAX = Number(process.env.AI_RATE_LIMIT_MAX ?? 10);
const AI_RATE_LIMIT_DURATION_MS = Number(process.env.AI_RATE_LIMIT_DURATION_MS ?? 60_000);

/**
 * Per-PR lock TTL (see pr-lock.ts) and the delay before a job blocked on
 * that lock is retried. TTL defaults generously above the AI call's own
 * worst case (up to 5 rounds, rate-limited to AI_RATE_LIMIT_MAX per
 * AI_RATE_LIMIT_DURATION_MS — see review-worker-factory's limiter comment
 * below) so a legitimately slow review isn't cut off mid-run; the lock is
 * renewed periodically regardless, so this is a ceiling for a crashed
 * holder, not the expected runtime.
 */
const PR_REVIEW_LOCK_TTL_MS = Number(process.env.PR_REVIEW_LOCK_TTL_MS ?? 5 * 60_000);
const PR_REVIEW_LOCK_RETRY_DELAY_MS = Number(process.env.PR_REVIEW_LOCK_RETRY_DELAY_MS ?? 3_000);

/**
 * Shared by the long-running worker process (src/worker/review-worker.ts)
 * and the cron-triggered sweep route (src/app/api/cron/process-reviews) —
 * same processor, same retry/dead-letter handling, just started/stopped
 * differently depending on whether the caller can hold a process open.
 */
export function createReviewWorker(options: Partial<WorkerOptions> = {}): Worker<ReviewJobData> {
  const worker = new Worker<ReviewJobData>(
    REVIEW_QUEUE_NAME,
    async (job, token) => {
      const log = logger.child({ requestId: job.data.requestId, jobId: job.id });
      log.info({ attempt: job.attemptsMade + 1 }, "job starting");

      // Serialize review jobs per PR. Two pushes to the same PR close
      // together each enqueue their own job (see review-queue.ts), and
      // runReviewPipeline's incremental-diff decision depends on the
      // *previous* push's review already being marked "completed" in
      // Mongo. Without this lock, this worker's own concurrency (5) — or a
      // second cron-triggered worker invocation under Netlify, see
      // process-reviews/route.ts — can run both jobs in parallel, so the
      // later push's "find the last completed review" lookup races the
      // earlier job and comes up empty, silently falling back to a full
      // base-branch diff that re-reviews files the later push never
      // touched. If another job for this PR already holds the lock, this
      // one is rescheduled rather than processed now or treated as failed
      // (DelayedError makes BullMQ neither complete nor fail it, and
      // doesn't count against `attempts`).
      const lock = await acquirePrLock(getRedisConnection(), job.data.pullRequestId, PR_REVIEW_LOCK_TTL_MS);
      if (!lock) {
        log.info("another review for this PR is in flight — delaying");
        if (!token) throw new Error("missing worker token — cannot delay job");
        await job.moveToDelayed(Date.now() + PR_REVIEW_LOCK_RETRY_DELAY_MS, token);
        throw new DelayedError();
      }

      try {
        await runReviewPipeline(job.data, log);
      } finally {
        await lock.release();
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 5,
      // Bounds how often this process calls the AI provider, independent of
      // job concurrency — avoids tripping the provider's own rate limits.
      //
      // Counts job starts, not raw provider calls, and one job is a whole
      // chunked review (see generateChunkedReview in src/lib/ai/review.ts).
      //
      // The unit that matters is an ATTEMPT, not a call: one findings attempt
      // is a tool-calling loop of up to MAX_FINDINGS_TOOL_ROUNDS + 1 = 4
      // provider calls. REVIEW_MAX_BISECT_ATTEMPTS budgets attempts, so it
      // costs 4x its face value in calls. Worst case per job:
      //
      //   root attempts:   MAX_REVIEW_CHUNKS (4) x 4 rounds       = 16
      //   bisect attempts: REVIEW_MAX_BISECT_ATTEMPTS (12) x 4    = 48
      //   verdict/summary: once per review                        =  1
      //                                                             ----
      //                                                               65
      //
      // Verified empirically, not derived on paper — see the "bounds total
      // provider calls" test in tests/unit/chunked-review.test.ts, which
      // drives every attempt through every round and counts the mock.
      //
      // So the effective endpoint call rate can reach 65 × AI_RATE_LIMIT_MAX
      // per AI_RATE_LIMIT_DURATION_MS. If tuning against a provider-side RPM
      // cap, divide the target RPM by 65 before setting AI_RATE_LIMIT_MAX —
      // a deliberately conservative bound, since a typical review is one or
      // two chunks that each submit on their first round and never bisect,
      // i.e. 2-3 calls, well under 5% of this ceiling.
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
