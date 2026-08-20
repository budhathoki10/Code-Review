import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";
import { ChevronLeft, ChevronRight, GitPullRequest } from "lucide-react";
import { auth } from "@/auth";
import { getGithubAccountId } from "@/lib/github/account";
import {
  installations,
  pullRequests,
  repositories,
  reviews,
  type PullRequestDoc,
} from "@/lib/db/collections";
import { buttonClasses } from "@/lib/ui";
import { StatePanel } from "@/components/state-panel";
import { ReviewCard } from "@/components/review-card";
import { RepoSettingsForm } from "./repo-settings-form";

const REVIEWS_PAGE_SIZE = 8;

async function loadRepoAndReviews(userId: string, repositoryId: string, requestedPage: number) {
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
  const reviewFilter = { pullRequestId: { $in: repoPullRequests.map((pr) => String(pr._id)) } };

  const totalReviews = repoPullRequests.length > 0 ? await reviewsCol.countDocuments(reviewFilter) : 0;
  const totalPages = Math.max(1, Math.ceil(totalReviews / REVIEWS_PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);

  const repoReviews =
    repoPullRequests.length > 0
      ? await reviewsCol
          .find(reviewFilter)
          .sort({ createdAt: -1 })
          .skip((page - 1) * REVIEWS_PAGE_SIZE)
          .limit(REVIEWS_PAGE_SIZE)
          .toArray()
      : [];

  return { repositoryDoc, pullRequestById, repoReviews, totalReviews, totalPages, page };
}

function Pagination({ page, totalPages }: { page: number; totalPages: number }) {
  if (totalPages <= 1) return null;

  return (
    <nav aria-label="Review pages" className="mt-6 flex items-center justify-between">
      {page > 1 ? (
        <a href={`?page=${page - 1}`} className={buttonClasses("secondary")}>
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Previous
        </a>
      ) : (
        <span aria-disabled="true" className={`${buttonClasses("secondary")} pointer-events-none opacity-50`}>
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Previous
        </span>
      )}

      <span className="text-xs tabular-nums text-muted">
        Page {page} of {totalPages}
      </span>

      {page < totalPages ? (
        <a href={`?page=${page + 1}`} className={buttonClasses("secondary")}>
          Next
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </a>
      ) : (
        <span aria-disabled="true" className={`${buttonClasses("secondary")} pointer-events-none opacity-50`}>
          Next
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </span>
      )}
    </nav>
  );
}

export default async function RepositoryReviewsPage({
  params,
  searchParams,
}: PageProps<"/dashboard/repos/[repositoryId]">) {
  const { repositoryId } = await params;
  const resolvedSearchParams = await searchParams;
  const requestedPage = Number(resolvedSearchParams.page);
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const session = await auth();

  const data = session?.user?.id
    ? await loadRepoAndReviews(session.user.id, repositoryId, page)
    : null;

  if (!data) {
    notFound();
  }

  const { repositoryDoc, pullRequestById, repoReviews, totalReviews, totalPages, page: currentPage } = data;

  return (
    <div className="w-full max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.035em] text-foreground">
            {repositoryDoc.fullName}
            {totalReviews > 0 && (
              <span className="ml-1 font-normal tabular-nums text-subtle">
                · {totalReviews} review{totalReviews === 1 ? "" : "s"}
              </span>
            )}
          </h1>
          {totalReviews > 0 && (
            <p className="mt-2 text-sm text-muted">
              Select a pull request to inspect its review. Opening another closes the current one.
            </p>
          )}
        </div>
        <RepoSettingsForm repositoryId={repositoryId} config={repositoryDoc.config} />
      </div>

      {totalReviews === 0 ? (
        <div className="mt-6">
          <StatePanel
            icon={<GitPullRequest className="h-5 w-5" aria-hidden="true" />}
            title="No reviews yet"
            description="One will appear here automatically the next time a pull request is opened or updated on this repository."
          />
        </div>
      ) : (
        <>
          <ul className="mt-8 space-y-2.5">
            {repoReviews.map((review, i) => (
              <ReviewCard
                key={String(review._id)}
                review={review}
                pullRequest={pullRequestById.get(review.pullRequestId)}
                defaultOpen={currentPage === 1 && i === 0}
                accordionName="repository-review-history"
                repositoryId={repositoryId}
              />
            ))}
          </ul>

          <Pagination page={currentPage} totalPages={totalPages} />
        </>
      )}
    </div>
  );
}
