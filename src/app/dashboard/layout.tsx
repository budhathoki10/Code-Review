import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { SubmitButton } from "@/components/submit-button";
import { DashboardShell } from "@/components/dashboard/shell";
import { loadRepoSummaries } from "@/lib/db/repo-stats";
import { getLinkedGithubAccounts } from "@/lib/github/account";
import { getInstallUrl } from "@/lib/github/install-url";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/");
  }

  const [repos, accounts, installUrl] = await Promise.all([
    loadRepoSummaries(session.user.id),
    getLinkedGithubAccounts(session.user.id),
    getInstallUrl(),
  ]);

  const signOutForm = (
    <form
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/" });
      }}
    >
      <SubmitButton variant="ghost" pendingLabel="Signing out…">
        Sign out
      </SubmitButton>
    </form>
  );

  return (
    <DashboardShell
      repos={repos}
      installUrl={installUrl}
      accounts={accounts}
      userName={session.user.name ?? session.user.email}
      userImage={session.user.image}
      signOutForm={signOutForm}
    >
      {children}
    </DashboardShell>
  );
}
