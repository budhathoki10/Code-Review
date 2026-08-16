import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { buttonClasses } from "@/lib/ui";

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className={className}>
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

function SignInButton({
  variant = "primary",
}: {
  variant?: "primary" | "secondary";
}) {
  return (
    <form
      action={async () => {
        "use server";
        await signIn("github", { redirectTo: "/dashboard" });
      }}
    >
      <button type="submit" className={buttonClasses(variant)}>
        <GitHubMark className="h-4 w-4" />
        Sign in with GitHub
      </button>
    </form>
  );
}

const capabilities = [
  {
    title: "Findings, not vibes",
    body: "Every issue is tagged with a severity (critical → info) and a category (security, bug, performance, quality, testing) — not a wall of undifferentiated comments.",
  },
  {
    title: "Mapped to the exact line",
    body: "Findings are attached inline to the file and line they apply to, alongside a PR-level summary of what changed and what to test.",
  },
  {
    title: "GitHub-native, nothing extra",
    body: "Installs as a GitHub App. Sign in with the same GitHub account — no separate login, no extra dashboard to babysit.",
  },
];

export default async function Home() {
  const session = await auth();
  if (session?.user) {
    redirect("/dashboard");
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between px-6 py-5 sm:px-10">
        <span className="text-sm font-semibold tracking-tight text-foreground">
          AI Code Review
        </span>
        <SignInButton variant="secondary" />
      </header>

      <main className="flex-1">
        <section className="mx-auto max-w-3xl px-6 pt-16 pb-20 text-center sm:px-10 sm:pt-24">
          <h1 className="text-4xl font-semibold tracking-tight text-balance text-foreground sm:text-5xl">
            Code review that lands the moment you open a PR
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-muted">
            Every pull request gets structured, severity-ranked feedback —
            posted directly to GitHub, mapped to the exact lines that changed.
          </p>
          <div className="mt-8 flex justify-center">
            <SignInButton />
          </div>
        </section>

        <section className="mx-auto max-w-2xl px-6 pb-20 sm:px-10">
          <div className="overflow-x-auto rounded-lg border border-border bg-card p-5 text-left font-mono text-xs leading-relaxed sm:text-sm">
            <p className="text-muted">
              <span className="text-foreground">-</span> const users = await
              User.find();
            </p>
            <p className="text-emerald-600 dark:text-emerald-400">
              + const users = await User.find().limit(20).skip(page * 20);
            </p>
            <div className="mt-4 border-t border-border pt-4 font-sans">
              <p className="font-medium text-foreground">
                <span aria-hidden="true">🤖</span> AI Reviewer — Performance ·
                Medium
              </p>
              <p className="mt-1 text-muted">
                This query retrieves every user in the collection. Consider
                pagination to avoid loading large datasets into memory on
                every request.
              </p>
            </div>
          </div>
          <p className="mt-3 text-center text-xs text-muted">
            An inline comment, posted directly on the changed line.
          </p>
        </section>

        <section className="border-t border-border">
          <div className="mx-auto grid max-w-4xl gap-10 px-6 py-16 sm:grid-cols-3 sm:px-10">
            {capabilities.map((item) => (
              <div key={item.title}>
                <h2 className="text-sm font-semibold text-foreground">
                  {item.title}
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-border px-6 py-6 text-center text-xs text-muted sm:px-10">
        Built on the GitHub App platform. Your source code is only read to
        generate a review — never stored indefinitely by default.
      </footer>
    </div>
  );
}
