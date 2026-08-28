import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Thread assembly. GitHub flattens review-comment threads — a reply to a
 * reply still carries the ROOT comment's id in `in_reply_to_id`, never the
 * intermediate one — so "the thread" is a filter, not a tree walk. Getting
 * this wrong would feed the model a truncated conversation and produce
 * answers to the wrong question.
 */

const { paginateMock } = vi.hoisted(() => ({ paginateMock: vi.fn() }));

vi.mock("@/lib/github/app", () => ({
  getInstallationOctokit: async () => ({ paginate: paginateMock, request: vi.fn() }),
}));

const { getReviewCommentThread } = await import("@/lib/github/review-comments");

function comment(
  id: number,
  body: string,
  opts: { inReplyTo?: number; login?: string; type?: string; at?: string } = {},
) {
  return {
    id,
    in_reply_to_id: opts.inReplyTo,
    body,
    created_at: opts.at ?? `2026-01-01T00:00:${String(id).padStart(2, "0")}Z`,
    user: { login: opts.login ?? "alice", type: opts.type ?? "User" },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("getReviewCommentThread", () => {
  it("returns the root comment and its replies, and nothing else on the PR", async () => {
    paginateMock.mockResolvedValue([
      comment(1, "root"),
      comment(2, "reply", { inReplyTo: 1 }),
      comment(50, "an unrelated thread's root"),
      comment(51, "an unrelated thread's reply", { inReplyTo: 50 }),
    ]);

    const thread = await getReviewCommentThread(1, "acme", "widgets", 7, 1);

    expect(thread.map((m) => m.id)).toEqual([1, 2]);
  });

  it("includes a reply-to-a-reply, which GitHub still anchors to the root", async () => {
    // The flattening rule: message 3 replies to message 2, but GitHub reports
    // in_reply_to_id as 1. A tree walk from the root would still find it; a
    // naive "direct children only" filter on the wrong id would not.
    paginateMock.mockResolvedValue([
      comment(1, "root"),
      comment(2, "first reply", { inReplyTo: 1 }),
      comment(3, "reply to the reply", { inReplyTo: 1 }),
    ]);

    const thread = await getReviewCommentThread(1, "acme", "widgets", 7, 1);

    expect(thread.map((m) => m.body)).toEqual(["root", "first reply", "reply to the reply"]);
  });

  it("orders messages oldest-first regardless of the order GitHub returned them", async () => {
    paginateMock.mockResolvedValue([
      comment(3, "third", { inReplyTo: 1, at: "2026-01-01T00:03:00Z" }),
      comment(1, "first", { at: "2026-01-01T00:01:00Z" }),
      comment(2, "second", { inReplyTo: 1, at: "2026-01-01T00:02:00Z" }),
    ]);

    const thread = await getReviewCommentThread(1, "acme", "widgets", 7, 1);

    expect(thread.map((m) => m.body)).toEqual(["first", "second", "third"]);
  });

  it("carries the author and whether they're a bot, so our own messages can be told apart", async () => {
    paginateMock.mockResolvedValue([
      comment(1, "finding", { login: "guardreviewer[bot]", type: "Bot" }),
      comment(2, "question", { inReplyTo: 1, login: "alice" }),
    ]);

    const thread = await getReviewCommentThread(1, "acme", "widgets", 7, 1);

    expect(thread[0]).toMatchObject({ author: "guardreviewer[bot]", authorType: "Bot" });
    expect(thread[1]).toMatchObject({ author: "alice", authorType: "User" });
  });

  it("returns an empty thread when the root comment no longer exists (deleted)", async () => {
    paginateMock.mockResolvedValue([comment(50, "someone else's thread")]);

    expect(await getReviewCommentThread(1, "acme", "widgets", 7, 1)).toEqual([]);
  });

  it("tolerates a comment with no body or user rather than throwing", async () => {
    paginateMock.mockResolvedValue([{ id: 1, body: undefined, created_at: "2026-01-01T00:00:00Z", user: null }]);

    const thread = await getReviewCommentThread(1, "acme", "widgets", 7, 1);

    expect(thread[0]).toMatchObject({ body: "", author: "unknown" });
  });
});
