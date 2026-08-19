import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Check, GitPullRequest } from "lucide-react";
import { auth, signIn } from "@/auth";
import type { ButtonVariant } from "@/lib/ui";
import { BrandMark } from "@/components/brand-mark";
import { GitHubMark } from "@/components/github-mark";
import { SubmitButton } from "@/components/submit-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { ReviewFlowDemo } from "@/components/motion/review-flow-demo";
import { ReviewWorkspaceDemo } from "@/components/motion/review-workspace-demo";

function SignInButton({
  variant = "primary",
  compactOnMobile = false,
}: {
  variant?: ButtonVariant;
  compactOnMobile?: boolean;
}) {
  return (
    <form
      action={async () => {
        "use server";
        await signIn("github", { redirectTo: "/dashboard" });
      }}
    >
      <SubmitButton variant={variant} pendingLabel="Opening GitHub…">
        <GitHubMark className="h-4 w-4" />
        <span className={compactOnMobile ? "sr-only sm:not-sr-only" : undefined}>Sign in with GitHub</span>
      </SubmitButton>
    </form>
  );
}

const workflow = [
  {
    number: "1",
    title: "Connect a repository",
    body: "Install the GitHub App and choose exactly which repositories it can access.",
  },
  {
    number: "2",
    title: "Open a pull request",
    body: "Every new pull request and commit automatically starts a review in the background.",
  },
  {
    number: "3",
    title: "Review and merge",
    body: "Findings appear on the relevant lines and the merge check reflects your severity rules.",
  },
];

const capabilities = [
  {
    title: "Repository context",
    body: "Reviews use the changed lines and surrounding source instead of judging an isolated diff.",
  },
  {
    title: "Prioritized findings",
    body: "Security, correctness, performance, quality, and testing issues are ranked by severity.",
  },
  {
    title: "GitHub-native feedback",
    body: "Comments are attached to the affected lines with a single pull-request summary.",
  },
  {
    title: "Configurable merge gates",
    body: "Each repository controls which severity level should block a merge.",
  },
];

