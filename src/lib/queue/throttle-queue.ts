import { Queue } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";

export const THROTTLE_QUEUE_NAME = "review-throttle-trailer";

export interface ThrottleTrailerJobData {
  pullRequestId: string;
  /** The webhook delivery ID of the push that scheduled this trailer — threaded through logs. */
  requestId: string;
}

let queue: Queue<ThrottleTrailerJobData> | undefined;

function getQueue(): Queue<ThrottleTrailerJobData> {
  if (!queue) {
    queue = new Queue<ThrottleTrailerJobData>(THROTTLE_QUEUE_NAME, { connection: getRedisConnection() });
  }
  return queue;
}

/**
 * Schedules the job that fires once the PR's current throttle window ends
 * and reviews whatever its head commit is at that point (see
 * pr-throttle.ts). `jobId` is fixed per PR, so every push that lands inside
 * an already-open window calls this too, but only the first one actually
 * schedules anything — BullMQ no-ops an `add` whose jobId is already
 * waiting/delayed, so the trailer still fires once, at the original
 * window's end, and picks up whatever commit is HEAD by then rather than
 * pushing the deadline out further.
 */
export async function scheduleThrottleTrailer(data: ThrottleTrailerJobData, delayMs: number): Promise<void> {
  await getQueue().add("review-latest", data, {
    jobId: `trailer-${data.pullRequestId}`,
    delay: delayMs,
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { age: 300 },
    removeOnFail: { age: 604_800 },
  });
}
