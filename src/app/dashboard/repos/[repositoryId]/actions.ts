"use server";

import { ObjectId } from "mongodb";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { getGithubAccountIds } from "@/lib/github/account";
import { installations, pullRequests, repositories, reviews } from "@/lib/db/collections";
import { findingId } from "@/lib/review/finding-policy";

/** Ownership is checked on every invocation; never trust IDs sent by the client. */
export async function setFindingFeedback(reviewId: string, repositoryId: string, id: string, label: string) {
  if (!["correct", "false-positive", "duplicate", "clear"].includes(label) || !/^[a-f0-9]{24}$/.test(id)) return { error: "Invalid feedback." };
  const session = await auth();
  if (!session?.user?.id || !ObjectId.isValid(reviewId) || !ObjectId.isValid(repositoryId)) return { error: "Sign in to rate this finding." };
  const githubUserIds = await getGithubAccountIds(session.user.id);
  const repositoryDoc = await (await repositories()).findOne({ _id: new ObjectId(repositoryId) as unknown as string });
  if (!repositoryDoc) return { error: "Review unavailable." };
  const installation = await (await installations()).findOne({
    _id: new ObjectId(repositoryDoc.installationId) as unknown as string, githubUserId: { $in: githubUserIds },
  });
  if (!installation) return { error: "Review unavailable." };
  const collection = await reviews();
  const review = await collection.findOne({ _id: new ObjectId(reviewId) as unknown as string });
  if (!review || review.status !== "completed" || !ObjectId.isValid(review.pullRequestId)) return { error: "Review unavailable." };
  const pr = await (await pullRequests()).findOne({ _id: new ObjectId(review.pullRequestId) as unknown as string, repositoryId });
  if (!pr) return { error: "Review unavailable." };
  const index = review.findings.findIndex((finding) => findingId(finding) === id);
  if (index < 0) return { error: "Finding unavailable." };
  const path = `findings.${index}.feedback`;
  // Compare the array read above so a concurrent pipeline rewrite cannot attach
  // a rating to a different finding at the same array index.
  const updated = await collection.updateOne({ _id: review._id, findings: review.findings }, label === "clear"
    ? { $unset: { [path]: "" } }
    : { $set: { [path]: { label, userId: session.user.id, at: new Date() } } });
  if (updated.matchedCount !== 1) return { error: "The review changed. Refresh and try again." };
  revalidatePath(`/dashboard/repos/${repositoryId}`);
  return { success: true };
}

/**
 * Deletes a single review record. Scoped through repository -> installation
 * -> user ownership (same chain `loadRepoAndReviews` uses) so a user can
 * never delete a review that belongs to a repo they don't own, even by
 * guessing a reviewId.
 */
export async function deleteReview(reviewId: string, repositoryId: string) {
  const session = await auth();
  if (!session?.user?.id || !ObjectId.isValid(reviewId) || !ObjectId.isValid(repositoryId)) return;

  const githubUserIds = await getGithubAccountIds(session.user.id);
  if (githubUserIds.length === 0) return;

  const installationsCol = await installations();
  const userInstallations = await installationsCol.find({ githubUserId: { $in: githubUserIds } }).toArray();
  const installationIds = userInstallations.map((i) => String(i._id));

  const repositoriesCol = await repositories();
  const repositoryDoc = await repositoriesCol.findOne({
    _id: new ObjectId(repositoryId) as unknown as string,
    installationId: { $in: installationIds },
  });
  if (!repositoryDoc) return;

  const pullRequestsCol = await pullRequests();
  const repoPullRequestIds = (
    await pullRequestsCol.find({ repositoryId }).project({ _id: 1 }).toArray()
  ).map((pr) => String(pr._id));

  const reviewsCol = await reviews();
  await reviewsCol.deleteOne({
    _id: new ObjectId(reviewId) as unknown as string,
    pullRequestId: { $in: repoPullRequestIds },
  });

  revalidatePath(`/dashboard/repos/${repositoryId}`);
  revalidatePath("/dashboard");
}
