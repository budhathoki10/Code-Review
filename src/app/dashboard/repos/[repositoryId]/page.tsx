import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";
import { ChevronLeft, ChevronRight, GitPullRequest } from "lucide-react";
import { auth } from "@/auth";
import { getGithubAccountIds } from "@/lib/github/account";
import {
  findingFeedback,
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
import { RunFilter, type RunOption } from "./run-filter";

const REVIEWS_PAGE_SIZE = 8;

async function loadRepoAndReviews(
  userId: string,
  repositoryId: string,
  requestedPage: number,
  requestedFilter: ReviewFilterValue,
  /** Which run of the selected pull request to show; undefined means the latest. */
  requestedRun: number | "all" | undefined,
) {
  if (!ObjectId.isValid(repositoryId)) return null;

  const githubUserIds = await getGithubAccountIds(userId);
  if (githubUserIds.length === 0) return null;

  const repositoriesCol = await repositories();
  const repositoryDoc = await repositoriesCol.findOne({
    _id: new ObjectId(repositoryId) as unknown as string,
  });
  if (!repositoryDoc) return null;

  // Ownership check: the repo's installation must belong to one of this
  // user's linked GitHub accounts.
  const installationsCol = await installations();
  const installationDoc = await installationsCol.findOne({
    _id: new ObjectId(repositoryDoc.installationId) as unknown as string,
    githubUserId: { $in: githubUserIds },
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

  // One pull request's reviews are a series of runs, numbered from its first.
  // Only one is shown at a time: the others describe commits that have since
  // been pushed over, and stacking them meant scrolling past superseded
  // reviews to reach the one that describes the branch now. "All runs" is
  // still reachable from the picker.
  const runCount = filter.kind === "pull-request" ? filteredReviewCount : 0;
  const selectedRun: number | "all" | undefined =
    filter.kind === "pull-request" && runCount > 0
      ? requestedRun === "all"
        ? "all"
        : typeof requestedRun === "number" && requestedRun >= 1 && requestedRun <= runCount
          ? requestedRun
          : runCount
      : undefined;
  const showsSingleRun = typeof selectedRun === "number";

  const totalPages = showsSingleRun ? 1 : Math.max(1, Math.ceil(filteredReviewCount / REVIEWS_PAGE_SIZE));
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
    // Run N is the Nth review counting from the first, and the query sorts
    // newest first — so the one being asked for sits `runCount - N` rows down.
    // Fetched directly rather than by loading the history and picking from it,
    // which is the difference between one document and all of them on a pull
    // request that has been pushed to fifty times.
    const skip = showsSingleRun ? runCount - (selectedRun as number) : (page - 1) * REVIEWS_PAGE_SIZE;
    repoReviews = await reviewsCol
      .find({ pullRequestId: filter.pullRequestId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(showsSingleRun ? 1 : REVIEWS_PAGE_SIZE)
      .toArray();
  }

  const filterPullRequests = repoPullRequests
    .filter((pullRequest) => reviewedPullRequestIdSet.has(String(pullRequest._id)))
    .sort((a, b) => b.githubPrNumber - a.githubPrNumber);

  // Which findings on this page a maintainer already marked as not a bug, so
  // the control renders in the state it was left in. Scoped to the reviews
  // actually shown rather than the whole repository — the list is only ever
  // read per card, and a repository with a long history should not pay for
  // all of it on every page load.
  const notABugByReview = new Map<string, string[]>();
  if (repoReviews.length > 0) {
    const marks = await (await findingFeedback())
      .find({ reviewId: { $in: repoReviews.map((review) => String(review._id)) } })
      .toArray()
      .catch(() => []);
    for (const mark of marks) {
      notABugByReview.set(mark.reviewId, [...(notABugByReview.get(mark.reviewId) ?? []), mark.findingId]);
    }
  }

  // Just the commit of each run, for the picker's labels. Projected rather
  // than loaded whole: the picker needs two fields, and the reviews it lists
  // are the ones deliberately NOT being rendered.
  const runOptions: RunOption[] =
    filter.kind === "pull-request" && runCount > 0
      ? (await reviewsCol
          .find({ pullRequestId: filter.pullRequestId }, { projection: { headSha: 1 } })
          .sort({ createdAt: -1 })
          .toArray()
        ).map((review, index) => ({ number: runCount - index, sha: review.headSha }))
      : [];

  return {
    repositoryDoc,
    pullRequestById,
    filterPullRequests,
    notABugByReview,
    repoReviews,
    totalReviews,
    filteredReviewCount,
    totalPages,
    page,
    filter,
    runOptions,
    selectedRun,
    runCount,
  };
}

function Pagination({
  page,
  totalPages,
  filter,
  selectedRun,
}: {
  page: number;
  totalPages: number;
  filter: ReviewFilterValue;
  /** Carried into the page links, or the next page would snap back to the latest run. */
  selectedRun?: number | "all";
}) {
  if (totalPages <= 1) return null;

  // Pagination only ever appears under "all runs" — a single run is a single
  // row — but the parameter has to survive the link, since leaving it out
  // means page two silently reverts to showing just the newest review.
  const runQuery = selectedRun === "all" ? "run=all&" : "";
  const filterQuery =
    filter.kind === "all"
      ? "view=all&"
      : filter.kind === "pull-request"
        ? `pr=${encodeURIComponent(filter.pullRequestId)}&${runQuery}`
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
  // Absent, or anything that is not a run number, means the latest run — the
  // loader clamps it to a run that exists rather than rendering an empty page
  // for "?run=99".
  const rawRun = resolvedSearchParams.run;
  const requestedRun: number | "all" | undefined =
    rawRun === "all"
      ? "all"
      : typeof rawRun === "string" && Number.isInteger(Number(rawRun))
        ? Number(rawRun)
        : undefined;

  const session = await auth();

  const data = session?.user?.id
    ? await loadRepoAndReviews(session.user.id, repositoryId, page, requestedFilter, requestedRun)
    : null;

  if (!data) {
    notFound();
  }

  const {
    repositoryDoc,
    pullRequestById,
    filterPullRequests,
    notABugByReview,
    repoReviews,
    totalReviews,
    filteredReviewCount,
    totalPages,
    page: currentPage,
    filter,
    runOptions,
    selectedRun,
    runCount,
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
        // Says what is on screen, not just what exists. "2 reviews for this
        // pull request" above a single card reads as a rendering fault.
        : typeof selectedRun === "number" && runCount > 1
          ? `Run ${selectedRun} of ${runCount}${selectedRun === runCount ? " — the latest" : ""}. Use the run picker to see the others.`
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
            <div className="flex flex-wrap items-center gap-2">
              {/* Only where there is a choice to make: one review of a pull
                  request is not a series, and a picker offering a single
                  option is a control that cannot do anything. */}
              {filter.kind === "pull-request" && selectedRun !== undefined && runCount > 1 && (
                <RunFilter
                  repositoryId={repositoryId}
                  pullRequestId={filter.pullRequestId}
                  runs={runOptions}
                  selected={selectedRun}
                />
              )}
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
                repoFullName={repositoryDoc.fullName}
                notABugIds={notABugByReview.get(String(review._id))}
                // Only one pull request's history is a sequence. The other two
                // filters list a different pull request per row, where "run 2"
                // would be numbering unrelated things.
                //
                // Counted against the pull request's whole history, not this
                // page of it: a single selected run is one row that is not
                // necessarily the newest, and under "all runs" page two would
                // otherwise restart the numbering from the top.
                runNumber={
                  filter.kind === "pull-request" && selectedRun !== undefined
                    ? typeof selectedRun === "number"
                      ? selectedRun
                      : runCount - ((currentPage - 1) * REVIEWS_PAGE_SIZE + i)
                    : undefined
                }
                isLatestRun={
                  filter.kind === "pull-request" &&
                  runCount > 1 &&
                  (typeof selectedRun === "number"
                    ? selectedRun === runCount
                    : currentPage === 1 && i === 0)
                }
              />
            ))}
          </ul>

          <Pagination page={currentPage} totalPages={totalPages} filter={filter} selectedRun={selectedRun} />
        </>
      )}
    </div>
  );
}
