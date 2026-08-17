import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import type { ButtonVariant } from "@/lib/ui";
import { BrandMark } from "@/components/brand-mark";
import { DiffLines } from "@/components/diff-block";
import { GitHubMark } from "@/components/github-mark";
import { SubmitButton } from "@/components/submit-button";

function SignInButton({ variant = "primary" }: { variant?: ButtonVariant }) {
  return (
    <form
      action={async () => {
        "use server";
        await signIn("github", { redirectTo: "/dashboard" });
      }}
    >
      <SubmitButton variant={variant} pendingLabel="Redirecting…">
        <GitHubMark className="h-4 w-4" />
        <span className={variant === "secondary" ? "sr-only sm:not-sr-only" : undefined}>
          Sign in with GitHub
        </span>
      </SubmitButton>
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
        <Link href="/" className="flex items-center gap-2">
          <BrandMark className="h-6 w-6" />
          <span className="text-sm font-semibold tracking-tight text-foreground">
            AI Code Review
          </span>
        </Link>
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
          <div className="overflow-x-auto rounded-lg border border-border bg-card font-mono text-xs leading-relaxed sm:text-sm">
            <div className="py-3">
              <DiffLines diff={"- const users = await User.find();\n+ const users = await User.find().limit(20).skip(page * 20);"} />
            </div>
            <div className="border-t border-border p-4 font-sans text-sm">
              <p className="font-medium text-foreground">
                <span aria-hidden="true">🤖</span> AI Reviewer — Performance ·
                Medium
              </p>
              <p className="mt-1 leading-relaxed text-muted">
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
          <div className="mx-auto grid max-w-4xl gap-x-10 gap-y-10 px-6 py-16 sm:grid-cols-3 sm:px-10 sm:py-20">
            {capabilities.map((item, i) => (
              <div key={item.title} className="border-t border-border pt-5">
                <span className="font-mono text-xs text-subtle">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h2 className="mt-3 text-sm font-semibold text-foreground">
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
