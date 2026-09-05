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
import { setFindingFeedback } from "@/app/dashboard/repos/[repositoryId]/actions";
import { findingId } from "@/lib/review/finding-policy";
const repoId = "507f1f77bcf86cd799439011";
const reviewId = "507f1f77bcf86cd799439012";
const prId = "507f1f77bcf86cd799439013";
const installId = "507f1f77bcf86cd799439014";
const finding = { file: "a.ts", title: "Bug", category: "bug" as const, severity: "high" as const, explanation: "An issue" };
const id = findingId(finding);
beforeEach(() => {
  vi.clearAllMocks(); auth.mockResolvedValue({ user: { id: "user" } }); accountIds.mockResolvedValue(["github-user"]);
  repository.mockResolvedValue({ _id: repoId, installationId: installId }); installation.mockResolvedValue({ _id: installId });
  pr.mockResolvedValue({ _id: prId, repositoryId: repoId }); review.mockResolvedValue({ _id: reviewId, status: "completed", pullRequestId: prId, findings: [finding] });
  update.mockResolvedValue({ matchedCount: 1 });
});
describe("finding feedback authorization", () => {
  it("requires authentication", async () => {
    auth.mockResolvedValue(null);
    expect(await setFindingFeedback(reviewId, repoId, id, "correct")).toHaveProperty("error");
    expect(update).not.toHaveBeenCalled();
  });
  it("requires ownership of the repository installation", async () => {
    installation.mockResolvedValue(null);
    expect(await setFindingFeedback(reviewId, repoId, id, "correct")).toHaveProperty("error");
    expect(installation).toHaveBeenCalledWith(expect.objectContaining({ githubUserId: { $in: ["github-user"] } }));
    expect(update).not.toHaveBeenCalled();
  });
  it("rejects a review from a different repository", async () => {
    pr.mockResolvedValue(null);
    expect(await setFindingFeedback(reviewId, repoId, id, "correct")).toHaveProperty("error");
    expect(pr).toHaveBeenCalledWith(expect.objectContaining({ repositoryId: repoId })); expect(update).not.toHaveBeenCalled();
  });
  it("rejects unknown finding identities and labels", async () => {
    expect(await setFindingFeedback(reviewId, repoId, "a".repeat(24), "correct")).toHaveProperty("error");
    expect(await setFindingFeedback(reviewId, repoId, id, "approve-merge")).toHaveProperty("error"); expect(update).not.toHaveBeenCalled();
  });
  it("writes an explicit rating with a concurrent-array guard", async () => {
    expect(await setFindingFeedback(reviewId, repoId, id, "false-positive")).toEqual({ success: true });
    expect(update).toHaveBeenCalledWith({ _id: reviewId, findings: [finding] }, { $set: { "findings.0.feedback": { label: "false-positive", userId: "user", at: expect.any(Date) } } });
  });
  it("can undo a rating and reports a conflicting rewrite", async () => {
    await setFindingFeedback(reviewId, repoId, id, "clear");
    expect(update).toHaveBeenCalledWith(expect.anything(), { $unset: { "findings.0.feedback": "" } });
    update.mockResolvedValue({ matchedCount: 0 });
    expect(await setFindingFeedback(reviewId, repoId, id, "correct")).toHaveProperty("error");
  });
});
