import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getGithubAccountId } from "@/lib/github/account";
import { getInstallationAccountLogin, getInstallationRepositories } from "@/lib/github/app";
import { ensureIndexes, installations, repositories } from "@/lib/db/collections";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    const signInUrl = new URL("/", request.url);
    return NextResponse.redirect(signInUrl);
  }

  const installationIdParam = request.nextUrl.searchParams.get("installation_id");
  if (!installationIdParam) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }
  const githubInstallationId = Number(installationIdParam);

  const githubUserId = await getGithubAccountId(session.user.id);
  if (!githubUserId) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
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

  return NextResponse.redirect(new URL("/dashboard", request.url));
}
