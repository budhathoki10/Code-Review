import { Queue } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";

export const REVIEW_QUEUE_NAME = "review";

export interface ReviewJobData {
  reviewId: string;
  pullRequestId: string;
  headSha: string;
  githubInstallationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  /** The webhook delivery ID that triggered this job — threaded through logs end to end. */
  requestId: string;
  /** Passed straight through to the AI review call as context — see generateReview's staticFindings/prTitle/prBody options. */
  prTitle: string;
  prBody?: string | null;
  /**
   * Set when a maintainer asked for this review with `@prsentry review
   * --force`. Overrides the size gate and the cheap-triage filter: they've
   * seen the counts and want the whole thing reviewed anyway.
   */
  forced?: boolean;
}

/**
 * BullMQ attempts per review job. Exported because it is a cost multiplier,
 * not just a reliability setting: a retry re-runs the whole pipeline, so
 * anything reasoning about worst-case spend per PR event has to know this
 * number. The AI checkpoint (see ReviewDoc.aiCheckpoint) is what keeps a
 * retry from re-spending the token budget.
 */
export const REVIEW_JOB_ATTEMPTS = 3;

let queue: Queue<ReviewJobData> | undefined;

function getQueue(): Queue<ReviewJobData> {
  if (!queue) {
    queue = new Queue<ReviewJobData>(REVIEW_QUEUE_NAME, { connection: getRedisConnection() });
  }
  return queue;
}

/**
 * `jobId` is `<pullRequestId>-<headSha>` — the same pair the `reviews`
 * collection's unique index is built on — so a duplicate webhook delivery
 * for a head SHA that's already queued or running is a no-op here too,
 * rather than relying solely on the Mongo insert to catch it. Hyphen, not
 * colon: BullMQ rejects `:` in a custom job ID (it uses `:` internally to
 * namespace its own Redis keys, e.g. `bull:<queue>:<jobId>`).
 */
export async function enqueueReviewJob(data: ReviewJobData): Promise<void> {
  // A forced review must NOT reuse the per-commit job ID. BullMQ's `add` is
  // idempotent on jobId and silently returns the existing job — including one
  // that already completed — rather than queueing new work. Completed jobs
  // linger for `removeOnComplete` (300s), so the deduplication that makes
  // duplicate webhook deliveries a no-op would also swallow
  // `@prsentry review --force` in exactly its main
  // use case: a maintainer forcing a re-review seconds after seeing the
  // size-bailout comment. The Mongo row is deleted on the force path, so
  // without a distinct ID the review would sit "pending" forever while the
  // log claimed success. `requestId` is the webhook delivery ID, unique per
  // command.
  const jobId = data.forced
    ? `${data.pullRequestId}-${data.headSha}-force-${data.requestId}`
    : `${data.pullRequestId}-${data.headSha}`;

  await getQueue().add("run-review", data, {
    jobId,
    attempts: REVIEW_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { age: 300 },
    // Dropped the moment the job runs out of retries, rather than kept for
    // inspection. `attempts` above is what decides when that is: BullMQ only
    // treats a job as failed once all REVIEW_JOB_ATTEMPTS are spent, so an
    // intermediate attempt failing still retries normally and keeps the job.
    //
    // Nothing is lost by discarding it. The pipeline writes the failure to
    // the review's Mongo row (status "failed" plus the error in `summary`)
    // and to the PR's own check run, both of which outlive the queue — the
    // BullMQ record only duplicated `failedReason`. Leaving dead jobs in
    // Redis for a week also meant a permanently failing PR kept its jobId
    // occupied, so a later delivery for the same head SHA deduplicated
    // against a corpse instead of queueing a fresh attempt.
    removeOnFail: true,
  });
}
