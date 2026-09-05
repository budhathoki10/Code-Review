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

const {
  generateChunkedReviewMock,
  getPullRequestDiffMock,
  postSummaryCommentMock,
  updateSummaryCommentMock,
  postInlineReviewMock,
  verifyBlockingFindingsMock,
} = vi.hoisted(() => ({
  generateChunkedReviewMock: vi.fn(),
  getPullRequestDiffMock: vi.fn(),
  postSummaryCommentMock: vi.fn(),
  updateSummaryCommentMock: vi.fn(),
  postInlineReviewMock: vi.fn(),
  verifyBlockingFindingsMock: vi.fn(),
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
    const actual = k.split(".").reduce<unknown>((value, part) => value && typeof value === "object" ? (value as Doc)[part] : undefined, doc);
    if (v && typeof v === "object") {
      if ("$exists" in v) return (actual !== undefined) === (v as Doc).$exists;
      if ("$ne" in v) return actual !== (v as Doc).$ne;
    }
    return actual === v;
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
vi.mock("@/lib/review/verification", async (importOriginal) => ({
  ...(await importOriginal<object>()), verifyBlockingFindings: verifyBlockingFindingsMock,
}));
vi.mock("@/lib/github/file-content", async (importOriginal) => ({
  ...(await importOriginal<object>()), getFileContent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/github/comment", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  postSummaryComment: postSummaryCommentMock,
  updateSummaryComment: updateSummaryCommentMock,
}));

vi.mock("@/lib/github/inline-comments", () => ({ postInlineReview: postInlineReviewMock }));
vi.mock("@/lib/github/checks", () => ({ createCheckRun: vi.fn(), completeCheckRun: vi.fn() }));
vi.mock("@/lib/review/static-analysis", () => ({ runStaticAnalysis: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/review/config", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadRepoConfig: vi.fn().mockResolvedValue({ config: { pathFilters: [], disabledCategories: [] }, errors: [], found: false }),
}));
vi.mock("@/lib/db/usage", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordUsage: vi.fn().mockResolvedValue(undefined),
}));

import { runReviewPipeline } from "@/lib/review/pipeline";
import { skippedVerification } from "@/lib/review/verification";
import type { FindingDoc } from "@/lib/db/collections";

beforeEach(() => {
  verifyBlockingFindingsMock.mockImplementation(async (findings: FindingDoc[]) => ({
    ...skippedVerification(findings, "test advisory"),
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, calls: 1 },
  }));
});

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

  it("does not advance the baseline or approve when discovery misses a file", async () => {
    generateChunkedReviewMock.mockResolvedValueOnce({ verdict: "approve", summary: "No issues", findings: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 1 }, chunkCount: 1, unreviewedFiles: ["src/a.ts"] });
    await runReviewPipeline(JOB, log);
    expect(pullRequestDocs[0].lastReviewedSha).toBeUndefined();
    expect(reviewDocs[0].coverageComplete).toBe(false);
    expect(reviewDocs[0].verdict).toBe("comment");
    expect((reviewDocs[0].metrics as Doc).filesReviewed).toBe(0);
    expect((reviewDocs[0].metrics as Doc).stages).toHaveProperty("discovery");
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

/**
 * A retry must not re-post inline comments that are already on the PR, and
 * must not lose the comment IDs that make developer replies routable.
 *
 * These pull in opposite directions: the guard that stops the second post
 * also skips the block that writes `githubCommentId` onto the findings, while
 * the findings array itself is rewritten unconditionally from the checkpoint
 * — which predates posting and carries no IDs. Getting one right and the
 * other wrong trades duplicate comments for silently unanswerable replies.
 */
describe("retry does not duplicate or orphan inline comments", () => {
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
      verdict: "request_changes",
      summary: "Reviewed the change.",
      findings: [
        {
          severity: "high",
          category: "bug",
          file: "src/a.ts",
          line: 1,
          title: "Off-by-one",
          explanation: "x should stay 1.",
          suggestion: "const x = 1;",
          confidence: "high",
        },
      ],
      usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, calls: 3 },
      chunkCount: 1,
      unreviewedFiles: [],
    });

    postSummaryCommentMock.mockResolvedValue(999);
    postInlineReviewMock.mockImplementation(
      async (_i: number, _o: string, _r: string, _p: number, _s: string, comments: { finding: unknown }[]) =>
        comments.map((comment, i) => ({ comment, commentId: 5000 + i })),
    );
  });

  function storedFindings(): { githubCommentId?: number; title: string }[] {
    return reviewDocs[0].findings as { githubCommentId?: number; title: string }[];
  }

  it("posts inline comments and records their IDs on the first attempt", async () => {
    await runReviewPipeline(JOB, log);

    expect(postInlineReviewMock).toHaveBeenCalledTimes(1);
    expect(reviewDocs[0].inlineCommentsPostedAt).toBeInstanceOf(Date);
    expect(storedFindings().find((f) => f.title === "Off-by-one")?.githubCommentId).toBe(5000);
  });

  it("does not post them a second time when the job is retried", async () => {
    // Attempt 1 posts, then the write after it fails.
    await runReviewPipeline(JOB, log);
    expect(postInlineReviewMock).toHaveBeenCalledTimes(1);
    expect(verifyBlockingFindingsMock).toHaveBeenCalledTimes(1);

    // Attempt 2: BullMQ retries the same job against the same head SHA.
    await runReviewPipeline(JOB, log);

    // The regression this guards: PR #58 received every review twice.
    expect(postInlineReviewMock).toHaveBeenCalledTimes(1);
  });

  it("keeps githubCommentId across the retry, so replies stay routable", async () => {
    await runReviewPipeline(JOB, log);
    await runReviewPipeline(JOB, log);

    // findFindingByCommentId queries findings.githubCommentId; losing it
    // drops every developer reply as "no finding maps to this comment".
    expect(storedFindings().find((f) => f.title === "Off-by-one")?.githubCommentId).toBe(5000);
  });

  it("preserves a developer's feedback when a completed review is retried", async () => {
    await runReviewPipeline(JOB, log);
    // Feedback rates the review, not an individual finding, so a retry that
    // rewrites the findings array must leave the rating alone rather than
    // carrying it item by item.
    (reviewDocs[0] as { feedback?: unknown }).feedback = { label: "false-positive", userId: "user", at: new Date() };
    await runReviewPipeline(JOB, log);
    expect((reviewDocs[0] as { feedback?: { label: string } }).feedback?.label).toBe("false-positive");
    expect(verifyBlockingFindingsMock).toHaveBeenCalledTimes(1);
  });

  it("reuses the verification result and accounts for its tokens once", async () => {
    await runReviewPipeline(JOB, log);
    await runReviewPipeline(JOB, log);
    expect(verifyBlockingFindingsMock).toHaveBeenCalledTimes(1);
    expect(reviewDocs[0].metrics).toMatchObject({ totalTokens: 1320, calls: 4 });
    expect(reviewDocs[0].verdict).toBe("comment");
    expect(reviewDocs[0].summary).not.toContain("REQUEST CHANGES");
  });

  it("does not spend again when an attempt died after reserving its budget", async () => {
    reviewDocs[0].verificationCheckpoint = { ...skippedVerification([{ severity: "high", category: "bug", file: "src/a.ts", line: 1, title: "Off-by-one", explanation: "x should stay 1." }], "Interrupted"), state: "reserved" };
    await runReviewPipeline(JOB, log);
    expect(verifyBlockingFindingsMock).not.toHaveBeenCalled();
    expect(reviewDocs[0].verdict).toBe("comment");
  });

  it("removes rejected accusations from findings and summary", async () => {
    verifyBlockingFindingsMock.mockImplementation(async (findings: FindingDoc[]) => ({
      ...skippedVerification(findings, "test"), findings: [], rejected: findings,
    }));
    await runReviewPipeline(JOB, log);
    expect(reviewDocs[0].findings).toEqual([]);
    expect(reviewDocs[0].summary).not.toContain("Off-by-one");
    expect(reviewDocs[0].summary).not.toContain("REQUEST CHANGES");
  });

  it("still posts inline comments on a retry that never got to post", async () => {
    // Attempt 1 dies before posting, so the guard must not fire.
    failStatusWrite = true;
    await expect(runReviewPipeline(JOB, log)).rejects.toThrow();
    expect(postInlineReviewMock).not.toHaveBeenCalled();

    failStatusWrite = false;
    await runReviewPipeline(JOB, log);

    expect(postInlineReviewMock).toHaveBeenCalledTimes(1);
  });
});
