import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";
import { GitPullRequest } from "lucide-react";
import { auth } from "@/auth";
import { getGithubAccountId } from "@/lib/github/account";
import {
  installations,
  pullRequests,
  repositories,
  reviews,
  type PullRequestDoc,
} from "@/lib/db/collections";
import { StatePanel } from "@/components/state-panel";
import { ReviewCard } from "@/components/review-card";
import { RepoSettingsForm } from "./repo-settings-form";

async function loadRepoAndReviews(userId: string, repositoryId: string) {
  if (!ObjectId.isValid(repositoryId)) return null;

  const githubUserId = await getGithubAccountId(userId);
  if (!githubUserId) return null;

  const repositoriesCol = await repositories();
  const repositoryDoc = await repositoriesCol.findOne({
    _id: new ObjectId(repositoryId) as unknown as string,
  });
  if (!repositoryDoc) return null;

  // Ownership check: the repo's installation must belong to this user.
  const installationsCol = await installations();
  const installationDoc = await installationsCol.findOne({
    _id: new ObjectId(repositoryDoc.installationId) as unknown as string,
    githubUserId,
  });
  if (!installationDoc) return null;

  const pullRequestsCol = await pullRequests();
  const repoPullRequests = await pullRequestsCol
    .find({ repositoryId })
    .toArray();

  const pullRequestById = new Map<string, PullRequestDoc>(
    repoPullRequests.map((pr) => [String(pr._id), pr]),
  );

  const reviewsCol = await reviews();
  const repoReviews =
    repoPullRequests.length > 0
      ? await reviewsCol
          .find({
            pullRequestId: { $in: repoPullRequests.map((pr) => String(pr._id)) },
          })
          .sort({ createdAt: -1 })
          .toArray()
      : [];

  return { repositoryDoc, pullRequestById, repoReviews };
}

export default async function RepositoryReviewsPage({
  params,
}: PageProps<"/dashboard/repos/[repositoryId]">) {
  const { repositoryId } = await params;
  const session = await auth();

  const data = session?.user?.id
    ? await loadRepoAndReviews(session.user.id, repositoryId)
    : null;

  if (!data) {
    notFound();
  }

  const { repositoryDoc, pullRequestById, repoReviews } = data;

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          {repositoryDoc.fullName}
          {repoReviews.length > 0 && (
            <span className="ml-1 font-normal tabular-nums text-subtle">
              · {repoReviews.length} review{repoReviews.length === 1 ? "" : "s"}
            </span>
          )}
        </h2>
        <RepoSettingsForm repositoryId={repositoryId} config={repositoryDoc.config} />
      </div>

      {repoReviews.length === 0 ? (
        <div className="mt-6">
          <StatePanel
            icon={<GitPullRequest className="h-5 w-5" aria-hidden="true" />}
            title="No reviews yet"
            description="One will appear here automatically the next time a pull request is opened or updated on this repository."
          />
        </div>
      ) : (
        <ul className="mt-6 space-y-4">
          {repoReviews.map((review, i) => (
            <ReviewCard
              key={String(review._id)}
              review={review}
              pullRequest={pullRequestById.get(review.pullRequestId)}
              defaultOpen={i === 0}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
