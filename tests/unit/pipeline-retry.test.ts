import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Logger } from "pino";

/**
 * Drives the real `runReviewPipeline` against in-memory fakes to prove the
 * one property that reading the code cannot establish: that a BullMQ retry
 * reuses the previous attempt's model output instead of re-spending the token
 * budget.
 *
 * This is the harness the runbook's Scenario 7 exists to cover manually. It
 * does not replace watching a real worker crash — it cannot prove the
 * checkpoint survives a process kill — but it does pin the logic that decides
 * whether to regenerate, which is where a regression would actually land.
 */

const { generateChunkedReviewMock, getPullRequestDiffMock, postSummaryCommentMock, updateSummaryCommentMock } =
  vi.hoisted(() => ({
    generateChunkedReviewMock: vi.fn(),
    getPullRequestDiffMock: vi.fn(),
    postSummaryCommentMock: vi.fn(),
    updateSummaryCommentMock: vi.fn(),
  }));

/** Fails the write that sets `status`, i.e. the first thing after the checkpoint. */
let failStatusWrite = false;

interface Doc {
  [key: string]: unknown;
}

const reviewDocs: Doc[] = [];
const pullRequestDocs: Doc[] = [];

function matches(doc: Doc, query: Doc): boolean {
  return Object.entries(query).every(([k, v]) => {
    if (k === "_id") return String(doc._id) === String(v);
    return doc[k] === v;
  });
}

function makeCollection(store: Doc[]) {
  return {
    async findOne(query: Doc, options?: { sort?: Record<string, number> }) {
      const hits = store.filter((d) => matches(d, query));
      if (options?.sort?.createdAt === -1) {
        hits.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
      }
      return hits[0] ?? null;
    },
    async updateOne(query: Doc, update: { $set: Doc }) {
      if (failStatusWrite && "status" in update.$set) {
        throw new Error("simulated Mongo failure writing the completed review");
      }
      const doc = store.find((d) => matches(d, query));
      if (doc) Object.assign(doc, update.$set);
      return { matchedCount: doc ? 1 : 0 };
    },
    async insertOne(doc: Doc) {
      store.push(doc);
      return { insertedId: doc._id ?? "generated" };
    },
    async deleteOne(query: Doc) {
      const i = store.findIndex((d) => matches(d, query));
      if (i >= 0) store.splice(i, 1);
      return { deletedCount: i >= 0 ? 1 : 0 };
    },
  };
}

vi.mock("@/lib/db/collections", () => ({
  reviews: async () => makeCollection(reviewDocs),
  pullRequests: async () => makeCollection(pullRequestDocs),
  repositories: async () => makeCollection([]),
}));

vi.mock("@/lib/github/diff", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getPullRequestDiff: getPullRequestDiffMock,
  getIncrementalDiff: vi.fn(),
}));

vi.mock("@/lib/ai/review", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  generateChunkedReview: generateChunkedReviewMock,
}));

vi.mock("@/lib/github/comment", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  postSummaryComment: postSummaryCommentMock,
  updateSummaryComment: updateSummaryCommentMock,
}));

vi.mock("@/lib/github/inline-comments", () => ({ postInlineReview: vi.fn() }));
vi.mock("@/lib/github/checks", () => ({ createCheckRun: vi.fn(), completeCheckRun: vi.fn() }));
vi.mock("@/lib/review/static-analysis", () => ({ runStaticAnalysis: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/review/config", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadRepoConfig: vi.fn().mockResolvedValue({ config: { pathFilters: [] }, errors: [], found: false }),
}));
vi.mock("@/lib/db/usage", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordUsage: vi.fn().mockResolvedValue(undefined),
}));

import { runReviewPipeline } from "@/lib/review/pipeline";

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

const JOB = {
  reviewId: "review-1",
  pullRequestId: "507f1f77bcf86cd799439011",
  headSha: "abc123",
  githubInstallationId: 1,
  owner: "acme",
  repo: "widgets",
  prNumber: 7,
  requestId: "delivery-1",
  prTitle: "A change",
};

