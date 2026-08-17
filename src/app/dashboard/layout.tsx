import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { BrandMark } from "@/components/brand-mark";
import { SubmitButton } from "@/components/submit-button";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/");
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background px-6 py-4 sm:px-10">
        <Link href="/dashboard" className="flex items-center gap-2">
          <BrandMark className="h-6 w-6" />
          <span className="text-sm font-semibold tracking-tight text-foreground">
            AI Code Review
          </span>
        </Link>

        <div className="flex items-center gap-3">
          {session.user.image && (
            <Image
              src={session.user.image}
              alt={session.user.name ?? "Avatar"}
              width={28}
              height={28}
              className="rounded-full"
            />
          )}
          <span className="hidden max-w-[160px] truncate text-sm text-muted sm:inline">
            {session.user.name ?? session.user.email}
          </span>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <SubmitButton variant="secondary" pendingLabel="Signing out…">
              Sign out
            </SubmitButton>
          </form>
        </div>
      </header>

      <main className="flex flex-1 flex-col px-6 py-10 sm:px-10">{children}</main>
    </div>
  );
}
