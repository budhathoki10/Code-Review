import Link from "next/link";
import { AlertTriangle, ChevronLeft, ChevronRight, FolderGit2, Search } from "lucide-react";
import { auth } from "@/auth";
import { getGithubAccountId } from "@/lib/github/account";
import {
  installations,
  repositories,
  type RepositoryDoc,
} from "@/lib/db/collections";
import { loadRepoStats, loadUserOverviewStats, type RepoStats, type UserOverviewStats } from "@/lib/db/repo-stats";
import { formatRelativeTime } from "@/lib/format";
import { buttonClasses, toneDotClasses, toneTextClasses, type Tone } from "@/lib/ui";
import { GitHubMark } from "@/components/github-mark";
import { StatePanel } from "@/components/state-panel";
import { DisconnectRepoButton } from "./disconnect-repo-button";

const PAGE_SIZE = 10;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loadConnectedRepos(
  userId: string,
  requestedPage: number,
  query: string,
): Promise<{ repos: RepositoryDoc[]; total: number; page: number }> {
  const githubUserId = await getGithubAccountId(userId);
  if (!githubUserId) return { repos: [], total: 0, page: 1 };

  const installationsCol = await installations();
  const userInstallations = await installationsCol
    .find({ githubUserId })
    .toArray();
  if (userInstallations.length === 0) return { repos: [], total: 0, page: 1 };

  const repositoriesCol = await repositories();
  const filter: Record<string, unknown> = {
    installationId: { $in: userInstallations.map((i) => String(i._id)) },
  };
  if (query.trim()) {
    filter.fullName = { $regex: escapeRegExp(query.trim()), $options: "i" };
  }

  const total = await repositoriesCol.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);

  const repos = await repositoriesCol
    .find(filter)
    .sort({ fullName: 1 })
    .skip((page - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .toArray();

  return { repos, total, page };
}

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
      title="Couldn't load your repositories"
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

function SearchForm({ query }: { query: string }) {
  return (
    <form method="get" className="relative w-full sm:w-64">
      <Search
        className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-subtle"
        aria-hidden="true"
      />
      <input
        type="search"
        name="q"
        defaultValue={query}
        placeholder="Search repositories…"
        aria-label="Search repositories"
        className="h-10 w-full rounded-md border border-border bg-background pr-3 pl-9 text-sm text-foreground placeholder:text-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      />
    </form>
  );
}

const VERDICT_CHIP: Record<NonNullable<RepoStats["latestVerdict"]>, { tone: Tone; label: string }> = {
  approve: { tone: "success", label: "Approved" },
  request_changes: { tone: "danger", label: "Changes requested" },
  comment: { tone: "warning", label: "Commented" },
};

function HealthChip({ stats }: { stats?: RepoStats }) {
  if (!stats || stats.totalReviews === 0) {
    return <span className="text-xs text-subtle">Not reviewed yet</span>;
  }
  if (stats.latestStatus === "pending") {
    return (
      <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${toneTextClasses("info")}`}>
        <span className={toneDotClasses("info")} />
        Reviewing
      </span>
    );
  }
  if (stats.latestStatus === "failed") {
    return (
      <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${toneTextClasses("danger")}`}>
        <span className={toneDotClasses("danger")} />
        Review failed
      </span>
    );
  }
  if (!stats.latestVerdict) return null;

  const chip = VERDICT_CHIP[stats.latestVerdict];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${toneTextClasses(chip.tone)}`}>
      <span className={toneDotClasses(chip.tone)} />
      {chip.label}
    </span>
  );
}

function RepoRow({ repo, stats }: { repo: RepositoryDoc; stats?: RepoStats }) {
  const criticalHigh = (stats?.severityCounts.critical ?? 0) + (stats?.severityCounts.high ?? 0);

  return (
    <li className="group relative flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-surface-hover">
      <Link
        href={`/dashboard/repos/${repo._id}`}
        className="absolute inset-0 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        aria-label={`View reviews for ${repo.fullName}`}
      />
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-subtle">
        <FolderGit2 className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <p title={repo.fullName} className="truncate text-sm font-medium text-foreground">
          {repo.fullName}
        </p>
        <p className="mt-0.5 truncate text-xs text-subtle">
          {stats && stats.totalReviews > 0 && stats.lastReviewAt
            ? `Reviewed ${formatRelativeTime(stats.lastReviewAt)} · ${stats.totalReviews} review${
                stats.totalReviews === 1 ? "" : "s"
              }`
            : "No reviews yet"}
        </p>
      </div>
      <div className="relative z-10 flex shrink-0 items-center gap-3">
        {criticalHigh > 0 && (
          <span
            className={`hidden items-center gap-1 text-xs font-medium sm:inline-flex ${toneTextClasses("danger")}`}
            title={`${criticalHigh} critical/high finding${criticalHigh === 1 ? "" : "s"}`}
          >
            <span className={toneDotClasses("danger")} />
            {criticalHigh}
          </span>
        )}
        <span className="hidden sm:inline-flex">
          <HealthChip stats={stats} />
        </span>
        <DisconnectRepoButton githubRepoId={repo.githubRepoId} repoName={repo.fullName} />
        <ChevronRight className="h-4 w-4 text-subtle" aria-hidden="true" />
      </div>
    </li>
  );
}

function Pagination({
  page,
  totalPages,
  query,
}: {
  page: number;
  totalPages: number;
  query: string;
}) {
  if (totalPages <= 1) return null;

  const qs = query ? `&q=${encodeURIComponent(query)}` : "";

  return (
    <nav
      aria-label="Repository pages"
      className="mt-4 flex items-center justify-between"
    >
      {page > 1 ? (
        <a href={`/dashboard?page=${page - 1}${qs}`} className={buttonClasses("secondary")}>
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Previous
        </a>
      ) : (
        <span
          aria-disabled="true"
          className={`${buttonClasses("secondary")} pointer-events-none opacity-50`}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Previous
        </span>
      )}

      <span className="text-xs tabular-nums text-muted">
        Page {page} of {totalPages}
      </span>

      {page < totalPages ? (
        <a href={`/dashboard?page=${page + 1}${qs}`} className={buttonClasses("secondary")}>
          Next
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </a>
      ) : (
        <span
          aria-disabled="true"
          className={`${buttonClasses("secondary")} pointer-events-none opacity-50`}
        >
          Next
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </span>
      )}
    </nav>
  );
}

export default async function DashboardPage(
  props: PageProps<"/dashboard">,
) {
  const searchParams = await props.searchParams;
  const requestedPage = Number(searchParams.page);
  const page =
    Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const query = typeof searchParams.q === "string" ? searchParams.q : "";

  const session = await auth();
  const installUrl = process.env.GITHUB_APP_SLUG
    ? `https://github.com/apps/${process.env.GITHUB_APP_SLUG}/installations/new`
    : undefined;

  let repos: RepositoryDoc[];
  let total: number;
  let currentPage: number;
  let overview: UserOverviewStats | undefined;
  try {
    if (session?.user?.id) {
      ({ repos, total, page: currentPage } = await loadConnectedRepos(session.user.id, page, query));
      overview = await loadUserOverviewStats(session.user.id);
    } else {
      repos = [];
      total = 0;
      currentPage = 1;
    }
  } catch {
    return <ErrorState />;
  }

  if (total === 0 && !query) {
    return <EmptyState installUrl={installUrl} />;
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const repoStats = await loadRepoStats(repos.map((repo) => String(repo._id)));

  return (
    <div className="mx-auto w-full max-w-3xl">
      {overview && (
        <div className="grid grid-cols-3 gap-3">
          <StatTile label="Repositories" value={overview.totalRepos} />
          <StatTile label="Reviews (7d)" value={overview.reviewsLast7Days} />
          <StatTile
            label="Needs attention"
            value={overview.needsAttention}
            tone={overview.needsAttention > 0 ? "danger" : "neutral"}
          />
        </div>
      )}

      <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          Connected repositories{" "}
          <span className="font-normal tabular-nums text-subtle">· {total}</span>
        </h2>
        <div className="flex items-center gap-3">
          <SearchForm query={query} />
          {installUrl && (
            <a href={installUrl} className={buttonClasses("secondary")}>
              Connect another repo
            </a>
          )}
        </div>
      </div>

      {repos.length === 0 ? (
        <div className="mt-6">
          <StatePanel
            icon={<Search className="h-5 w-5" aria-hidden="true" />}
            title="No repositories match your search"
            description={`Nothing found for "${query}". Try a different name.`}
          />
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-border rounded-lg border border-border">
          {repos.map((repo) => (
            <RepoRow key={repo.githubRepoId} repo={repo} stats={repoStats.get(String(repo._id))} />
          ))}
        </ul>
      )}

      <Pagination page={currentPage} totalPages={totalPages} query={query} />
    </div>
  );
}
