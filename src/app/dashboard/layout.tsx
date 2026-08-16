import Image from "next/image";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { buttonClasses } from "@/lib/ui";

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
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <span className="text-sm font-semibold tracking-tight text-foreground">
          AI Code Review
        </span>

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
            <button type="submit" className={buttonClasses("secondary")}>
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="flex flex-1 flex-col px-6 py-10">{children}</main>
    </div>
  );
}