function seed() {
  reviewDocs.length = 0;
  pullRequestDocs.length = 0;
  reviewDocs.push({
    _id: "review-1",
    pullRequestId: JOB.pullRequestId,
    headSha: JOB.headSha,
    status: "pending",
    findings: [],
    createdAt: Date.now(),
  });
  pullRequestDocs.push({
    _id: JOB.pullRequestId,
    githubPrNumber: 7,
    repositoryId: "507f1f77bcf86cd799439012",
    title: "A change",
    headSha: JOB.headSha,
  });
}

describe("retry reuses the AI checkpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    failStatusWrite = false;
    seed();

    getPullRequestDiffMock.mockResolvedValue({
      fileCount: 1,
      totalChangedLines: 4,
      diffText: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-const x = 1;\n+const x = 2;",
      files: [
        {
          filename: "src/a.ts",
          status: "modified",
          changes: 4,
          patch: "@@ -1,2 +1,2 @@\n-const x = 1;\n+const x = 2;",
          patchSource: "github",
        },
      ],
    });

    generateChunkedReviewMock.mockResolvedValue({
      verdict: "comment",
      summary: "Reviewed the change.",
      findings: [],
      usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, calls: 3 },
      chunkCount: 1,
      unreviewedFiles: [],
    });

    postSummaryCommentMock.mockResolvedValue(999);
  });

  it("writes a checkpoint as soon as generation finishes", async () => {
    await runReviewPipeline(JOB, log);

    const checkpoint = reviewDocs[0].aiCheckpoint as Record<string, unknown> | undefined;
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.calls).toBe(3);
    expect(checkpoint?.totalTokens).toBe(1200);
    expect(checkpoint?.summary).toBe("Reviewed the change.");
  });

  it("does not call the model again on a retry after a post-generation failure", async () => {
    // Attempt 1: generation succeeds, the write that follows it blows up.
    failStatusWrite = true;
    await expect(runReviewPipeline(JOB, log)).rejects.toThrow("simulated Mongo failure");
    expect(generateChunkedReviewMock).toHaveBeenCalledTimes(1);
    expect(reviewDocs[0].aiCheckpoint).toBeDefined();

    // Attempt 2: BullMQ retries the same job.
    failStatusWrite = false;
    await runReviewPipeline(JOB, log);

    // The whole point: no second generation, so no second token spend.
    expect(generateChunkedReviewMock).toHaveBeenCalledTimes(1);
    expect(reviewDocs[0].status).toBe("completed");
  });

  it("reports the checkpointed cost on the retry, not zero", async () => {
    failStatusWrite = true;
    await expect(runReviewPipeline(JOB, log)).rejects.toThrow();
    failStatusWrite = false;
    await runReviewPipeline(JOB, log);

    const metrics = reviewDocs[0].metrics as Record<string, number>;
    // The tokens were really spent on attempt 1; the review's recorded cost
    // has to say so, or the dashboard under-reports what this PR cost.
    expect(metrics.calls).toBe(3);
    expect(metrics.totalTokens).toBe(1200);
  });

  it("still posts the review on the retry", async () => {
    failStatusWrite = true;
    await expect(runReviewPipeline(JOB, log)).rejects.toThrow();
    const postsAfterFailure = postSummaryCommentMock.mock.calls.length;

    failStatusWrite = false;
    await runReviewPipeline(JOB, log);

    expect(postSummaryCommentMock.mock.calls.length).toBeGreaterThan(postsAfterFailure);
  });

  it("generates normally when there is no checkpoint", async () => {
    await runReviewPipeline(JOB, log);
    expect(generateChunkedReviewMock).toHaveBeenCalledTimes(1);

    // A fresh head SHA is a different review row with no checkpoint.
    seed();
    await runReviewPipeline(JOB, log);
    expect(generateChunkedReviewMock).toHaveBeenCalledTimes(2);
  });
});
