import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Logger } from "pino";
import type { FindingDoc } from "@/lib/db/collections";
import { matchCommentIds } from "@/lib/github/inline-comments";
import type { InlineComment } from "@/lib/github/diff-lines";

/**
 * The reply feature's load-bearing behaviors, in the order a question travels
 * through them: findings must carry the comment id they were posted as, the
 * thread must resolve back to the right finding, and the pipeline must refuse
 * to answer twice.
 */

const { generateReplyAnswerMock, getThreadMock, postReplyMock, getBotLoginMock, recordUsageMock } = vi.hoisted(
  () => ({
    generateReplyAnswerMock: vi.fn(),
    getThreadMock: vi.fn(),
    postReplyMock: vi.fn(),
    getBotLoginMock: vi.fn(),
    recordUsageMock: vi.fn(),
  }),
);

interface Doc {
  [key: string]: unknown;
}

const reviewDocs: Doc[] = [];
const pullRequestDocs: Doc[] = [];

/**
 * Supports the one dotted query the pipeline uses —
 * `{"findings.githubCommentId": n}` — alongside plain equality, so the test
 * exercises the real query shape rather than a rewritten one.
 */
function matches(doc: Doc, query: Doc): boolean {
  return Object.entries(query).every(([k, v]) => {
    if (k === "findings.githubCommentId") {
      const findings = (doc.findings ?? []) as FindingDoc[];
      return findings.some((f) => f.githubCommentId === v);
    }
    if (k === "_id") return String(doc._id) === String(v);
    return doc[k] === v;
  });
}

function makeCollection(store: Doc[]) {
  return {
    async findOne(query: Doc) {
      return store.find((d) => matches(d, query)) ?? null;
    },
  };
}

vi.mock("@/lib/db/collections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/collections")>()),
  reviews: async () => makeCollection(reviewDocs),
  pullRequests: async () => makeCollection(pullRequestDocs),
}));

vi.mock("@/lib/ai/reply", () => ({ generateReplyAnswer: generateReplyAnswerMock }));
vi.mock("@/lib/github/review-comments", () => ({
  getReviewCommentThread: getThreadMock,
  postReviewCommentReply: postReplyMock,
}));
vi.mock("@/lib/github/app", () => ({ getBotLogin: getBotLoginMock }));
vi.mock("@/lib/db/usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/usage")>()),
  recordUsage: recordUsageMock,
}));

const { runReplyPipeline, findFindingByCommentId } = await import("@/lib/review/reply-pipeline");

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

function finding(overrides: Partial<FindingDoc> = {}): FindingDoc {
  return {
    severity: "high",
    category: "bug",
    file: "src/a.ts",
    line: 12,
    title: "off-by-one",
    explanation: "loop runs one past the end",
    ...overrides,
  };
}

const JOB = {
  githubInstallationId: 1,
  owner: "acme",
  repo: "widgets",
  prNumber: 7,
  pullRequestId: "507f1f77bcf86cd799439011",
  rootCommentId: 900,
  triggerCommentId: 901,
  requestId: "delivery-1",
};

beforeEach(() => {
  reviewDocs.length = 0;
  pullRequestDocs.length = 0;
  vi.clearAllMocks();
  getBotLoginMock.mockResolvedValue("guardreviewer[bot]");
  generateReplyAnswerMock.mockResolvedValue({
    answer: "You're right, that's guarded upstream.",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, calls: 1 },
  });
  postReplyMock.mockResolvedValue(999);
  recordUsageMock.mockResolvedValue(undefined);
});

describe("matchCommentIds", () => {
  function sent(body: string): InlineComment {
    return { path: "src/a.ts", line: 1, body, finding: finding({ explanation: body }) };
  }

  it("pairs each sent comment with the id GitHub created for it", () => {
    const a = sent("first");
    const b = sent("second");

    const result = matchCommentIds(
      [a, b],
      [
        { id: 2, body: "second" },
        { id: 1, body: "first" },
      ],
    );

    // Matched by body, so GitHub returning them out of order doesn't misassign.
    expect(result).toEqual([
      { comment: a, commentId: 1 },
      { comment: b, commentId: 2 },
    ]);
  });

  it("gives two identical bodies two different ids rather than both claiming the first", () => {
    const a = sent("same text");
    const b = sent("same text");

    const result = matchCommentIds(
      [a, b],
      [
        { id: 10, body: "same text" },
        { id: 11, body: "same text" },
      ],
    );

    expect(result.map((r) => r.commentId)).toEqual([10, 11]);
  });

  it("drops a comment GitHub never echoed back instead of guessing an id", () => {
    const a = sent("posted");
    const b = sent("missing");

    const result = matchCommentIds([a, b], [{ id: 5, body: "posted" }]);

    expect(result).toEqual([{ comment: a, commentId: 5 }]);
  });
});

