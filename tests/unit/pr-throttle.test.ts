import { describe, it, expect } from "vitest";
import type IORedis from "ioredis";
import { claimThrottleWindow, throttleWindowRemainingMs } from "@/lib/queue/pr-throttle";

/**
 * Minimal in-memory stand-in for the subset of ioredis used by
 * pr-throttle.ts: SET with NX/PX and PTTL. Mirrors the FakeRedis in
 * pr-lock.test.ts but only needs the read-side (no EVAL) since the
 * throttle window has no compare-and-release step.
 */
class FakeRedis {
  private store = new Map<string, { value: string; expiresAt?: number }>();

  private isLive(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<"OK" | null> {
    if (args.includes("NX") && this.isLive(key)) return null;
    const pxIndex = args.indexOf("PX");
    const ttlMs = pxIndex >= 0 ? Number(args[pxIndex + 1]) : undefined;
    this.store.set(key, { value, expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : undefined });
    return "OK";
  }

  async pttl(key: string): Promise<number> {
    if (!this.isLive(key)) return -2;
    const entry = this.store.get(key)!;
    return entry.expiresAt !== undefined ? entry.expiresAt - Date.now() : -1;
  }
}

function fakeRedis(): IORedis {
  return new FakeRedis() as unknown as IORedis;
}

describe("claimThrottleWindow", () => {
  it("grants the first claim for a PR", async () => {
    const allowed = await claimThrottleWindow(fakeRedis(), "pr-1", 60_000);
    expect(allowed).toBe(true);
  });

  it("refuses a second claim for the same PR while the window is still open", async () => {
    const redis = fakeRedis();
    expect(await claimThrottleWindow(redis, "pr-1", 60_000)).toBe(true);
    expect(await claimThrottleWindow(redis, "pr-1", 60_000)).toBe(false);
    // A third push in the same burst is refused too — debounced to the
    // trailing job, not given its own review.
    expect(await claimThrottleWindow(redis, "pr-1", 60_000)).toBe(false);
  });

  it("does not throttle unrelated PRs against each other", async () => {
    const redis = fakeRedis();
    expect(await claimThrottleWindow(redis, "pr-1", 60_000)).toBe(true);
    expect(await claimThrottleWindow(redis, "pr-2", 60_000)).toBe(true);
  });
});

describe("throttleWindowRemainingMs", () => {
  it("is 0 when no window is open for the PR", async () => {
    expect(await throttleWindowRemainingMs(fakeRedis(), "pr-1")).toBe(0);
  });

  it("reflects roughly the window's duration right after it's claimed", async () => {
    const redis = fakeRedis();
    await claimThrottleWindow(redis, "pr-1", 60_000);

    const remaining = await throttleWindowRemainingMs(redis, "pr-1");
    expect(remaining).toBeGreaterThan(59_000);
    expect(remaining).toBeLessThanOrEqual(60_000);
  });
});
