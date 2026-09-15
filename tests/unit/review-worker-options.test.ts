import { afterEach, describe, expect, it, vi } from "vitest";

const { workerConstructorMock } = vi.hoisted(() => ({
  workerConstructorMock: vi.fn(),
}));

vi.mock("bullmq", () => ({
  DelayedError: class DelayedError extends Error {},
  Worker: class {
    constructor(...args: unknown[]) {
      workerConstructorMock(...args);
    }

    on(): this {
      return this;
    }

    close(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

vi.mock("@/lib/queue/connection", () => ({ getRedisConnection: () => ({}) }));
vi.mock("@/lib/review/pipeline", () => ({
  ReviewIncompleteError: class ReviewIncompleteError extends Error {
    madeProgress = false;
  },
  runReviewPipeline: vi.fn(),
}));
vi.mock("@/lib/queue/pr-lock", () => ({ acquirePrLock: vi.fn() }));
vi.mock("@/lib/db/collections", () => ({ reviews: vi.fn() }));
vi.mock("@/lib/github/checks", () => ({ completeCheckRun: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: {
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

async function loadFactory() {
  vi.resetModules();
  const mod = await import("@/lib/queue/review-worker-factory");
  return mod;
}

function clearWorkerEnv() {
  for (const name of [
    "REVIEW_DEADLINE_MS",
    "REVIEW_RISKY_DEADLINE_MS",
    "REVIEW_MULTI_STAGE_DEADLINE_MS",
    "REVIEW_BULLMQ_LOCK_DURATION_MS",
    "REVIEW_BULLMQ_STALLED_INTERVAL_MS",
    "REVIEW_BULLMQ_MAX_STALLED_COUNT",
  ]) {
    vi.stubEnv(name, "");
  }
}

function workerOptions(): Record<string, unknown> {
  return workerConstructorMock.mock.calls[0]?.[2] as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllEnvs();
  workerConstructorMock.mockReset();
});

describe("review worker BullMQ options", () => {
  it("sets the job lock long enough for the longest review window", async () => {
    clearWorkerEnv();
    const { createReviewWorker, REVIEW_BULLMQ_LOCK_DURATION_MS } = await loadFactory();

    createReviewWorker({ autorun: false });

    expect(REVIEW_BULLMQ_LOCK_DURATION_MS).toBe(1_020_000);
    expect(workerOptions()).toMatchObject({
      lockDuration: 1_020_000,
      stalledInterval: 60_000,
      maxStalledCount: 3,
    });
  });

  it("keeps BullMQ stall timing operator-tunable", async () => {
    clearWorkerEnv();
    vi.stubEnv("REVIEW_BULLMQ_LOCK_DURATION_MS", "1800000");
    vi.stubEnv("REVIEW_BULLMQ_STALLED_INTERVAL_MS", "120000");
    vi.stubEnv("REVIEW_BULLMQ_MAX_STALLED_COUNT", "5");
    const { createReviewWorker } = await loadFactory();

    createReviewWorker({ autorun: false });

    expect(workerOptions()).toMatchObject({
      lockDuration: 1_800_000,
      stalledInterval: 120_000,
      maxStalledCount: 5,
    });
  });
});
