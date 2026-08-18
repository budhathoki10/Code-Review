import Link from "next/link";
import { AlertTriangle, FolderGit2, GitPullRequest } from "lucide-react";
import { auth } from "@/auth";
import { loadLatestReview, loadUserOverviewStats, type UserOverviewStats, type LatestReview } from "@/lib/db/repo-stats";
import { buttonClasses, toneTextClasses, type Tone } from "@/lib/ui";
import { GitHubMark } from "@/components/github-mark";
import { StatePanel } from "@/components/state-panel";
import { ReviewCard } from "@/components/review-card";

function EmptyState({ installUrl }: { installUrl?: string }) {
  return (
    <StatePanel
      icon={<FolderGit2 className="h-5 w-5" aria-hidden="true" />}
      title="No repositories connected"
      description="Install the GitHub App on a repository to start getting automated PR reviews."
      action={
        installUrl ? (
          <a href={installUrl} className={buttonClasses("primary")}>
            <GitHubMark className="h-4 w-4" />
            Connect GitHub
          </a>
        ) : (
          <p className="text-sm text-muted">
            GitHub App isn&apos;t configured yet — set{" "}
            <code className="rounded border border-border bg-card px-1 py-0.5 text-xs">
              GITHUB_APP_SLUG
            </code>{" "}
            to enable the connect flow.
          </p>
        )
      }
    />
  );
}

function ErrorState() {
  return (
    <StatePanel
      icon={<AlertTriangle className="h-5 w-5 text-danger" aria-hidden="true" />}
      title="Couldn't load your dashboard"
      description={
        <>
          The database didn&apos;t respond. This is usually a configuration
          issue with{" "}
          <code className="rounded border border-border bg-card px-1 py-0.5 text-xs">
            MONGODB_URI
          </code>
          .
        </>
      }
      action={
        <a href="/dashboard" className={buttonClasses("secondary")}>
          Retry
        </a>
      }
    />
  );
}

function StatTile({ label, value, tone = "neutral" }: { label: string; value: number; tone?: Tone }) {
  return (
    <div className="rounded-lg border border-border px-4 py-3">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p
        className={`mt-1 text-2xl font-semibold tracking-tight tabular-nums ${
          tone === "neutral" ? "text-foreground" : toneTextClasses(tone)
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function Overview({ stats }: { stats: UserOverviewStats }) {
  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Dashboard</h1>
      <div className="mt-4 grid grid-cols-3 gap-3">
        <StatTile label="Repositories" value={stats.totalRepos} />
        <StatTile label="Reviews (7d)" value={stats.reviewsLast7Days} />
        <StatTile
          label="Needs attention"
          value={stats.needsAttention}
          tone={stats.needsAttention > 0 ? "danger" : "neutral"}
        />
      </div>
    </section>
  );
}

function LatestReviewSpotlight({ latest }: { latest: LatestReview | null }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold tracking-tight text-foreground">Latest review</h2>

      {latest ? (
        <div className="mt-4">
          <Link
            href={`/dashboard/repos/${latest.repository.id}`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-accent"
          >
            <FolderGit2 className="h-3.5 w-3.5 text-subtle" aria-hidden="true" />
            {latest.repository.fullName}
          </Link>
          <ul className="mt-3">
            <ReviewCard review={latest.review} pullRequest={latest.pullRequest} defaultOpen />
          </ul>
        </div>
      ) : (
        <div className="mt-4">
          <StatePanel
            icon={<GitPullRequest className="h-5 w-5" aria-hidden="true" />}
            title="No reviews yet"
            description="One will appear here automatically the next time a pull request is opened or updated on a connected repository."
          />
        </div>
      )}
    </section>
  );
}

export default async function DashboardPage() {
  const session = await auth();
  const installUrl = process.env.GITHUB_APP_SLUG
    ? `https://github.com/apps/${process.env.GITHUB_APP_SLUG}/installations/new`
    : undefined;

  let overview: UserOverviewStats;
  let latest: LatestReview | null;
  try {
    if (session?.user?.id) {
      [overview, latest] = await Promise.all([
        loadUserOverviewStats(session.user.id),
        loadLatestReview(session.user.id),
      ]);
    } else {
      overview = { totalRepos: 0, reviewsLast7Days: 0, needsAttention: 0 };
      latest = null;
    }
  } catch {
    return <ErrorState />;
  }

  if (overview.totalRepos === 0) {
    return <EmptyState installUrl={installUrl} />;
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <Overview stats={overview} />
      <LatestReviewSpotlight latest={latest} />
    </div>
  );
}
