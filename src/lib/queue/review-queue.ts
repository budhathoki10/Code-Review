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
}

let queue: Queue<ReviewJobData> | undefined;

function getQueue(): Queue<ReviewJobData> {
  if (!queue) {
    queue = new Queue<ReviewJobData>(REVIEW_QUEUE_NAME, { connection: getRedisConnection() });
  }
  return queue;
}

/**
 * `jobId` is `<pullRequestId>:<headSha>` — the same pair the `reviews`
 * collection's unique index is built on — so a duplicate webhook delivery
 * for a head SHA that's already queued or running is a no-op here too,
 * rather than relying solely on the Mongo insert to catch it.
 */
export async function enqueueReviewJob(data: ReviewJobData): Promise<void> {
  await getQueue().add("run-review", data, {
    jobId: `${data.pullRequestId}:${data.headSha}`,
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { age: 86_400 },
    removeOnFail: { age: 604_800 },
  });
}
