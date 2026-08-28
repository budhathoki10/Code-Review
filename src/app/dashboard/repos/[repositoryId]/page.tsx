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
  type ReviewDoc,
} from "@/lib/db/collections";
import { buttonClasses } from "@/lib/ui";
import { StatePanel } from "@/components/state-panel";
import { ReviewCard } from "@/components/review-card";
import { RepoSettingsForm } from "./repo-settings-form";
import { ReviewFilter, type ReviewFilterValue } from "./review-filter";

const REVIEWS_PAGE_SIZE = 8;

async function loadRepoAndReviews(
  userId: string,
  repositoryId: string,
  requestedPage: number,
  requestedFilter: ReviewFilterValue,
) {
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
  const pullRequestIds = repoPullRequests.map((pr) => String(pr._id));
  const repositoryReviewFilter = { pullRequestId: { $in: pullRequestIds } };
  const [totalReviews, reviewedPullRequestIds] =
    pullRequestIds.length > 0
      ? await Promise.all([
          reviewsCol.countDocuments(repositoryReviewFilter),
          reviewsCol.distinct("pullRequestId", repositoryReviewFilter),
        ])
      : [0, [] as string[]];
  const reviewedPullRequestIdSet = new Set(reviewedPullRequestIds);
  const selectedPullRequestId =
    requestedFilter.kind === "pull-request" &&
    pullRequestById.has(requestedFilter.pullRequestId) &&
    reviewedPullRequestIdSet.has(requestedFilter.pullRequestId)
      ? requestedFilter.pullRequestId
      : undefined;
  const filter: ReviewFilterValue = selectedPullRequestId
    ? { kind: "pull-request", pullRequestId: selectedPullRequestId }
    : requestedFilter.kind === "all"
      ? { kind: "all" }
      : { kind: "latest" };

  let filteredReviewCount = 0;
  if (filter.kind === "latest") {
    filteredReviewCount = totalReviews > 0 ? 1 : 0;
  } else if (filter.kind === "all") {
    filteredReviewCount = reviewedPullRequestIds.length;
  } else {
    filteredReviewCount = await reviewsCol.countDocuments({ pullRequestId: filter.pullRequestId });
  }

  const totalPages = Math.max(1, Math.ceil(filteredReviewCount / REVIEWS_PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);

  let repoReviews: ReviewDoc[] = [];
  if (totalReviews > 0 && filter.kind === "latest") {
    repoReviews = await reviewsCol
      .find(repositoryReviewFilter)
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
  } else if (totalReviews > 0 && filter.kind === "all") {
    repoReviews = await reviewsCol
      .aggregate<ReviewDoc>([
        { $match: repositoryReviewFilter },
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$pullRequestId", review: { $first: "$$ROOT" } } },
        { $replaceRoot: { newRoot: "$review" } },
        { $sort: { createdAt: -1 } },
        { $skip: (page - 1) * REVIEWS_PAGE_SIZE },
        { $limit: REVIEWS_PAGE_SIZE },
      ])
      .toArray();
  } else if (filter.kind === "pull-request") {
    repoReviews = await reviewsCol
      .find({ pullRequestId: filter.pullRequestId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * REVIEWS_PAGE_SIZE)
      .limit(REVIEWS_PAGE_SIZE)
      .toArray();
  }

  const filterPullRequests = repoPullRequests
    .filter((pullRequest) => reviewedPullRequestIdSet.has(String(pullRequest._id)))
    .sort((a, b) => b.githubPrNumber - a.githubPrNumber);

  return {
    repositoryDoc,
    pullRequestById,
    filterPullRequests,
    repoReviews,
    totalReviews,
    filteredReviewCount,
    totalPages,
    page,
    filter,
  };
}

function Pagination({
  page,
  totalPages,
  filter,
}: {
  page: number;
  totalPages: number;
  filter: ReviewFilterValue;
}) {
  if (totalPages <= 1) return null;

  const filterQuery =
    filter.kind === "all"
      ? "view=all&"
      : filter.kind === "pull-request"
        ? `pr=${encodeURIComponent(filter.pullRequestId)}&`
        : "";

  return (
    <nav aria-label="Review pages" className="mt-6 flex items-center justify-between">
      {page > 1 ? (
        <a href={`?${filterQuery}page=${page - 1}`} className={buttonClasses("secondary")}>
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
        <a href={`?${filterQuery}page=${page + 1}`} className={buttonClasses("secondary")}>
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
  const requestedPullRequestId =
    typeof resolvedSearchParams.pr === "string" ? resolvedSearchParams.pr : undefined;
  const requestedFilter: ReviewFilterValue = requestedPullRequestId
    ? { kind: "pull-request", pullRequestId: requestedPullRequestId }
    : resolvedSearchParams.view === "all"
      ? { kind: "all" }
      : { kind: "latest" };

  const session = await auth();

  const data = session?.user?.id
    ? await loadRepoAndReviews(session.user.id, repositoryId, page, requestedFilter)
    : null;

  if (!data) {
    notFound();
  }

  const {
    repositoryDoc,
    pullRequestById,
    filterPullRequests,
    repoReviews,
    totalReviews,
    filteredReviewCount,
    totalPages,
    page: currentPage,
    filter,
  } = data;
  const selectedPullRequest =
    filter.kind === "pull-request" ? pullRequestById.get(filter.pullRequestId) : undefined;
  const sectionTitle =
    filter.kind === "latest"
      ? "Most recent review"
      : filter.kind === "all"
        ? "All pull requests"
        : selectedPullRequest
          ? `PR #${selectedPullRequest.githubPrNumber} review history`
          : "Reviews";
  const sectionDescription =
    filter.kind === "latest"
      ? "The newest review is shown by default."
      : filter.kind === "all"
        ? `${filteredReviewCount} pull request${filteredReviewCount === 1 ? "" : "s"}, with the latest review for each.`
        : `${filteredReviewCount} review${filteredReviewCount === 1 ? "" : "s"} for this pull request.`;

  return (
    <div className="mx-auto w-full max-w-5xl">
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
              Open a review to inspect its findings and summary.
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
          <div className="mt-8 flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">{sectionTitle}</h2>
              <p className="mt-0.5 text-xs text-subtle">{sectionDescription}</p>
            </div>
            <ReviewFilter
              repositoryId={repositoryId}
              value={filter}
              pullRequests={filterPullRequests.map((pullRequest) => ({
                id: String(pullRequest._id),
                number: pullRequest.githubPrNumber,
                title: pullRequest.title,
              }))}
            />
          </div>

          <ul className="mt-3 space-y-2.5">
            {repoReviews.map((review, i) => (
              <ReviewCard
                key={String(review._id)}
                review={review}
                pullRequest={pullRequestById.get(review.pullRequestId)}
                defaultOpen={i === 0}
                accordionName="repository-review-history"
                repositoryId={repositoryId}
              />
            ))}
          </ul>

          <Pagination page={currentPage} totalPages={totalPages} filter={filter} />
        </>
      )}
    </div>
  );
}
