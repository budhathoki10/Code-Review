import { describe, it, expect, afterEach } from "vitest";
import type IORedis from "ioredis";
import { acquirePrLock, type PrLockHandle } from "@/lib/queue/pr-lock";

/**
 * Minimal in-memory stand-in for the subset of ioredis used by pr-lock.ts:
 * SET with NX/PX, GET, and EVAL of the two fixed Lua scripts (a
 * compare-and-delete "release" and a compare-and-extend "renew"),
 * distinguished structurally since the scripts themselves aren't exported.
 * Good enough to exercise the actual acquire/release/renew logic without a
 * real Redis server.
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

  async get(key: string): Promise<string | null> {
    return this.isLive(key) ? this.store.get(key)!.value : null;
  }

  async eval(script: string, _numKeys: number, key: string, token: string, ttlArg?: string): Promise<number> {
    if (!this.isLive(key) || this.store.get(key)!.value !== token) return 0;
    if (script.includes("del")) {
      this.store.delete(key);
      return 1;
    }
    if (script.includes("pexpire")) {
      this.store.get(key)!.expiresAt = Date.now() + Number(ttlArg);
      return 1;
    }
    return 0;
  }
}

function fakeRedis(): IORedis {
  return new FakeRedis() as unknown as IORedis;
}

describe("acquirePrLock", () => {
  const handles: PrLockHandle[] = [];

  afterEach(async () => {
    await Promise.all(handles.map((h) => h.release()));
    handles.length = 0;
  });

  it("grants the lock when the PR has no existing lock", async () => {
    const lock = await acquirePrLock(fakeRedis(), "pr-1", 5_000);
    expect(lock).not.toBeNull();
    if (lock) handles.push(lock);
  });

  it("refuses a second acquire for the same PR while the first lock is held", async () => {
    const redis = fakeRedis();
    const first = await acquirePrLock(redis, "pr-1", 5_000);
    expect(first).not.toBeNull();
    if (first) handles.push(first);

    const second = await acquirePrLock(redis, "pr-1", 5_000);
    expect(second).toBeNull();
  });

  it("lets a later push acquire the lock once the earlier review releases it", async () => {
    const redis = fakeRedis();
    const first = await acquirePrLock(redis, "pr-1", 5_000);
    expect(first).not.toBeNull();
    await first?.release();

    const second = await acquirePrLock(redis, "pr-1", 5_000);
    expect(second).not.toBeNull();
    if (second) handles.push(second);
  });

  it("does not serialize unrelated PRs against each other", async () => {
    const redis = fakeRedis();
    const prOne = await acquirePrLock(redis, "pr-1", 5_000);
    const prTwo = await acquirePrLock(redis, "pr-2", 5_000);

    expect(prOne).not.toBeNull();
    expect(prTwo).not.toBeNull();
    if (prOne) handles.push(prOne);
    if (prTwo) handles.push(prTwo);
  });
});