describe("findFindingByCommentId", () => {
  it("resolves the finding a thread is anchored to", async () => {
    reviewDocs.push({
      pullRequestId: JOB.pullRequestId,
      findings: [finding({ title: "other", githubCommentId: 111 }), finding({ title: "wanted", githubCommentId: 900 })],
    });

    const match = await findFindingByCommentId(JOB.pullRequestId, 900);

    expect(match?.finding.title).toBe("wanted");
  });

  it("finds a finding from an older review, since a thread outlives the commit it was left on", async () => {
    reviewDocs.push({
      pullRequestId: JOB.pullRequestId,
      headSha: "old",
      findings: [finding({ title: "from an earlier push", githubCommentId: 900 })],
    });
    reviewDocs.push({ pullRequestId: JOB.pullRequestId, headSha: "new", findings: [] });

    const match = await findFindingByCommentId(JOB.pullRequestId, 900);

    expect(match?.finding.title).toBe("from an earlier push");
  });

  it("does not resolve a comment id belonging to a different pull request", async () => {
    reviewDocs.push({ pullRequestId: "another-pr", findings: [finding({ githubCommentId: 900 })] });

    expect(await findFindingByCommentId(JOB.pullRequestId, 900)).toBeUndefined();
  });

  it("returns nothing for a finding that was never posted inline", async () => {
    reviewDocs.push({ pullRequestId: JOB.pullRequestId, findings: [finding({ githubCommentId: undefined })] });

    expect(await findFindingByCommentId(JOB.pullRequestId, 900)).toBeUndefined();
  });
});

describe("runReplyPipeline", () => {
  function seedAnsweredThread(messages: { author: string; body: string }[]) {
    reviewDocs.push({
      pullRequestId: JOB.pullRequestId,
      findings: [finding({ githubCommentId: JOB.rootCommentId })],
    });
    pullRequestDocs.push({ _id: JOB.pullRequestId, title: "Add widget", headSha: "abc123" });
    getThreadMock.mockResolvedValue(
      messages.map((m, i) => ({
        id: 900 + i,
        author: m.author,
        authorType: m.author.endsWith("[bot]") ? "Bot" : "User",
        body: m.body,
        createdAt: new Date(2026, 0, 1, 0, i).toISOString(),
      })),
    );
  }

  it("answers a developer's question and posts it into the thread", async () => {
    seedAnsweredThread([
      { author: "guardreviewer[bot]", body: "off-by-one here" },
      { author: "alice", body: "why? the bound is exclusive" },
    ]);

    await runReplyPipeline(JOB, log);

    expect(postReplyMock).toHaveBeenCalledWith(
      1,
      "acme",
      "widgets",
      7,
      JOB.rootCommentId,
      "You're right, that's guarded upstream.",
    );
  });

  it("passes the finding and the whole thread to the model", async () => {
    seedAnsweredThread([
      { author: "guardreviewer[bot]", body: "off-by-one here" },
      { author: "alice", body: "why?" },
    ]);

    await runReplyPipeline(JOB, log);

    const ctx = generateReplyAnswerMock.mock.calls[0][0];
    expect(ctx.finding.title).toBe("off-by-one");
    expect(ctx.thread).toHaveLength(2);
    expect(ctx.botLogin).toBe("guardreviewer[bot]");
    expect(ctx.prTitle).toBe("Add widget");
    // Reads the file at current HEAD, not the commit the finding was written against.
    expect(ctx.repo?.ref).toBe("abc123");
  });

  it("does not answer when the last message is already ours", async () => {
    // The duplicate-delivery case: GitHub redelivers, or a second attempt runs
    // after the first already posted. Answering again double-posts the thread.
    seedAnsweredThread([
      { author: "alice", body: "why?" },
      { author: "guardreviewer[bot]", body: "because..." },
    ]);

    await runReplyPipeline(JOB, log);

    expect(generateReplyAnswerMock).not.toHaveBeenCalled();
    expect(postReplyMock).not.toHaveBeenCalled();
  });

  it("does nothing when no finding maps to the comment, without calling the model", async () => {
    pullRequestDocs.push({ _id: JOB.pullRequestId, title: "Add widget", headSha: "abc123" });

    await runReplyPipeline(JOB, log);

    expect(generateReplyAnswerMock).not.toHaveBeenCalled();
    expect(postReplyMock).not.toHaveBeenCalled();
  });

  it("does not throw on an unresolvable thread — a dropped question must not dead-letter a job", async () => {
    await expect(runReplyPipeline(JOB, log)).resolves.toBeUndefined();
  });

  it("still posts the answer when usage accounting fails", async () => {
    seedAnsweredThread([
      { author: "guardreviewer[bot]", body: "off-by-one" },
      { author: "alice", body: "why?" },
    ]);
    recordUsageMock.mockRejectedValue(new Error("mongo down"));

    await expect(runReplyPipeline(JOB, log)).resolves.toBeUndefined();
    expect(postReplyMock).toHaveBeenCalled();
  });

  it("records token usage for the reply", async () => {
    seedAnsweredThread([
      { author: "guardreviewer[bot]", body: "off-by-one" },
      { author: "alice", body: "why?" },
    ]);

    await runReplyPipeline(JOB, log);

    expect(recordUsageMock).toHaveBeenCalledWith({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      calls: 1,
    });
  });
});
