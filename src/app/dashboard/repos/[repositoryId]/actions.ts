"use server";

import { ObjectId } from "mongodb";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { getGithubAccountIds } from "@/lib/github/account";
import { installations, pullRequests, repositories, reviews } from "@/lib/db/collections";

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
