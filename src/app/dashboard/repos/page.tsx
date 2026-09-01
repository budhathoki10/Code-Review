import type { CSSProperties } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronLeft, ChevronRight, FolderGit2, Search } from "lucide-react";
import { auth } from "@/auth";
import { getGithubAccountIds, getLinkedGithubAccounts } from "@/lib/github/account";
import { getInstallUrl } from "@/lib/github/install-url";
import {
  installations,
  repositories,
  type RepositoryDoc,
} from "@/lib/db/collections";
import { loadRepoStats, type RepoStats } from "@/lib/db/repo-stats";
import { formatRelativeTime } from "@/lib/format";
import {
  buttonClasses,
  toneBgClasses,
  toneDotClasses,
  toneTextClasses,
  SEVERITY_ORDER,
  SEVERITY_TONE,
  type Tone,
} from "@/lib/ui";
import { GitHubMark } from "@/components/github-mark";
import { ConnectRepoMenu, SwitchAccountButton } from "@/components/dashboard/connect-repo-menu";
import { StatePanel } from "@/components/state-panel";
import { DisconnectRepoButton } from "../disconnect-repo-button";

const PAGE_SIZE = 10;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loadConnectedRepos(
  userId: string,
  requestedPage: number,
  query: string,
): Promise<{ repos: RepositoryDoc[]; total: number; page: number; stats: Map<string, RepoStats> }> {
  const githubUserIds = await getGithubAccountIds(userId);
  if (githubUserIds.length === 0) return { repos: [], total: 0, page: 1, stats: new Map() };

  const installationsCol = await installations();
  const userInstallations = await installationsCol
    .find({ githubUserId: { $in: githubUserIds } })
    .toArray();
  if (userInstallations.length === 0) return { repos: [], total: 0, page: 1, stats: new Map() };

  const repositoriesCol = await repositories();
  const filter: Record<string, unknown> = {
    installationId: { $in: userInstallations.map((i) => String(i._id)) },
  };
  if (query.trim()) {
    filter.fullName = { $regex: escapeRegExp(query.trim()), $options: "i" };
  }

  // Sorted by latest activity (most recent review, which fires on every PR
  // open/commit push), not name — so a repo you just pushed to jumps to the
  // top. That means pulling every matching repo's stats up front rather than
  // paginating in the DB, mirroring loadRepoSummaries' approach for the
  // sidebar switcher.
  const allRepos = await repositoriesCol.find(filter).toArray();
  const stats = await loadRepoStats(allRepos.map((repo) => String(repo._id)));

  allRepos.sort((a, b) => {
    const aTime = stats.get(String(a._id))?.lastReviewAt;
    const bTime = stats.get(String(b._id))?.lastReviewAt;
    if (aTime && bTime) return bTime.getTime() - aTime.getTime();
    if (aTime) return -1;
    if (bTime) return 1;
    return a.fullName.localeCompare(b.fullName);
  });

  const total = allRepos.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const repos = allRepos.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return { repos, total, page, stats };
}

function EmptyState({ installUrl }: { installUrl?: string }) {
  return (
    <StatePanel
      icon={<FolderGit2 className="h-5 w-5" aria-hidden="true" />}
      title="No repositories connected"
      description="Install the GitHub App on a repository to start getting automated PR reviews. If your repositories live under a different GitHub login, switch to that account instead."
      action={
        installUrl ? (
          <div className="flex flex-wrap items-center gap-2">
            <a href={installUrl} className={buttonClasses("primary")}>
              <GitHubMark className="h-4 w-4" />
              Connect GitHub
            </a>
            <SwitchAccountButton />
          </div>
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
        <Link href="/dashboard/repos" className={buttonClasses("secondary")}>
          Retry
        </Link>
      }
    />
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
        className="h-10 w-full rounded-[2px] border border-border bg-card pr-3 pl-9 text-sm text-foreground placeholder:text-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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

/** Proportional severity breakdown as thin segments — a glance at a repo's posture, not another number to read. */
function SeverityBar({ counts }: { counts: RepoStats["severityCounts"] }) {
  const total = SEVERITY_ORDER.reduce((sum, severity) => sum + (counts[severity] ?? 0), 0);
  if (total === 0) return null;

  return (
    <div
      className="hidden h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-border sm:flex"
      title={SEVERITY_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(" · ")}
    >
      {SEVERITY_ORDER.map((severity) => {
        const count = counts[severity] ?? 0;
        if (count === 0) return null;
        return (
          <span
            key={severity}
            style={{ width: `${(count / total) * 100}%` }}
            className={`h-full ${toneBgClasses(SEVERITY_TONE[severity])}`}
          />
        );
      })}
    </div>
  );
}

function RepoRow({ repo, stats, index }: { repo: RepositoryDoc; stats?: RepoStats; index: number }) {
  return (
    <li
      className="group stagger-in relative flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-surface-hover"
      style={{ "--index": index } as CSSProperties}
    >
      <Link
        href={`/dashboard/repos/${repo._id}`}
        className="absolute inset-0 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        aria-label={`View reviews for ${repo.fullName}`}
      />
      <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-border bg-card text-subtle">
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
        {stats && <SeverityBar counts={stats.severityCounts} />}
        <HealthChip stats={stats} />
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
        <a href={`/dashboard/repos?page=${page - 1}${qs}`} className={buttonClasses("secondary")}>
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
        <a href={`/dashboard/repos?page=${page + 1}${qs}`} className={buttonClasses("secondary")}>
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

export default async function RepositoriesPage(
  props: PageProps<"/dashboard/repos">,
) {
  const searchParams = await props.searchParams;
  const requestedPage = Number(searchParams.page);
  const page =
    Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const query = typeof searchParams.q === "string" ? searchParams.q : "";

  const session = await auth();
  const [installUrl, accounts] = await Promise.all([
    getInstallUrl(),
    session?.user?.id ? getLinkedGithubAccounts(session.user.id) : Promise.resolve([]),
  ]);

  let repos: RepositoryDoc[];
  let total: number;
  let currentPage: number;
  let repoStats: Map<string, RepoStats>;
  try {
    if (session?.user?.id) {
      ({ repos, total, page: currentPage, stats: repoStats } = await loadConnectedRepos(session.user.id, page, query));
    } else {
      repos = [];
      total = 0;
      currentPage = 1;
      repoStats = new Map();
    }
  } catch {
    return <ErrorState />;
  }

  if (total === 0 && !query) {
    return <EmptyState installUrl={installUrl} />;
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-2xl font-semibold tracking-[-0.035em] text-foreground">
          Connected repositories{" "}
          <span className="font-normal tabular-nums text-subtle">· {total}</span>
        </h2>
        <div className="flex items-center gap-3">
          <SearchForm query={query} />
          <ConnectRepoMenu installUrl={installUrl} accounts={accounts} />
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
        <ul className="mt-6 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {repos.map((repo, i) => (
            <RepoRow key={repo.githubRepoId} repo={repo} stats={repoStats.get(String(repo._id))} index={i} />
          ))}
        </ul>
      )}

      <Pagination page={currentPage} totalPages={totalPages} query={query} />
    </div>
  );
}
