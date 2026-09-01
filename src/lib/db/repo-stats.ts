import {
  installations,
  pullRequests,
  repositories,
  reviews,
  type FindingDoc,
  type PullRequestDoc,
  type ReviewDoc,
} from "@/lib/db/collections";
import { getGithubAccountIds } from "@/lib/github/account";

export interface RepoStats {
  lastReviewAt?: Date;
  totalReviews: number;
  latestStatus?: ReviewDoc["status"];
  latestVerdict?: "approve" | "request_changes" | "comment";
  severityCounts: Partial<Record<FindingDoc["severity"], number>>;
}

/**
 * Two bounded queries (not N+1 per repo): pull_requests for the given repos,
 * then reviews for those PRs, reduced in memory. Cheap at dashboard page
 * size (PAGE_SIZE repos at a time). Severity counts come from only the
 * latest review per PR — "current state," not a lifetime total.
 */
export async function loadRepoStats(repositoryIds: string[]): Promise<Map<string, RepoStats>> {
  const stats = new Map<string, RepoStats>();
  if (repositoryIds.length === 0) return stats;

  const pullRequestsCol = await pullRequests();
  const prs = await pullRequestsCol
    .find({ repositoryId: { $in: repositoryIds } }, { projection: { _id: 1, repositoryId: 1 } })
    .toArray();
  if (prs.length === 0) return stats;

  const repoIdByPrId = new Map(prs.map((pr) => [String(pr._id), pr.repositoryId]));

  const reviewsCol = await reviews();
  const allReviews = await reviewsCol
    .find(
      { pullRequestId: { $in: [...repoIdByPrId.keys()] } },
      { projection: { pullRequestId: 1, createdAt: 1, findings: 1, verdict: 1, status: 1 } },
    )
    .sort({ createdAt: -1 })
    .toArray();

  const latestReviewPerPr = new Map<string, (typeof allReviews)[number]>();
  for (const review of allReviews) {
    if (!latestReviewPerPr.has(review.pullRequestId)) {
      latestReviewPerPr.set(review.pullRequestId, review);
    }
  }

  for (const review of allReviews) {
    const repositoryId = repoIdByPrId.get(review.pullRequestId);
    if (!repositoryId) continue;

    const entry = stats.get(repositoryId) ?? { totalReviews: 0, severityCounts: {} };
    entry.totalReviews += 1;
    if (!entry.lastReviewAt || review.createdAt > entry.lastReviewAt) {
      entry.lastReviewAt = review.createdAt;
    }
    stats.set(repositoryId, entry);
  }

  for (const [pullRequestId, review] of latestReviewPerPr) {
    const repositoryId = repoIdByPrId.get(pullRequestId);
    if (!repositoryId) continue;

    const entry = stats.get(repositoryId);
    if (!entry) continue;

    entry.latestStatus = review.status;
    if (review.status === "completed" && review.verdict) {
      entry.latestVerdict = review.verdict;
    }
    for (const finding of review.findings) {
      entry.severityCounts[finding.severity] = (entry.severityCounts[finding.severity] ?? 0) + 1;
    }
  }

  return stats;
}

export interface RepoSummary {
  id: string;
  fullName: string;
  health: "critical" | "attention" | "clean" | "unreviewed";
  lastActivityAt?: Date;
}

function healthFor(stats: RepoStats | undefined): RepoSummary["health"] {
  if (!stats || stats.totalReviews === 0) return "unreviewed";
  if ((stats.severityCounts.critical ?? 0) + (stats.severityCounts.high ?? 0) > 0) return "critical";
  if (stats.latestVerdict === "request_changes") return "attention";
  return "clean";
}

/** Full (unpaginated) repo list for the dashboard sidebar's repo switcher — deliberately lightweight, no findings payload. */
export async function loadRepoSummaries(userId: string): Promise<RepoSummary[]> {
  const githubUserIds = await getGithubAccountIds(userId);
  if (githubUserIds.length === 0) return [];

  const installationsCol = await installations();
  const userInstallations = await installationsCol.find({ githubUserId: { $in: githubUserIds } }).toArray();
  if (userInstallations.length === 0) return [];

  const repositoriesCol = await repositories();
  const repos = await repositoriesCol
    .find(
      { installationId: { $in: userInstallations.map((i) => String(i._id)) } },
      { projection: { _id: 1, fullName: 1 } },
    )
    .sort({ fullName: 1 })
    .toArray();

  const stats = await loadRepoStats(repos.map((repo) => String(repo._id)));

  return repos
    .map((repo) => {
      const repoStats = stats.get(String(repo._id));
      return {
        id: String(repo._id),
        fullName: repo.fullName,
        health: healthFor(repoStats),
        lastActivityAt: repoStats?.lastReviewAt,
      };
    })
    .sort((a, b) => {
      if (a.lastActivityAt && b.lastActivityAt) return b.lastActivityAt.getTime() - a.lastActivityAt.getTime();
      if (a.lastActivityAt) return -1;
      if (b.lastActivityAt) return 1;
      return a.fullName.localeCompare(b.fullName);
    });
}

