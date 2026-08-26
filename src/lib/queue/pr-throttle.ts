import type IORedis from "ioredis";

/**
 * Caps how often a PR's commits actually get reviewed: at most one review
 * is *triggered* per PR per `windowMs` (default 60s — PR_REVIEW_THROTTLE_WINDOW_MS).
 * Pushes that land inside an already-open window are debounced to the
 * latest commit rather than each getting their own review — see
 * scheduleThrottleTrailer in throttle-queue.ts, which reviews whatever is
 * HEAD once the window elapses, and skips entirely if that commit was
 * already covered by the window's leading review.
 *
 * Distinct from pr-lock.ts: that lock serializes *execution* of reviews
 * already queued (so an incremental diff never races a still-running
 * prior review); this throttle controls whether a push gets queued for
 * review at all.
 */
const THROTTLE_PREFIX = "pr-review-throttle:";

/**
 * Returns true the first time it's called for a PR within a window (the
 * caller should review the pushed commit immediately) and false for every
 * subsequent call inside that same window (the caller should rely on the
 * trailing job instead).
 */
export async function claimThrottleWindow(
  redis: IORedis,
  pullRequestId: string,
  windowMs: number,
): Promise<boolean> {
  const key = `${THROTTLE_PREFIX}${pullRequestId}`;
  const claimed = await redis.set(key, "1", "PX", windowMs, "NX");
  return claimed === "OK";
}

/** Remaining ms in the current throttle window for this PR, or 0 if none is active. */
export async function throttleWindowRemainingMs(redis: IORedis, pullRequestId: string): Promise<number> {
  const key = `${THROTTLE_PREFIX}${pullRequestId}`;
  const ttl = await redis.pttl(key);
  return ttl > 0 ? ttl : 0;
}
