"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { getGithubAccountId } from "@/lib/github/account";
import { installations, repositories } from "@/lib/db/collections";

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
