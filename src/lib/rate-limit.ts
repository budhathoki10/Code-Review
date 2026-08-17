import type IORedis from "ioredis";

/**
 * Fixed-window rate limit backed by Redis: INCR the window's counter, set
 * its expiry only on the first hit in the window (NX), and compare against
 * `limit`. Simple over a sliding-window log — fine for a coarse per-key
 * webhook guard where exact precision at the window boundary doesn't matter.
 */
export async function checkRateLimit(
  redis: IORedis,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }
  return count <= limit;
}
