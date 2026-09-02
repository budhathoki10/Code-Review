import { Worker, type WorkerOptions } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { REPLY_QUEUE_NAME, type ReplyJobData } from "@/lib/queue/reply-queue";
import { runReplyPipeline } from "@/lib/review/reply-pipeline";
import { logger } from "@/lib/logger";

/**
 * How fast accepted reply jobs are DRAINED. A reply costs one provider call,
 * against a review's worst case of 65, so this gets its own limiter rather
 * than sharing the review worker's — under a shared budget a single in-flight
 * review would starve every question asked while it ran.
 *
 * Distinct from the webhook door's REPLY_ACCEPT_RATE_LIMIT_* (how many
 * questions are taken in at all). The two used to share the name
 * REPLY_RATE_LIMIT_MAX with different defaults. The old names are still read
 * as a fallback so an existing deployment keeps working.
 */
const REPLY_WORKER_RATE_LIMIT_MAX = Number(
  process.env.REPLY_WORKER_RATE_LIMIT_MAX ?? process.env.REPLY_RATE_LIMIT_MAX ?? 20,
);
const REPLY_WORKER_RATE_LIMIT_DURATION_MS = Number(
  process.env.REPLY_WORKER_RATE_LIMIT_DURATION_MS ?? process.env.REPLY_RATE_LIMIT_DURATION_MS ?? 60_000,
);

/**
 * Runs in the same process as the review worker (see
 * src/worker/review-worker.ts) — separate queue, not separate deployment.
 *
 * No per-PR lock, unlike the review worker: replies to different threads on
 * one PR are independent, and serializing them behind an in-flight review
 * would make the bot look unresponsive exactly when someone is talking to
 * it. Duplicate answers are prevented by the jobId (see enqueueReplyJob) and
 * by the pipeline's own "last message is already ours" check, not by locking.
 */
export function createReplyWorker(options: Partial<WorkerOptions> = {}): Worker<ReplyJobData> {
  const worker = new Worker<ReplyJobData>(
    REPLY_QUEUE_NAME,
    async (job) => {
      const log = logger.child({ requestId: job.data.requestId, jobId: job.id });
      log.info({ attempt: job.attemptsMade + 1, prNumber: job.data.prNumber }, "reply job starting");
      await runReplyPipeline(job.data, log);
    },
    {
      connection: getRedisConnection(),
      concurrency: 5,
      limiter: { max: REPLY_WORKER_RATE_LIMIT_MAX, duration: REPLY_WORKER_RATE_LIMIT_DURATION_MS },
      ...options,
    },
  );

  worker.on("completed", (job) => {
    logger.info({ requestId: job.data.requestId, jobId: job.id }, "reply job completed");
  });

  /**
   * A failed reply is logged and dropped — there is no dashboard row to mark
   * failed, and writing the failure onto the review doc would misreport a
   * healthy review as broken. The thread simply goes unanswered, which is
   * the honest outcome: the developer sees no reply rather than a wrong one.
   */
  worker.on("failed", (job, err) => {
    logger.error(
      { requestId: job?.data.requestId, jobId: job?.id, attempt: job?.attemptsMade, err },
      "reply job failed",
    );
  });

  worker.on("error", (err) => {
    logger.error({ err }, "reply worker connection/process error");
  });

  return worker;
}

export { REPLY_WORKER_RATE_LIMIT_MAX, REPLY_WORKER_RATE_LIMIT_DURATION_MS };
