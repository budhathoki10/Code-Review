import { afterEach, describe, expect, it, vi } from "vitest";

const { reviewsFindMock, reviewsUpdateOneMock, pullRequestsFindOneMock, repositoriesFindOneMock, completeCheckRunMock } = vi.hoisted(() => ({
  reviewsFindMock: vi.fn(),
  reviewsUpdateOneMock: vi.fn(),
  pullRequestsFindOneMock: vi.fn(),
  repositoriesFindOneMock: vi.fn(),
  completeCheckRunMock: vi.fn(),
}));

vi.mock("@/lib/db/collections", () => ({
  reviews: vi.fn(async () => ({
    find: reviewsFindMock,
    updateOne: reviewsUpdateOneMock,
  })),
  pullRequests: vi.fn(async () => ({ findOne: pullRequestsFindOneMock })),
  repositories: vi.fn(async () => ({ findOne: repositoriesFindOneMock })),
}));
vi.mock("@/lib/github/checks", () => ({ completeCheckRun: completeCheckRunMock }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ warn: vi.fn(), error: vi.fn() }) },
}));

async function loadReconciler() {
  vi.resetModules();
  const mod = await import("@/lib/review/reconcile-orphaned");
  return mod;
}

function fakeQueue(job: unknown) {
  return { getJob: vi.fn(async () => job) } as never;
}

afterEach(() => {
  vi.unstubAllEnvs();
  reviewsFindMock.mockReset();
  reviewsUpdateOneMock.mockReset();
  pullRequestsFindOneMock.mockReset();
  repositoriesFindOneMock.mockReset();
  completeCheckRunMock.mockReset();
});

describe("reconcileOrphanedReviews", () => {
  it("leaves a pending review alone when its job still exists in the queue", async () => {
    reviewsFindMock.mockReturnValue({
      toArray: async () => [
        { _id: "r1", pullRequestId: "p1", headSha: "abc", status: "pending", createdAt: new Date(0) },
      ],
    });
    const { reconcileOrphanedReviews } = await loadReconciler();

    const result = await reconcileOrphanedReviews(fakeQueue({ id: "p1-abc" }));

    expect(result.reconciled).toBe(0);
    expect(reviewsUpdateOneMock).not.toHaveBeenCalled();
  });

  it("marks a pending review failed and closes its check run when the job is gone", async () => {
    reviewsFindMock.mockReturnValue({
      toArray: async () => [
        {
          _id: "r1",
          pullRequestId: "507f1f77bcf86cd799439011",
          headSha: "abc",
          status: "pending",
          createdAt: new Date(0),
          checkRunId: 42,
        },
      ],
    });
    pullRequestsFindOneMock.mockResolvedValue({ repositoryId: "507f1f77bcf86cd799439012" });
    repositoriesFindOneMock.mockResolvedValue({ githubInstallationId: 99, fullName: "owner/repo" });
    const { reconcileOrphanedReviews } = await loadReconciler();

    const result = await reconcileOrphanedReviews(fakeQueue(undefined));

    expect(result.reconciled).toBe(1);
    expect(reviewsUpdateOneMock).toHaveBeenCalledWith(
      { _id: "r1" },
      expect.objectContaining({ $set: expect.objectContaining({ status: "failed" }) }),
    );
    expect(completeCheckRunMock).toHaveBeenCalledWith(
      99,
      "owner",
      "repo",
      42,
      expect.objectContaining({ conclusion: "neutral" }),
    );
  });

  it("marks the review failed even when it has no check run to close", async () => {
    reviewsFindMock.mockReturnValue({
      toArray: async () => [
        { _id: "r2", pullRequestId: "p2", headSha: "def", status: "pending", createdAt: new Date(0) },
      ],
    });
    const { reconcileOrphanedReviews } = await loadReconciler();

    const result = await reconcileOrphanedReviews(fakeQueue(undefined));

    expect(result.reconciled).toBe(1);
    expect(reviewsUpdateOneMock).toHaveBeenCalledTimes(1);
    expect(completeCheckRunMock).not.toHaveBeenCalled();
  });

  it("only inspects reviews past the minimum age (queried in Mongo)", async () => {
    reviewsFindMock.mockReturnValue({ toArray: async () => [] });
    const { reconcileOrphanedReviews } = await loadReconciler();

    await reconcileOrphanedReviews(fakeQueue(undefined));

    expect(reviewsFindMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending", createdAt: expect.objectContaining({ $lte: expect.any(Date) }) }),
    );
  });
});
