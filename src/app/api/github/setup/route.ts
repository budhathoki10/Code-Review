// this file to connect to the repo 
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getGithubAccountIds } from "@/lib/github/account";
import { getInstallationAccount, getInstallationRepositories } from "@/lib/github/app";
import { ensureIndexes, installations, repositories } from "@/lib/db/collections";

// Build absolute redirect URLs from the app's known public origin (AUTH_URL)
// rather than from the incoming request. Behind a tunnel (ngrok), Next.js can
// misreport the request's own origin as the local bind address while still
// carrying an https scheme — producing an https://localhost URL that no
// browser can actually connect to.
function appUrl(path: string, request: NextRequest): URL {
  const base = process.env.AUTH_URL ?? request.url;
  return new URL(path, base);
}

export async function GET(request: NextRequest) {
  //check if the user is login 
  const session = await auth();
  if (!session?.user?.id) {
    // redirect to the base url
    return NextResponse.redirect(appUrl("/", request));
  }

  const installationIdParam = request.nextUrl.searchParams.get("installation_id");
  if (!installationIdParam) {
    return NextResponse.redirect(appUrl("/dashboard", request));
  }
  const githubInstallationId = Number(installationIdParam);

  const githubUserIds = await getGithubAccountIds(session.user.id);
  if (githubUserIds.length === 0) {
    return NextResponse.redirect(appUrl("/dashboard", request));
  }

  await ensureIndexes();

  const [account, repos] = await Promise.all([
    getInstallationAccount(githubInstallationId),
    getInstallationRepositories(githubInstallationId),
  ]);
  const accountLogin = account.login;

  // A user can have several GitHub logins linked. For a personal
  // installation the owning login is knowable — it is the account the app was
  // installed on — so record that one; an org installation says nothing about
  // which of the user's logins performed it, so fall back to the first.
  // Either way ownership checks match on every linked id, so the repos show
  // up regardless.
  const githubUserId =
    githubUserIds.find((id) => id === account.id) ?? githubUserIds[0];

  const installationsCol = await installations();
  const result = await installationsCol.findOneAndUpdate(
    { githubInstallationId },
    {
      $set: { githubUserId, accountLogin },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, returnDocument: "after" },
  );

  const installationDoc = result;
  if (!installationDoc?._id) {
    throw new Error(`Failed to upsert installation ${githubInstallationId}`);
  }

  if (repos.length > 0) {
    //saving all the repo
    const repositoriesCol = await repositories();
    await Promise.all(
      repos.map((repo) =>
        repositoriesCol.updateOne(
          { githubRepoId: repo.githubRepoId },
          {
            $set: {
              installationId: String(installationDoc._id),
              githubInstallationId,
              fullName: repo.fullName,
            },
          },
          { upsert: true },
        ),
      ),
    );
  }

  return NextResponse.redirect(appUrl("/dashboard", request));
}
