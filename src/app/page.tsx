import Link from "next/link";
import { redirect } from "next/navigation";
import { Bot, CheckCircle2, Download, GitPullRequest, ListChecks, Sparkles, ShieldCheck } from "lucide-react";
import { auth, signIn } from "@/auth";
import type { ButtonVariant } from "@/lib/ui";
import { BrandMark } from "@/components/brand-mark";
import { GitHubMark } from "@/components/github-mark";
import { SubmitButton } from "@/components/submit-button";
import { CapabilityGrid } from "@/components/capability-grid";
import { Reveal } from "@/components/motion/reveal";
import { StaggerGroup, StaggerItem } from "@/components/motion/stagger-group";
import { HoverLift } from "@/components/motion/hover-lift";
import { AnimatedDiffDemo } from "@/components/motion/animated-diff-demo";
import { HeroFlow } from "@/components/motion/hero-flow";

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
    icon: <ListChecks className="h-4 w-4" />,
    title: "Findings, not vibes",
    body: "Every issue is tagged with a severity (critical → info) and a category (security, bug, performance, quality, testing) — not a wall of undifferentiated comments.",
  },
  {
    icon: <GitPullRequest className="h-4 w-4" />,
    title: "Mapped to the exact line",
    body: "Findings are attached inline to the file and line they apply to, alongside a PR-level summary of what changed and what to test.",
  },
  {
    icon: <ShieldCheck className="h-4 w-4" />,
    title: "Gated, not just advisory",
    body: "A GitHub check run passes or fails based on what the review actually found — configurable per repo, so noisy nits never block a merge by default.",
  },
  {
    icon: <GitHubMark className="h-4 w-4" />,
    title: "GitHub-native, nothing extra",
    body: "Installs as a GitHub App. Sign in with the same GitHub account — no separate login, no extra dashboard to babysit.",
  },
];

const steps = [
  {
    icon: Download,
    title: "Install the GitHub App",
    body: "Grant access to the repos you want reviewed. Nothing to configure to get started.",
  },
  {
    icon: GitPullRequest,
    title: "Open a pull request",
    body: "The webhook fires the moment a PR opens or gets a new commit — no manual trigger.",
  },
  {
    icon: Sparkles,
    title: "Get a reviewed result",
    body: "Severity-ranked findings post as inline comments, with a check run that gates the merge.",
  },
];

export default async function Home() {
  const session = await auth();
  if (session?.user) {
    redirect("/dashboard");
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/80 px-6 py-5 backdrop-blur-sm sm:px-10">
        <Link href="/" className="flex items-center gap-2">
          <BrandMark className="h-6 w-6" />
          <span className="text-sm font-semibold tracking-tight text-foreground">
            AI Code Review
          </span>
        </Link>
        <nav className="flex items-center gap-6">
          <a
            href="#how-it-works"
            className="hidden text-sm text-muted transition-colors hover:text-foreground sm:inline"
          >
            How it works
          </a>
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
        <StaggerGroup className="mx-auto max-w-3xl px-6 pt-16 pb-20 text-center sm:px-10 sm:pt-24">
          <StaggerItem
            as="span"
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted"
          >
            <GitHubMark className="h-3.5 w-3.5" />
            Runs as a GitHub App
          </StaggerItem>
          <StaggerItem
            as="h1"
            className="mt-5 text-4xl font-semibold tracking-tight text-balance text-foreground sm:text-5xl"
          >
            Code review that lands the moment you open a PR
          </StaggerItem>
          <StaggerItem as="p" className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-muted">
            Every pull request gets structured, severity-ranked feedback —
            posted directly to GitHub, mapped to the exact lines that changed.
          </StaggerItem>
          <StaggerItem as="div" className="mt-8 flex justify-center">
            <HoverLift>
              <SignInButton />
            </HoverLift>
          </StaggerItem>
          <StaggerItem as="div" className="mt-14">
            <HeroFlow />
          </StaggerItem>
        </StaggerGroup>

        <Reveal className="mx-auto max-w-2xl px-6 pb-20 sm:px-10">
          <div className="overflow-x-auto rounded-lg border border-border bg-card font-mono text-xs leading-relaxed sm:text-sm">
            <AnimatedDiffDemo diff={"- const users = await User.find();\n+ const users = await User.find().limit(20).skip(page * 20);"} />
            {/* Delays are hand-tuned to land after the process strip + diff-line stagger inside AnimatedDiffDemo finish, so the finding reads as a result of that process rather than appearing simultaneously. */}
            <Reveal delay={1.6} className="border-t border-border p-4 font-sans text-sm">
              <p className="flex items-center gap-1.5 font-medium text-foreground">
                <Bot className="h-4 w-4 text-muted" aria-hidden="true" />
                AI Reviewer — Performance · Medium
              </p>
              <p className="mt-1 leading-relaxed text-muted">
                This query retrieves every user in the collection. Consider
                pagination to avoid loading large datasets into memory on
                every request.
              </p>
            </Reveal>
          </div>
          <Reveal delay={1.9} className="mt-4 flex flex-col items-center gap-2">
            <p className="text-xs text-muted">
              An inline comment, posted directly on the changed line.
            </p>
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted">
              <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />
              AI Code Review — passed · 1 finding below threshold
            </span>
          </Reveal>
        </Reveal>

        <section id="how-it-works" className="border-t border-border scroll-mt-16">
          <div className="mx-auto max-w-4xl px-6 py-16 sm:px-10 sm:py-20">
            <Reveal>
              <h2 className="text-center text-xs font-semibold tracking-wide text-subtle uppercase">
                How it works
              </h2>
            </Reveal>
            <StaggerGroup className="mt-8 grid gap-8 sm:grid-cols-3">
              {steps.map((step, i) => (
                <StaggerItem key={step.title} as="div" className="text-center sm:text-left">
                  <div className="flex items-center justify-center gap-3 sm:justify-start">
                    <span className="font-mono text-xs tabular-nums text-subtle" aria-hidden="true">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <div
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-foreground"
                      aria-hidden="true"
                    >
                      <step.icon className="h-4 w-4" />
                    </div>
                  </div>
                  <h3 className="mt-3 text-sm font-semibold text-foreground">{step.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{step.body}</p>
                </StaggerItem>
              ))}
            </StaggerGroup>
          </div>
        </section>

        <section id="features" className="border-t border-border scroll-mt-16">
          <div className="mx-auto max-w-4xl px-6 py-16 sm:px-10 sm:py-20">
            <CapabilityGrid items={capabilities} />
          </div>
        </section>

        <Reveal className="border-t border-border bg-foreground">
          <div className="mx-auto flex max-w-3xl flex-col items-center gap-5 px-6 py-16 text-center sm:px-10 sm:py-20">
            <h2 className="text-2xl font-semibold tracking-tight text-balance text-background sm:text-3xl">
              Wire it into your first repo in under a minute
            </h2>
            <p className="max-w-md text-sm leading-relaxed text-background/70">
              No config required to start. Sign in, pick a repo, open a PR.
            </p>
            <HoverLift>
              <SignInButton />
            </HoverLift>
          </div>
        </Reveal>
      </main>

      <Reveal>
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
      </Reveal>
    </div>
  );
}
