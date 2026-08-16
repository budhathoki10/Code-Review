import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getGithubAccountId } from "@/lib/github/account";
import { getInstallationAccountLogin, getInstallationRepositories } from "@/lib/github/app";
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
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(appUrl("/", request));
  }

  const installationIdParam = request.nextUrl.searchParams.get("installation_id");
  if (!installationIdParam) {
    return NextResponse.redirect(appUrl("/dashboard", request));
  }
  const githubInstallationId = Number(installationIdParam);

  const githubUserId = await getGithubAccountId(session.user.id);
  if (!githubUserId) {
    return NextResponse.redirect(appUrl("/dashboard", request));
  }

  await ensureIndexes();

  const [accountLogin, repos] = await Promise.all([
    getInstallationAccountLogin(githubInstallationId),
    getInstallationRepositories(githubInstallationId),
  ]);

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
    const repositoriesCol = await repositories();
    await Promise.all(
      repos.map((repo) =>
        repositoriesCol.updateOne(
          { githubRepoId: repo.githubRepoId },
          {
            $set: {
              installationId: String(installationDoc._id),
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
