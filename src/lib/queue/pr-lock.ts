import type IORedis from "ioredis";
import { randomUUID } from "crypto";

/**
 * Distributed lock ensuring only one review job per PR runs at a time.
 *
 * runReviewPipeline's incremental-diff decision depends on finding the
 * *previous* push's review already marked "completed" in Mongo. Worker
 * concurrency (review-worker-factory.ts runs with concurrency: 5) and
 * separate cron-triggered worker invocations (process-reviews/route.ts,
 * for hosts that can't hold a process open) mean two jobs for the same PR
 * — from two pushes close together — can otherwise execute in parallel
 * across different processes, so this has to be a Redis lock, not an
 * in-process mutex.
 *
 * Auto-renews the key while held so a review that legitimately runs longer
 * than `ttlMs` doesn't lose the lock mid-job; if the holder crashes without
 * releasing it, the TTL still expires the lock on its own rather than
 * deadlocking the PR's reviews forever.
 */
const LOCK_PREFIX = "pr-review-lock:";

// Release/renew only if we still hold the token — guards against a slow
// holder's TTL expiring, a second job acquiring the lock, and the first
// job's eventual release() deleting/extending the *second* job's lock.
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

export interface PrLockHandle {
  release(): Promise<void>;
}

export async function acquirePrLock(
  redis: IORedis,
  pullRequestId: string,
  ttlMs: number,
): Promise<PrLockHandle | null> {
  const key = `${LOCK_PREFIX}${pullRequestId}`;
  const token = randomUUID();

  const acquired = await redis.set(key, token, "PX", ttlMs, "NX");
  if (acquired !== "OK") return null;

  const renewalTimer = setInterval(() => {
    redis.eval(RENEW_SCRIPT, 1, key, token, String(ttlMs)).catch(() => {
      // Best-effort: if renewal fails (e.g. transient Redis error), the
      // lock just expires on its TTL like a crashed holder would.
    });
  }, Math.floor(ttlMs / 3));
  renewalTimer.unref?.();

  return {
    async release() {
      clearInterval(renewalTimer);
      await redis.eval(RELEASE_SCRIPT, 1, key, token);
    },
  };
}
