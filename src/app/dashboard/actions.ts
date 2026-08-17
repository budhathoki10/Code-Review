"use server";

import { ObjectId } from "mongodb";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { getGithubAccountId } from "@/lib/github/account";
import { installations, repositories, type RepositoryDoc } from "@/lib/db/collections";

/**
 * Removes a repository from this app's tracking only — does not touch the
 * GitHub App installation itself. Scoped to the current user's own
 * installations so one user can never disconnect another user's repo by
 * guessing a githubRepoId.
 */
export async function disconnectRepository(githubRepoId: number) {
  const session = await auth();
  if (!session?.user?.id) return;

  const githubUserId = await getGithubAccountId(session.user.id);
  if (!githubUserId) return;

  const installationsCol = await installations();
  const userInstallations = await installationsCol
    .find({ githubUserId })
    .toArray();
  const installationIds = userInstallations.map((i) => String(i._id));

  const repositoriesCol = await repositories();
  await repositoriesCol.deleteOne({
    githubRepoId,
    installationId: { $in: installationIds },
  });

  revalidatePath("/dashboard");
}

/**
 * Persists the repo-level review config (Phase 6 code intelligence): a
 * minimum severity to post to GitHub / gate the check run on, and free-text
 * instructions appended to the AI reviewer's prompt. Same ownership-check
 * pattern as `disconnectRepository`.
 */
export async function updateRepositoryConfig(
  repositoryId: string,
  config: RepositoryDoc["config"],
) {
  const session = await auth();
  if (!session?.user?.id || !ObjectId.isValid(repositoryId)) return;

  const githubUserId = await getGithubAccountId(session.user.id);
  if (!githubUserId) return;

  const installationsCol = await installations();
  const userInstallations = await installationsCol.find({ githubUserId }).toArray();
  const installationIds = userInstallations.map((i) => String(i._id));

  const repositoriesCol = await repositories();
  await repositoriesCol.updateOne(
    {
      _id: new ObjectId(repositoryId) as unknown as string,
      installationId: { $in: installationIds },
    },
    { $set: { config } },
  );

  revalidatePath(`/dashboard/repos/${repositoryId}`);
}