export interface LatestReview {
  repository: { id: string; fullName: string };
  pullRequest: PullRequestDoc;
  review: ReviewDoc;
}

/** Most recent review across all of the user's repos — powers the dashboard's default "latest review" spotlight. */
export async function loadLatestReview(userId: string): Promise<LatestReview | null> {
  const githubUserIds = await getGithubAccountIds(userId);
  if (githubUserIds.length === 0) return null;

  const installationsCol = await installations();
  const userInstallations = await installationsCol.find({ githubUserId: { $in: githubUserIds } }).toArray();
  if (userInstallations.length === 0) return null;

  const repositoriesCol = await repositories();
  const repos = await repositoriesCol
    .find(
      { installationId: { $in: userInstallations.map((i) => String(i._id)) } },
      { projection: { _id: 1, fullName: 1 } },
    )
    .toArray();
  if (repos.length === 0) return null;

  const repoIds = repos.map((r) => String(r._id));
  const pullRequestsCol = await pullRequests();
  const prs = await pullRequestsCol.find({ repositoryId: { $in: repoIds } }).toArray();
  if (prs.length === 0) return null;

  const prIds = prs.map((pr) => String(pr._id));
  const reviewsCol = await reviews();
  const [latestReview] = await reviewsCol
    .find({ pullRequestId: { $in: prIds } })
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray();
  if (!latestReview) return null;

  const pullRequest = prs.find((pr) => String(pr._id) === latestReview.pullRequestId);
  if (!pullRequest) return null;

  const repository = repos.find((r) => String(r._id) === pullRequest.repositoryId);
  if (!repository) return null;

  return {
    repository: { id: String(repository._id), fullName: repository.fullName },
    pullRequest,
    review: latestReview,
  };
}

export interface UserOverviewStats {
  totalRepos: number;
  reviewsLast7Days: number;
  needsAttention: number;
}

/** Powers the small stat-tile row above the repo list. */
export async function loadUserOverviewStats(userId: string): Promise<UserOverviewStats> {
  const empty: UserOverviewStats = { totalRepos: 0, reviewsLast7Days: 0, needsAttention: 0 };

  const githubUserIds = await getGithubAccountIds(userId);
  if (githubUserIds.length === 0) return empty;

  const installationsCol = await installations();
  const userInstallations = await installationsCol.find({ githubUserId: { $in: githubUserIds } }).toArray();
  if (userInstallations.length === 0) return empty;

  const installationIds = userInstallations.map((i) => String(i._id));
  const repositoriesCol = await repositories();
  const repoIds = (
    await repositoriesCol
      .find({ installationId: { $in: installationIds } }, { projection: { _id: 1 } })
      .toArray()
  ).map((r) => String(r._id));

  if (repoIds.length === 0) return { ...empty, totalRepos: 0 };

  const stats = await loadRepoStats(repoIds);

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  let reviewsLast7Days = 0;
  let needsAttention = 0;

  const pullRequestsCol = await pullRequests();
  const prs = await pullRequestsCol
    .find({ repositoryId: { $in: repoIds } }, { projection: { _id: 1 } })
    .toArray();
  const prIds = prs.map((pr) => String(pr._id));

  if (prIds.length > 0) {
    const reviewsCol = await reviews();
    reviewsLast7Days = await reviewsCol.countDocuments({
      pullRequestId: { $in: prIds },
      createdAt: { $gte: sevenDaysAgo },
    });
  }

  for (const repoStats of stats.values()) {
    const hasCriticalOrHigh = (repoStats.severityCounts.critical ?? 0) + (repoStats.severityCounts.high ?? 0) > 0;
    if (repoStats.latestVerdict === "request_changes" || hasCriticalOrHigh) {
      needsAttention += 1;
    }
  }

  return { totalRepos: repoIds.length, reviewsLast7Days, needsAttention };
}
