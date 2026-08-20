import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getGithubAccountId } from "@/lib/github/account";
import { installations } from "@/lib/db/collections";
import { appUrl } from "@/lib/app-url";

/**
 * Landing-page sign-in lands here right after GitHub OAuth completes, so a
 * new user goes straight into the GitHub App install flow instead of
 * stopping at an empty dashboard first. Returning users who already have an
 * installation skip straight to the dashboard — no reason to send them back
 * through GitHub's install picker on every login.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(appUrl("/", request));
  }

  if (!process.env.GITHUB_APP_SLUG) {
    return NextResponse.redirect(appUrl("/dashboard", request));
  }

  const githubUserId = await getGithubAccountId(session.user.id);
  if (githubUserId) {
    const installationsCol = await installations();
    const hasInstallation = await installationsCol.findOne({ githubUserId }, { projection: { _id: 1 } });
    if (hasInstallation) {
      return NextResponse.redirect(appUrl("/dashboard", request));
    }
  }

  return NextResponse.redirect(`https://github.com/apps/${process.env.GITHUB_APP_SLUG}/installations/new`);
}
