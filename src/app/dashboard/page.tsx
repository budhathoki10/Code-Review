import Link from "next/link";
import { AlertTriangle, ChevronLeft, ChevronRight, FolderGit2 } from "lucide-react";
import { auth } from "@/auth";
import { getGithubAccountId } from "@/lib/github/account";
import {
  installations,
  repositories,
  type RepositoryDoc,
} from "@/lib/db/collections";
import { buttonClasses } from "@/lib/ui";
import { GitHubMark } from "@/components/github-mark";
import { StatePanel } from "@/components/state-panel";
import { DisconnectRepoButton } from "./disconnect-repo-button";

const PAGE_SIZE = 10;

async function loadConnectedRepos(
  userId: string,
  requestedPage: number,
): Promise<{ repos: RepositoryDoc[]; total: number; page: number }> {
  const githubUserId = await getGithubAccountId(userId);
  if (!githubUserId) return { repos: [], total: 0, page: 1 };

  const installationsCol = await installations();
  const userInstallations = await installationsCol
    .find({ githubUserId })
    .toArray();
  if (userInstallations.length === 0) return { repos: [], total: 0, page: 1 };

  const repositoriesCol = await repositories();
  const filter = {
    installationId: { $in: userInstallations.map((i) => String(i._id)) },
  };

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

function RepoRow({ repo }: { repo: RepositoryDoc }) {
  return (
    <li className="group relative flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-surface-hover">
      <Link
        href={`/dashboard/repos/${repo._id}`}
        className="absolute inset-0 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        aria-label={`View reviews for ${repo.fullName}`}
      />
      <span
        title={repo.fullName}
        className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
      >
        {repo.fullName}
      </span>
      <div className="relative z-10 flex shrink-0 items-center gap-1">
        <DisconnectRepoButton githubRepoId={repo.githubRepoId} repoName={repo.fullName} />
        <ChevronRight className="h-4 w-4 text-subtle" aria-hidden="true" />
      </div>
    </li>
  );
}

function Pagination({
  page,
  totalPages,
}: {
  page: number;
  totalPages: number;
}) {
  if (totalPages <= 1) return null;

  return (
    <nav
      aria-label="Repository pages"
      className="mt-4 flex items-center justify-between"
    >
      {page > 1 ? (
        <a href={`/dashboard?page=${page - 1}`} className={buttonClasses("secondary")}>
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
        <a href={`/dashboard?page=${page + 1}`} className={buttonClasses("secondary")}>
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

  const session = await auth();
  const installUrl = process.env.GITHUB_APP_SLUG
    ? `https://github.com/apps/${process.env.GITHUB_APP_SLUG}/installations/new`
    : undefined;

  let repos: RepositoryDoc[];
  let total: number;
  let currentPage: number;
  try {
    ({ repos, total, page: currentPage } = session?.user?.id
      ? await loadConnectedRepos(session.user.id, page)
      : { repos: [], total: 0, page: 1 });
  } catch {
    return <ErrorState />;
  }

  if (total === 0) {
    return <EmptyState installUrl={installUrl} />;
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          Connected repositories{" "}
          <span className="font-normal tabular-nums text-subtle">· {total}</span>
        </h2>
        {installUrl && (
          <a href={installUrl} className={buttonClasses("secondary")}>
            Connect another repo
          </a>
        )}
      </div>

      <ul className="mt-6 divide-y divide-border rounded-lg border border-border">
        {repos.map((repo) => (
          <RepoRow key={repo.githubRepoId} repo={repo} />
        ))}
      </ul>

      <Pagination page={currentPage} totalPages={totalPages} />
    </div>
  );
}
