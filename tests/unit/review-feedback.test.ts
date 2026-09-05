import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, accountIds, repository, installation, pr, review, update, invalidate } = vi.hoisted(() => ({
  auth: vi.fn(), accountIds: vi.fn(), repository: vi.fn(), installation: vi.fn(), pr: vi.fn(), review: vi.fn(), update: vi.fn(), invalidate: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/github/account", () => ({ getGithubAccountIds: accountIds }));
vi.mock("next/cache", () => ({ revalidatePath: invalidate }));
vi.mock("@/lib/db/collections", () => ({
  repositories: async () => ({ findOne: repository }), installations: async () => ({ findOne: installation }),
  pullRequests: async () => ({ findOne: pr }), reviews: async () => ({ findOne: review, updateOne: update }),
}));
import { setReviewFeedback } from "@/app/dashboard/repos/[repositoryId]/actions";

const repoId = "507f1f77bcf86cd799439011";
const reviewId = "507f1f77bcf86cd799439012";
const prId = "507f1f77bcf86cd799439013";
const installId = "507f1f77bcf86cd799439014";
const finding = { file: "a.ts", title: "Bug", category: "bug" as const, severity: "high" as const, explanation: "An issue" };

beforeEach(() => {
  vi.clearAllMocks(); auth.mockResolvedValue({ user: { id: "user" } }); accountIds.mockResolvedValue(["github-user"]);
  repository.mockResolvedValue({ _id: repoId, installationId: installId }); installation.mockResolvedValue({ _id: installId });
  pr.mockResolvedValue({ _id: prId, repositoryId: repoId });
  review.mockResolvedValue({ _id: reviewId, status: "completed", pullRequestId: prId, findings: [finding] });
  update.mockResolvedValue({ matchedCount: 1 });
});

describe("review feedback authorization", () => {
  it("requires authentication", async () => {
    auth.mockResolvedValue(null);
    expect(await setReviewFeedback(reviewId, repoId, "correct")).toHaveProperty("error");
    expect(update).not.toHaveBeenCalled();
  });

  it("requires ownership of the repository installation", async () => {
    installation.mockResolvedValue(null);
    expect(await setReviewFeedback(reviewId, repoId, "correct")).toHaveProperty("error");
    expect(installation).toHaveBeenCalledWith(expect.objectContaining({ githubUserId: { $in: ["github-user"] } }));
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a review whose pull request belongs to another repository", async () => {
    // A valid review ID from a repo the user cannot see must still be refused,
    // so the pull-request lookup is scoped to this repository.
    pr.mockResolvedValue(null);
    expect(await setReviewFeedback(reviewId, repoId, "correct")).toHaveProperty("error");
    expect(pr).toHaveBeenCalledWith(expect.objectContaining({ repositoryId: repoId }));
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a review that never completed", async () => {
    review.mockResolvedValue({ _id: reviewId, status: "failed", pullRequestId: prId, findings: [] });
    expect(await setReviewFeedback(reviewId, repoId, "correct")).toHaveProperty("error");
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects labels outside the accepted set", async () => {
    expect(await setReviewFeedback(reviewId, repoId, "approve-merge")).toHaveProperty("error");
    expect(await setReviewFeedback(reviewId, repoId, "")).toHaveProperty("error");
    expect(update).not.toHaveBeenCalled();
  });
});

describe("review feedback writes", () => {
  it("rates the review itself, not a finding at an array index", async () => {
    expect(await setReviewFeedback(reviewId, repoId, "false-positive")).toEqual({ success: true });
    // Keyed on the review document alone: a pipeline retry that rewrites the
    // findings array can no longer move a rating onto a different item.
    expect(update).toHaveBeenCalledWith(
      { _id: reviewId },
      { $set: { feedback: { label: "false-positive", userId: "user", at: expect.any(Date) } } },
    );
  });

  it("accepts every valid label", async () => {
    for (const label of ["correct", "false-positive", "duplicate"]) {
      expect(await setReviewFeedback(reviewId, repoId, label)).toEqual({ success: true });
    }
    expect(update).toHaveBeenCalledTimes(3);
  });

  it("can undo a rating", async () => {
    await setReviewFeedback(reviewId, repoId, "clear");
    expect(update).toHaveBeenCalledWith({ _id: reviewId }, { $unset: { feedback: "" } });
  });

  it("reports a conflicting rewrite rather than claiming success", async () => {
    update.mockResolvedValue({ matchedCount: 0 });
    expect(await setReviewFeedback(reviewId, repoId, "correct")).toHaveProperty("error");
  });

  it("revalidates the repository page so the rating shows without a reload", async () => {
    await setReviewFeedback(reviewId, repoId, "correct");
    expect(invalidate).toHaveBeenCalledWith(`/dashboard/repos/${repoId}`);
  });
});
