import { describe, it, expect, vi, beforeEach } from "vitest";

const { addMock } = vi.hoisted(() => ({ addMock: vi.fn() }));

vi.mock("bullmq", () => ({
  Queue: class {
    add = addMock;
  },
}));
vi.mock("@/lib/queue/connection", () => ({ getRedisConnection: () => ({}) }));

import { enqueueReviewJob, REVIEW_JOB_ATTEMPTS } from "@/lib/queue/review-queue";

const base = {
  reviewId: "r1",
  pullRequestId: "pr1",
  headSha: "abc123",
  githubInstallationId: 1,
  owner: "acme",
  repo: "widgets",
  prNumber: 7,
  requestId: "delivery-1",
  prTitle: "Test",
};

describe("review job IDs", () => {
  beforeEach(() => addMock.mockReset());

  it("dedupes ordinary deliveries on pullRequestId-headSha", async () => {
    await enqueueReviewJob(base);

    expect(addMock.mock.calls[0][2].jobId).toBe("pr1-abc123");
  });

  it("gives a forced review a distinct job id", async () => {
    // BullMQ's add() is idempotent on jobId and silently returns an existing
    // job — including a COMPLETED one, which lingers for removeOnComplete
    // (300s). Reusing the per-commit id would make `@prsentry review --force`
    // a silent no-op in exactly its main use case: forcing moments after a
    // size-bailout comment.
    await enqueueReviewJob({ ...base, forced: true });

    const jobId = addMock.mock.calls[0][2].jobId;
    expect(jobId).not.toBe("pr1-abc123");
    expect(jobId).toContain("force");
    expect(jobId).toContain("delivery-1");
  });

  it("gives two forced reviews of the same commit different ids", async () => {
    await enqueueReviewJob({ ...base, forced: true, requestId: "delivery-1" });
    await enqueueReviewJob({ ...base, forced: true, requestId: "delivery-2" });

    expect(addMock.mock.calls[0][2].jobId).not.toBe(addMock.mock.calls[1][2].jobId);
  });

  it("keeps the retry count on the exported constant", async () => {
    await enqueueReviewJob(base);

    expect(addMock.mock.calls[0][2].attempts).toBe(REVIEW_JOB_ATTEMPTS);
  });
});
