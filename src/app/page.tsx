import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckCircle2, GitPullRequest, ListChecks, ShieldCheck } from "lucide-react";
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
    icon: ListChecks,
    title: "Findings, not vibes",
    body: "Every issue is tagged with a severity (critical → info) and a category (security, bug, performance, quality, testing) — not a wall of undifferentiated comments.",
  },
  {
    icon: GitPullRequest,
    title: "Mapped to the exact line",
    body: "Findings are attached inline to the file and line they apply to, alongside a PR-level summary of what changed and what to test.",
  },
  {
    icon: ShieldCheck,
    title: "Gated, not just advisory",
    body: "A GitHub check run passes or fails based on what the review actually found — configurable per repo, so noisy nits never block a merge by default.",
  },
  {
    icon: GitHubMark,
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
        <nav className="flex items-center gap-6">
          <a
            href="#features"
            className="hidden text-sm text-muted transition-colors hover:text-foreground sm:inline"
          >
            Features
          </a>
          <SignInButton variant="secondary" />
        </nav>
      </header>

      <main className="flex-1">
        <section className="mx-auto max-w-3xl px-6 pt-16 pb-20 text-center sm:px-10 sm:pt-24">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted">
            <GitHubMark className="h-3.5 w-3.5" />
            Runs as a GitHub App
          </span>
          <h1 className="mt-5 text-4xl font-semibold tracking-tight text-balance text-foreground sm:text-5xl">
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
          <div className="mt-4 flex flex-col items-center gap-2">
            <p className="text-xs text-muted">
              An inline comment, posted directly on the changed line.
            </p>
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted">
              <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />
              AI Code Review — passed · 1 finding below threshold
            </span>
          </div>
        </section>

        <section id="features" className="border-t border-border scroll-mt-16">
          <div className="mx-auto grid max-w-4xl gap-x-10 gap-y-10 px-6 py-16 sm:grid-cols-2 sm:px-10 sm:py-20">
            {capabilities.map((item) => (
              <div key={item.title} className="flex gap-4">
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-foreground"
                  aria-hidden="true"
                >
                  <item.icon className="h-4 w-4" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-foreground">
                    {item.title}
                  </h2>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">
                    {item.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-border px-6 py-6 sm:px-10">
        <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 text-center sm:flex-row sm:justify-between sm:text-left">
          <Link href="/" className="flex items-center gap-2">
            <BrandMark className="h-5 w-5" />
            <span className="text-sm font-medium text-foreground">AI Code Review</span>
          </Link>
          <p className="max-w-md text-xs text-muted">
            Built on the GitHub App platform. Your source code is only read
            to generate a review — never stored indefinitely by default.
          </p>
        </div>
      </footer>
    </div>
  );
}
