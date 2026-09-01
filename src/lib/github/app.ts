import { App } from "@octokit/app";
import { Octokit as OctokitCore } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";

/**
 * `@octokit/app` defaults to a bare `@octokit/core` instance with no
 * plugins, so `octokit.paginate` does not exist unless we add it. Every
 * listing endpoint this app hits is one a large PR can overflow — a PR's
 * changed files most of all, where relying on the default 30-per-page
 * response silently truncates the review to the first page. Wiring the
 * plugin here means every `getInstallationOctokit` caller gets `paginate`.
 */
const PaginatingOctokit = OctokitCore.plugin(paginateRest);

let app: App<{ Octokit: typeof PaginatingOctokit }> | undefined;

function getApp() {
  if (!app) {
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

    if (!appId || !privateKey) {
      throw new Error("Missing GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY");
    }

    app = new App({
      appId,
      // .env stores the PEM with literal "\n" sequences; restore real newlines.
      privateKey: privateKey.replace(/\\n/g, "\n"),
      Octokit: PaginatingOctokit,
    });
  }
  return app;
}

/**
 * The app's URL slug, straight from GitHub. Read through
 * `getGithubAppSlug()` rather than called directly — that wraps this in a
 * cache and an env fallback.
 */
export async function fetchAppSlug(): Promise<string | undefined> {
  const { data } = await getApp().octokit.request("GET /app");
  return data?.slug ?? undefined;
}

export interface InstallationAccount {
  /** GitHub's account id for the user or organization the app is installed on, stringified to match how account ids are stored. */
  id: string;
  login: string;
}

export async function getInstallationAccount(installationId: number): Promise<InstallationAccount> {
  const { data } = await getApp().octokit.request(
    "GET /app/installations/{installation_id}",
    { installation_id: installationId },
  );

  const account = data.account;
  if (!account) {
    throw new Error(`Installation ${installationId} has no associated account`);
  }
  // "login" exists on User/Organization accounts; Enterprise accounts use "slug" instead.
  return { id: String(account.id), login: "login" in account ? account.login : account.slug };
}

//access all the repos
export async function getInstallationRepositories(
  installationId: number,
): Promise<{ githubRepoId: number; fullName: string }[]> {
  const octokit = await getApp().getInstallationOctokit(installationId);

  const { data } = await octokit.request("GET /installation/repositories", {
    per_page: 100,
  });

  return data.repositories.map((repo) => ({
    githubRepoId: Number(repo.id),
    fullName: repo.full_name,
  }));
}

/** An Octokit instance authenticated as a specific installation (server-to-server, not a user token). */
export function getInstallationOctokit(installationId: number) {
  return getApp().getInstallationOctokit(installationId);
}

let botLogin: string | undefined;

/**
 * The login our own comments are authored as — a GitHub App comments as
 * `<app-slug>[bot]`. Needed to tell our own messages apart from a human's
 * when rendering a comment thread, and to ignore webhooks fired by our own
 * replies (otherwise answering a question triggers a webhook that we answer
 * again, forever).
 *
 * Cached for the process: an app's slug does not change at runtime.
 */
export async function getBotLogin(): Promise<string> {
  if (!botLogin) {
    const { data } = await getApp().octokit.request("GET /app");
    if (!data?.slug) throw new Error("GET /app returned no slug — cannot determine bot login");
    botLogin = `${data.slug}[bot]`;
  }
  return botLogin;
}
