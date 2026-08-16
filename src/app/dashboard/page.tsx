import { auth } from "@/auth";
import { getGithubAccountId } from "@/lib/github/account";
import {
  installations,
  repositories,
  type RepositoryDoc,
} from "@/lib/db/collections";
import { buttonClasses } from "@/lib/ui";

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
    <div className="flex flex-1 flex-col items-center justify-center text-center">
      <div className="w-full max-w-sm">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          No repositories connected
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Install the GitHub App on a repository to start getting automated
          PR reviews.
        </p>

        {installUrl ? (
          <a href={installUrl} className={`mt-6 ${buttonClasses("primary")}`}>
            Connect GitHub
          </a>
        ) : (
          <p className="mt-6 text-sm text-muted">
            GitHub App isn&apos;t configured yet — set{" "}
            <code className="rounded bg-card px-1 py-0.5 text-xs">
              GITHUB_APP_SLUG
            </code>{" "}
            to enable the connect flow.
          </p>
        )}
      </div>
    </div>
  );
}

function ErrorState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center">
      <div className="w-full max-w-sm">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          Couldn&apos;t load your repositories
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          The database didn&apos;t respond. This is usually a configuration
          issue with <code className="rounded bg-card px-1 py-0.5 text-xs">MONGODB_URI</code>.
        </p>
        <a href="/dashboard" className={`mt-6 ${buttonClasses("secondary")}`}>
          Retry
        </a>
      </div>
    </div>
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
          Previous
        </a>
      ) : (
        <span
          aria-disabled="true"
          className={`${buttonClasses("secondary")} pointer-events-none opacity-50`}
        >
          Previous
        </span>
      )}

      <span className="text-xs tabular-nums text-muted">
        Page {page} of {totalPages}
      </span>

      {page < totalPages ? (
        <a href={`/dashboard?page=${page + 1}`} className={buttonClasses("secondary")}>
          Next
        </a>
      ) : (
        <span
          aria-disabled="true"
          className={`${buttonClasses("secondary")} pointer-events-none opacity-50`}
        >
          Next
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
          Connected repositories
        </h2>
        {installUrl && (
          <a href={installUrl} className={buttonClasses("secondary")}>
            Connect another repo
          </a>
        )}
      </div>

      <ul className="mt-6 divide-y divide-border rounded-lg border border-border">
        {repos.map((repo) => (
          <li
            key={repo.githubRepoId}
            className="flex items-center justify-between gap-4 px-4 py-3"
          >
            <span
              title={repo.fullName}
              className="min-w-0 truncate text-sm font-medium text-foreground"
            >
              {repo.fullName}
            </span>
            <span className="shrink-0 text-xs text-muted">No reviews yet</span>
          </li>
        ))}
      </ul>

      <Pagination page={currentPage} totalPages={totalPages} />
    </div>
  );
}