export default async function Home() {
  const session = await auth();
  if (session?.user) {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <Link href="/" className="flex items-center gap-2.5" aria-label="AI Code Review home">
            <BrandMark className="h-7 w-7" />
            <span className="text-sm font-semibold tracking-[-0.01em]">AI Code Review</span>
          </Link>

          <nav className="flex items-center gap-6" aria-label="Primary navigation">
            <a
              href="#product"
              className="hidden text-sm text-muted transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent sm:block"
            >
              Product
            </a>
            <a
              href="#how-it-works"
              className="hidden text-sm text-muted transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent sm:block"
            >
              How it works
            </a>
            <ThemeToggle />
            <SignInButton variant="secondary" compactOnMobile />
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto grid max-w-7xl items-center gap-12 px-5 py-16 sm:px-8 sm:py-20 lg:grid-cols-[0.72fr_1.28fr] lg:gap-12 lg:py-24">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-muted">
              <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />
              Automated reviews for GitHub pull requests
            </div>

            <h1 className="mt-5 max-w-xl text-4xl font-semibold leading-[1.08] tracking-[-0.045em] sm:text-5xl lg:text-[3.5rem]">
              Catch review issues before they reach production.
            </h1>

            <p className="mt-6 max-w-xl text-lg leading-8 text-muted">
              Inspect every pull-request diff, leave feedback on the relevant lines, and update a merge
              check without moving your team out of GitHub.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-4">
              <SignInButton />
              <a
                href="#product"
                className="inline-flex h-11 items-center gap-2 text-sm font-semibold text-foreground transition-colors hover:text-info focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
              >
                See an example review
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </div>

            <div className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-xs text-subtle">
              <span>GitHub App</span>
              <span aria-hidden="true">·</span>
              <span>No workflow file</span>
              <span aria-hidden="true">·</span>
              <span>Repository-level controls</span>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-border bg-card shadow-[0_16px_40px_rgba(24,26,24,0.08)]">
            <div className="border-b border-border bg-background px-6 py-5 sm:px-8">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-base font-semibold">From pull request to posted review</p>
                  <p className="mt-1 text-sm text-muted">Five changed files become one focused review.</p>
                </div>
                <span className="hidden items-center gap-1.5 text-xs text-success sm:inline-flex">
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  Automatic
                </span>
              </div>
            </div>
            <ReviewFlowDemo />
          </div>
        </section>

        <section className="border-y border-border bg-card">
          <div className="mx-auto grid max-w-6xl grid-cols-2 divide-x divide-y divide-border px-5 sm:grid-cols-4 sm:divide-y-0 sm:px-8">
            {[
              ["Line-level", "Inline review comments"],
              ["Severity-aware", "Critical through informational"],
              ["Asynchronous", "Reviews run in the background"],
              ["Configurable", "Rules set per repository"],
            ].map(([title, body]) => (
              <div key={title} className="px-4 py-5 first:pl-0 sm:px-6 sm:first:pl-0">
                <p className="text-sm font-semibold">{title}</p>
                <p className="mt-1 text-xs leading-5 text-muted">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="product" className="scroll-mt-24">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
            <div className="grid items-end gap-4 sm:grid-cols-[1fr_420px]">
              <div>
                <p className="text-sm font-semibold text-success">Review example</p>
                <h2 className="mt-2 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">
                  Useful feedback, attached to the code.
                </h2>
              </div>
              <p className="text-sm leading-6 text-muted">
                The reviewer follows the changed code, creates prioritized findings, and posts one coherent
                result instead of flooding the pull request with unrelated comments.
              </p>
            </div>

            <div className="mt-10">
              <ReviewWorkspaceDemo />
            </div>
          </div>
        </section>

        <section id="how-it-works" className="scroll-mt-24 border-y border-border bg-card">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
            <div className="max-w-2xl">
              <h2 className="text-3xl font-semibold tracking-[-0.035em]">Set it up once. Keep working in GitHub.</h2>
              <p className="mt-3 text-base leading-7 text-muted">
                The application handles installation, review processing, and result delivery in the background.
              </p>
            </div>

            <ol className="mt-10 grid gap-8 border-t border-border pt-8 md:grid-cols-3">
              {workflow.map((step) => (
                <li key={step.number} className="grid grid-cols-[32px_1fr] gap-3">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-background text-xs font-semibold">
                    {step.number}
                  </span>
                  <div>
                    <h3 className="text-base font-semibold">{step.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-muted">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="mx-auto grid max-w-6xl gap-12 px-5 py-16 sm:px-8 sm:py-24 lg:grid-cols-[0.72fr_1.28fr]">
          <div>
            <h2 className="text-3xl font-semibold tracking-[-0.035em]">Built around the review workflow.</h2>
            <p className="mt-4 max-w-md text-base leading-7 text-muted">
              Review results stay attached to the pull request, with enough context to act on each finding
              without opening another tool.
            </p>
          </div>

          <dl className="grid gap-x-10 sm:grid-cols-2">
            {capabilities.map((capability) => (
              <div key={capability.title} className="border-t border-border py-5">
                <dt className="flex items-center gap-2 text-sm font-semibold">
                  <Check className="h-4 w-4 text-success" aria-hidden="true" />
                  {capability.title}
                </dt>
                <dd className="mt-2 text-sm leading-6 text-muted">{capability.body}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="border-t border-border bg-card">
          <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-14 sm:flex-row sm:items-center sm:justify-between sm:px-8">
            <div>
              <h2 className="text-2xl font-semibold tracking-[-0.025em]">Connect your first repository.</h2>
              <p className="mt-2 text-sm text-muted">Install the GitHub App and run the first review on your next pull request.</p>
            </div>
            <SignInButton />
          </div>
        </section>
      </main>

      <footer className="border-t border-border bg-background">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-7 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <Link href="/" className="flex items-center gap-2.5">
            <BrandMark className="h-6 w-6" />
            <span className="text-sm font-semibold">AI Code Review</span>
          </Link>
          <p className="flex items-center gap-2 text-xs text-muted">
            <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" />
            Built for GitHub pull-request workflows
          </p>
        </div>
      </footer>
    </div>
  );
}
