import { App } from "@octokit/app";

let app: App | undefined;

function getApp(): App {
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
    });
  }
  return app;
}

export async function getInstallationAccountLogin(installationId: number): Promise<string> {
  const { data } = await getApp().octokit.request(
    "GET /app/installations/{installation_id}",
    { installation_id: installationId },
  );

  const account = data.account;
  if (!account) {
    throw new Error(`Installation ${installationId} has no associated account`);
  }
  // "login" exists on User/Organization accounts; Enterprise accounts use "slug" instead.
  return "login" in account ? account.login : account.slug;
}

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
