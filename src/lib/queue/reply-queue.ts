import { Queue } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";

export const REPLY_QUEUE_NAME = "finding-reply";

export interface ReplyJobData {
  githubInstallationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  pullRequestId: string;
  /** Root comment of the thread — the comment the finding was posted as. */
  rootCommentId: number;
  /** The reply that triggered this job; used only for dedup and logging. */
  triggerCommentId: number;
  /** Webhook delivery ID, threaded through logs. */
  requestId: string;
}

export const REPLY_JOB_ATTEMPTS = 2;

let queue: Queue<ReplyJobData> | undefined;

function getQueue(): Queue<ReplyJobData> {
  if (!queue) {
    queue = new Queue<ReplyJobData>(REPLY_QUEUE_NAME, { connection: getRedisConnection() });
  }
  return queue;
}

/**
 * Queues one answer to one question.
 *
 * Deliberately its own queue rather than a job type on the review queue: the
 * review queue dedups on `pullRequestId-headSha` (two questions on the same
 * commit would collide and one would be silently dropped), serializes per PR
 * behind a 5-minute lock (a question asked during a review would wait out the
 * review), rate-limits for 65-call reviews rather than single calls, and
 * writes its failures onto the review doc — which would mark a healthy
 * completed review as failed when a reply failed.
 *
 * `jobId` keys on the triggering comment so a redelivered webhook (GitHub
 * retries) answers once rather than twice. Fewer attempts than a review: a
 * reply is cheap to lose and expensive to duplicate, and a second copy of an
 * answer in a thread is worse than none.
 */
export async function enqueueReplyJob(data: ReplyJobData): Promise<void> {
  await getQueue().add("answer-reply", data, {
    jobId: `reply-${data.triggerCommentId}`,
    attempts: REPLY_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { age: 300 },
    removeOnFail: { age: 60 },
  });
}
