"use server";

import { ObjectId } from "mongodb";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { getGithubAccountIds } from "@/lib/github/account";
import { installations, repositories, type RepositoryDoc } from "@/lib/db/collections";
import { normalizeDisabledSeverities } from "@/lib/review/severity";
import { REVIEW_CATEGORIES } from "@/lib/review/config";

/**
 * Removes a repository from this app's tracking only — does not touch the
 * GitHub App installation itself. Scoped to the current user's own
 * installations so one user can never disconnect another user's repo by
 * guessing a githubRepoId.
 */
export async function disconnectRepository(githubRepoId: number) {
  const session = await auth();
  if (!session?.user?.id) return;

  const githubUserIds = await getGithubAccountIds(session.user.id);
  if (githubUserIds.length === 0) return;

  const installationsCol = await installations();
  const userInstallations = await installationsCol
    .find({ githubUserId: { $in: githubUserIds } })
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

  const githubUserIds = await getGithubAccountIds(session.user.id);
  if (githubUserIds.length === 0) return;

  const installationsCol = await installations();
  const userInstallations = await installationsCol.find({ githubUserId: { $in: githubUserIds } }).toArray();
  const installationIds = userInstallations.map((i) => String(i._id));

  // Validated here, not just in the form: this is the only boundary every
  // write has to pass, and a config with every category or every severity
  // switched off would leave a reviewer that still costs a model call per PR
  // and can never report anything. Dropping the list back to empty restores
  // the default (review everything) rather than rejecting the whole save, so
  // the user's other edits in the same submission are not lost.
  const safeConfig: RepositoryDoc["config"] = {
    ...config,
    disabledCategories:
      config?.disabledCategories && config.disabledCategories.length >= REVIEW_CATEGORIES.length
        ? []
        : config?.disabledCategories,
    disabledSeverities: normalizeDisabledSeverities(config?.disabledSeverities),
  };

  const repositoriesCol = await repositories();
  await repositoriesCol.updateOne(
    {
      _id: new ObjectId(repositoryId) as unknown as string,
      installationId: { $in: installationIds },
    },
    { $set: { config: safeConfig } },
  );

  revalidatePath(`/dashboard/repos/${repositoryId}`);
}
