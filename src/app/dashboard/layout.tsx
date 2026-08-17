import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { SubmitButton } from "@/components/submit-button";
import { DashboardShell } from "@/components/dashboard/shell";
import { loadRepoSummaries } from "@/lib/db/repo-stats";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/");
  }

  const repos = await loadRepoSummaries(session.user.id);
  const installUrl = process.env.GITHUB_APP_SLUG
    ? `https://github.com/apps/${process.env.GITHUB_APP_SLUG}/installations/new`
    : undefined;

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
      userName={session.user.name ?? session.user.email}
      userImage={session.user.image}
      signOutForm={signOutForm}
    >
      {children}
    </DashboardShell>
  );
}
