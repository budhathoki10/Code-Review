import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";
import { auth } from "@/auth";
import { getGithubAccountId } from "@/lib/github/account";
import {
  installations,
  pullRequests,
  repositories,
  reviews,
  type FindingDoc,
  type PullRequestDoc,
  type ReviewDoc,
} from "@/lib/db/collections";

const SEVERITY_STYLES: Record<FindingDoc["severity"], string> = {
  critical: "text-red-600 dark:text-red-400",
  high: "text-red-600 dark:text-red-400",
  medium: "text-amber-600 dark:text-amber-400",
  low: "text-muted",
  info: "text-muted",
};

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

function StatusBadge({ status }: { status: ReviewDoc["status"] }) {
  const styles: Record<ReviewDoc["status"], string> = {
    completed: "text-foreground",
    pending: "text-muted",
    failed: "text-red-600 dark:text-red-400",
  };
  return (
    <span className={`text-xs font-medium ${styles[status]}`}>{status}</span>
  );
}

function VerdictBadge({ verdict }: { verdict: NonNullable<ReviewDoc["verdict"]> }) {
  const styles: Record<NonNullable<ReviewDoc["verdict"]>, string> = {
    approve: "text-emerald-600 dark:text-emerald-400",
    request_changes: "text-red-600 dark:text-red-400",
    comment: "text-amber-600 dark:text-amber-400",
  };
  const labels: Record<NonNullable<ReviewDoc["verdict"]>, string> = {
    approve: "Approve",
    request_changes: "Request changes",
    comment: "Comment",
  };
  return (
    <span className={`text-xs font-semibold ${styles[verdict]}`}>
      {labels[verdict]}
    </span>
  );
}

function ReviewCard({
  review,
  pullRequest,
}: {
  review: ReviewDoc;
  pullRequest: PullRequestDoc | undefined;
}) {
  return (
    <li className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium text-foreground">
          {pullRequest ? `#${pullRequest.githubPrNumber} — ${pullRequest.title}` : "Unknown PR"}
        </span>
        <div className="flex shrink-0 items-center gap-3">
          {review.verdict && <VerdictBadge verdict={review.verdict} />}
          <StatusBadge status={review.status} />
        </div>
      </div>

      {review.summary && (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-sans text-sm leading-relaxed text-muted">
          {review.summary}
        </pre>
      )}

      {review.findings.length > 0 && (
        <ul className="mt-4 space-y-3 border-t border-border pt-4">
          {review.findings.map((finding, i) => (
            <li key={i} className="text-sm">
              <p className="font-medium">
                <span className={SEVERITY_STYLES[finding.severity]}>
                  {finding.severity}
                </span>{" "}
                <span className="text-muted">· {finding.category}</span>{" "}
                <span className="text-foreground">— {finding.title}</span>
              </p>
              <p className="mt-1 text-xs text-muted">
                {finding.file}
                {finding.line ? `:${finding.line}` : ""}
              </p>
              <p className="mt-1 text-muted">{finding.explanation}</p>
              {finding.suggestion && (
                <pre className="mt-2 overflow-x-auto rounded-md bg-card p-2 text-xs">
                  {finding.suggestion}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
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
    <div className="mx-auto w-full max-w-3xl">
      <h2 className="text-lg font-semibold tracking-tight text-foreground">
        {repositoryDoc.fullName}
      </h2>

      {repoReviews.length === 0 ? (
        <p className="mt-6 text-sm text-muted">
          No reviews yet — one will appear here automatically the next time a
          pull request is opened or updated on this repository.
        </p>
      ) : (
        <ul className="mt-6 space-y-4">
          {repoReviews.map((review) => (
            <ReviewCard
              key={String(review._id)}
              review={review}
              pullRequest={pullRequestById.get(review.pullRequestId)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
