import Link from "next/link";
import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";
import { ArrowLeft, GitPullRequest } from "lucide-react";
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
import { toneDotClasses, toneTextClasses, type Tone } from "@/lib/ui";
import { StatePanel } from "@/components/state-panel";
import { Markdown } from "@/components/markdown";
import { DiffBlock } from "@/components/diff-block";
import { RepoSettingsForm } from "./repo-settings-form";

const SEVERITY_TONE: Record<FindingDoc["severity"], Tone> = {
  critical: "danger",
  high: "danger",
  medium: "warning",
  low: "neutral",
  info: "neutral",
};

const VERDICT_TONE: Record<NonNullable<ReviewDoc["verdict"]>, Tone> = {
  approve: "success",
  request_changes: "danger",
  comment: "warning",
};

const VERDICT_LABEL: Record<NonNullable<ReviewDoc["verdict"]>, string> = {
  approve: "Approve",
  request_changes: "Request changes",
  comment: "Comment",
};

const STATUS_TONE: Record<ReviewDoc["status"], Tone> = {
  completed: "neutral",
  pending: "info",
  failed: "danger",
};

const STATUS_LABEL: Record<ReviewDoc["status"], string> = {
  completed: "Completed",
  pending: "Pending",
  failed: "Failed",
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
  const tone = STATUS_TONE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${toneTextClasses(tone)}`}>
      <span className={toneDotClasses(tone)} />
      {STATUS_LABEL[status]}
    </span>
  );
}

function VerdictBadge({ verdict }: { verdict: NonNullable<ReviewDoc["verdict"]> }) {
  const tone = VERDICT_TONE[verdict];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${toneTextClasses(tone)}`}>
      <span className={toneDotClasses(tone)} />
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

function FindingItem({ finding }: { finding: FindingDoc }) {
  const tone = SEVERITY_TONE[finding.severity];
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={`inline-flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase ${toneTextClasses(tone)}`}
        >
          <span className={toneDotClasses(tone)} />
          {finding.severity}
        </span>
        <span className="text-xs text-subtle">· {finding.category}</span>
      </div>
      <p className="mt-1.5 text-sm font-medium text-foreground">
        {finding.title}
        {finding.source === "static-analysis" && (
          <span className="ml-2 rounded border border-border px-1.5 py-0.5 align-middle text-[10px] font-medium tracking-wide text-subtle uppercase">
            Static analysis
          </span>
        )}
      </p>
      <p className="mt-1 font-mono text-xs text-subtle">
        {finding.file}
        {finding.line ? `:${finding.line}` : ""}
      </p>
      <p className="mt-2 text-sm leading-relaxed text-muted">{finding.explanation}</p>
      {finding.suggestion && <DiffBlock diff={finding.suggestion} className="mt-3" />}
    </li>
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
    <li className="rounded-lg border border-border p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="text-sm font-medium text-foreground">
          {pullRequest ? `#${pullRequest.githubPrNumber} — ${pullRequest.title}` : "Unknown PR"}
        </span>
        <div className="flex shrink-0 items-center gap-4">
          {review.verdict && <VerdictBadge verdict={review.verdict} />}
          <StatusBadge status={review.status} />
        </div>
      </div>

      {review.summary && (
        <div className="mt-3 border-t border-border pt-3">
          <Markdown content={review.summary} />
        </div>
      )}

      {review.status === "failed" && review.error && (
        <div className="mt-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2">
          <p className="text-xs font-medium text-danger">
            Failed after {review.error.attempts} attempt{review.error.attempts === 1 ? "" : "s"}
          </p>
          <p className="mt-0.5 font-mono text-xs text-muted">{review.error.message}</p>
        </div>
      )}

      {review.findings.length > 0 && (
        <ul className="mt-4 divide-y divide-border border-t border-border">
          {review.findings.map((finding, i) => (
            <FindingItem key={i} finding={finding} />
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
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Repositories
      </Link>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
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
