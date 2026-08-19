"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import {
  Check,
  ChevronDown,
  CircleDot,
  FileCode2,
  GitCommitHorizontal,
  GitPullRequest,
  LoaderCircle,
  MessageSquare,
  RotateCcw,
  ShieldAlert,
} from "lucide-react";

const FILE_ROWS = [
  { name: "rate-limit.ts", status: "Modified", active: true },
  { name: "webhook.ts", status: "Modified" },
  { name: "review.ts", status: "Modified" },
  { name: "rate-limit.test.ts", status: "Added" },
];

const TABS = [
  { label: "Conversation", icon: MessageSquare },
  { label: "Commits", icon: GitCommitHorizontal, count: 3 },
  { label: "Checks", icon: Check, count: 5 },
  { label: "Files changed", icon: FileCode2, count: 4, active: true },
];

type Phase = "idle" | "reading" | "analyzing" | "writing" | "complete";

const PHASE_LABEL: Record<Phase, string> = {
  idle: "Ready to review",
  reading: "Reading changed lines",
  analyzing: "Checking related code paths",
  writing: "Preparing review comments",
  complete: "Review complete",
};

function CodeLine({
  oldLine,
  newLine,
  code,
  added = false,
  delay = 0,
  run,
  motionEnabled,
  visible,
}: {
  oldLine?: number;
  newLine: number;
  code: string;
  added?: boolean;
  delay?: number;
  run: number;
  motionEnabled: boolean;
  visible: boolean;
}) {
  return (
    <motion.div
      key={`${run}-${newLine}`}
      initial={motionEnabled && added ? { opacity: 0, x: -6 } : false}
      animate={
        added && motionEnabled
          ? visible
            ? { opacity: 1, x: 0 }
            : { opacity: 0, x: -6 }
          : { opacity: 1, x: 0 }
      }
      transition={{ duration: 0.22, ease: "easeOut", delay }}
      className={`grid min-w-max grid-cols-[42px_42px_minmax(390px,1fr)] border-l-2 text-xs leading-6 ${
        added ? "border-l-success bg-success/[0.08]" : "border-l-transparent"
      }`}
    >
      <span className="select-none pr-2 text-right text-subtle">{oldLine ?? ""}</span>
      <span className="select-none border-r border-border pr-2 text-right text-subtle">{newLine}</span>
      <code className="whitespace-pre px-3 text-foreground">{code}</code>
    </motion.div>
  );
}

export function ReviewWorkspaceDemo() {
  const rootRef = useRef<HTMLDivElement>(null);
  const inView = useInView(rootRef, { once: true, margin: "-90px" });
  const reducedMotion = useReducedMotion();
  const [run, setRun] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");

  useEffect(() => {
    if (!inView || reducedMotion) return;

    const timers = [
      window.setTimeout(() => setPhase("reading"), 0),
      window.setTimeout(() => setPhase("analyzing"), 1100),
      window.setTimeout(() => setPhase("writing"), 2350),
      window.setTimeout(() => setPhase("complete"), 3650),
    ];

    return () => timers.forEach(window.clearTimeout);
  }, [inView, reducedMotion, run]);

  const motionEnabled = !reducedMotion;
  const sequenceStarted = inView && motionEnabled;
  const visiblePhase: Phase = reducedMotion ? "complete" : phase;
  const reviewVisible = visiblePhase === "writing" || visiblePhase === "complete";
  const summaryVisible = visiblePhase === "complete";

  return (
    <div
      ref={rootRef}
      className="overflow-hidden rounded-lg border border-border bg-background shadow-[0_18px_50px_rgba(27,31,36,0.09)]"
    >
      <div className="flex flex-col gap-4 border-b border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          <GitPullRequest className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-sm font-semibold sm:text-base">Add distributed rate limiting</p>
              <span className="rounded-full bg-success px-2 py-0.5 text-[11px] font-semibold text-white">
                Open
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted">
              kushal wants to merge 3 commits into <span className="font-mono text-foreground">main</span> from{" "}
              <span className="font-mono text-foreground">feat/rate-limit</span>
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3 self-end sm:self-auto">
          <span className="sr-only" aria-live="polite">
            Review status: {PHASE_LABEL[visiblePhase]}
          </span>
          <span
            className={`hidden items-center gap-1.5 text-xs sm:inline-flex ${
              visiblePhase === "complete" ? "font-medium text-success" : "text-muted"
            }`}
            aria-hidden="true"
          >
            {visiblePhase === "complete" ? (
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <motion.span
                animate={visiblePhase !== "idle" && !reducedMotion ? { rotate: 360 } : { rotate: 0 }}
                transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
              >
                <LoaderCircle className="h-3.5 w-3.5" aria-hidden="true" />
              </motion.span>
            )}
            {PHASE_LABEL[visiblePhase]}
          </span>
          <button
            type="button"
            onClick={() => {
              setPhase("reading");
              setRun((value) => value + 1);
            }}
            disabled={!inView || Boolean(reducedMotion)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Replay the code review animation"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Replay
          </button>
        </div>
      </div>

      <div className="overflow-x-auto border-b border-border px-3 sm:px-5">
        <nav className="flex min-w-max gap-1" aria-label="Pull request sections">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <span
                key={tab.label}
                className={`relative inline-flex h-11 items-center gap-1.5 px-2.5 text-xs ${
                  tab.active ? "font-semibold text-foreground" : "text-muted"
                }`}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {tab.label}
                {tab.count !== undefined && (
                  <span className="rounded-full bg-surface-hover px-1.5 py-0.5 text-[10px] tabular-nums text-muted">
                    {tab.count}
                  </span>
                )}
                {tab.active && <span className="absolute inset-x-2.5 bottom-0 h-0.5 bg-success" />}
              </span>
            );
          })}
        </nav>
      </div>

      <div className="relative h-0.5 overflow-hidden bg-surface-hover" aria-hidden="true">
        <motion.span
          key={`progress-${run}`}
          className="absolute inset-y-0 left-0 block w-full origin-left bg-success"
          initial={motionEnabled ? { scaleX: 0 } : false}
          animate={{ scaleX: inView ? 1 : 0 }}
          transition={{ duration: sequenceStarted ? 3.65 : 0, ease: [0.22, 1, 0.36, 1] }}
        />
      </div>

      <div className="grid min-h-[420px] md:grid-cols-[180px_minmax(0,1fr)] lg:grid-cols-[180px_minmax(0,1fr)_270px]">
        <aside className="hidden border-r border-border bg-card p-3 md:block">
          <div className="flex items-center justify-between px-2 py-1.5">
            <p className="text-xs font-semibold">Files changed</p>
            <span className="text-xs tabular-nums text-subtle">4</span>
          </div>
          <ul className="mt-2 space-y-0.5">
            {FILE_ROWS.map((file, index) => (
              <motion.li
                key={`${run}-${file.name}`}
                initial={motionEnabled ? { opacity: 0, x: -4 } : false}
                animate={inView || reducedMotion ? { opacity: 1, x: 0 } : { opacity: 0, x: -4 }}
                transition={{ duration: 0.2, delay: sequenceStarted ? index * 0.06 : 0 }}
                className={`flex items-center gap-2 rounded-md px-2 py-2 text-[11px] ${
                  file.active ? "bg-surface-hover font-medium text-foreground" : "text-muted"
                }`}
              >
                <FileCode2 className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    file.status === "Added" ? "bg-success" : "bg-warning"
                  }`}
                  title={file.status}
                />
              </motion.li>
            ))}
          </ul>
          <div className="mt-6 border-t border-border px-2 pt-4">
            <div className="flex items-center justify-between text-[11px] text-muted">
              <span>48 additions</span>
              <span>12 deletions</span>
            </div>
            <div className="mt-2 flex h-1 overflow-hidden rounded-full bg-border">
              <motion.span
                key={`added-${run}`}
                className="w-4/5 origin-left bg-success"
                initial={motionEnabled ? { scaleX: 0 } : false}
                animate={{ scaleX: inView || reducedMotion ? 1 : 0 }}
                transition={{ duration: 0.45, delay: sequenceStarted ? 0.4 : 0 }}
              />
              <motion.span
                key={`removed-${run}`}
                className="w-1/5 origin-left bg-danger"
                initial={motionEnabled ? { scaleX: 0 } : false}
                animate={{ scaleX: inView || reducedMotion ? 1 : 0 }}
                transition={{ duration: 0.28, delay: sequenceStarted ? 0.68 : 0 }}
              />
            </div>
          </div>
        </aside>

        <div className="min-w-0 bg-background">
          <div className="flex h-11 items-center justify-between border-b border-border bg-card px-4">
            <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
              <span className="truncate font-mono">src/lib/rate-limit.ts</span>
            </div>
            <span className="ml-3 shrink-0 text-[11px] text-muted">
              <span className="text-success">+16</span> <span className="text-danger">−4</span>
            </span>
          </div>

          <div className="relative overflow-x-auto py-3 font-mono">
            {sequenceStarted && (
              <motion.span
                key={`scanner-${run}`}
                className="pointer-events-none absolute right-0 left-[84px] z-10 h-px bg-success/70"
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: [20, 44, 68, 92], opacity: [0, 0.7, 0.7, 0] }}
                transition={{ duration: 1.2, delay: 0.95, times: [0, 0.12, 0.82, 1], ease: "easeInOut" }}
                aria-hidden="true"
              />
            )}

            <CodeLine oldLine={38} newLine={38} code="export async function checkLimit(key: string) {" run={run} motionEnabled={motionEnabled} visible={inView} />
            <CodeLine newLine={39} code="  const bucket = await redis.get(key);" added delay={0.3} run={run} motionEnabled={motionEnabled} visible={inView} />
            <CodeLine newLine={40} code="  if (!bucket) return { allowed: true };" added delay={0.54} run={run} motionEnabled={motionEnabled} visible={inView} />
            <CodeLine newLine={41} code="  const parsed = JSON.parse(bucket);" added delay={0.78} run={run} motionEnabled={motionEnabled} visible={inView} />

            <motion.div
              key={`finding-${run}`}
              initial={motionEnabled ? { opacity: 0, y: -5 } : false}
              animate={{
                opacity: reviewVisible || reducedMotion ? 1 : 0,
                y: reviewVisible || reducedMotion ? 0 : -5,
              }}
              transition={{ duration: 0.28, ease: "easeOut" }}
              className="mx-3 my-3 overflow-hidden rounded-md border border-danger/25 bg-background font-sans sm:ml-[96px]"
            >
              <div className="flex items-center justify-between gap-3 border-b border-danger/20 bg-danger/[0.05] px-3 py-2">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-danger">
                  <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                  High severity · Security
                </span>
                <span className="text-[11px] text-subtle">Line 41</span>
              </div>
              <p className="max-w-xl px-3 py-2.5 text-xs leading-5 text-muted">
                Cache data is parsed without validation. A malformed value can throw and bypass the
                rate-limit path. Validate the payload or fail closed.
              </p>
            </motion.div>

            <CodeLine oldLine={39} newLine={42} code="  return parsed.count &lt; MAX_REQUESTS;" run={run} motionEnabled={motionEnabled} visible={inView} />
            <CodeLine oldLine={40} newLine={43} code="}" run={run} motionEnabled={motionEnabled} visible={inView} />
          </div>
        </div>

        <aside className="hidden border-l border-border bg-card p-4 lg:block">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold">Review summary</p>
            {summaryVisible || reducedMotion ? (
              <CircleDot className="h-4 w-4 text-danger" aria-hidden="true" />
            ) : (
              <LoaderCircle className="h-4 w-4 text-subtle" aria-hidden="true" />
            )}
          </div>

          <motion.div
            key={`summary-${run}`}
            initial={motionEnabled ? { opacity: 0, y: 6 } : false}
            animate={{
              opacity: summaryVisible || reducedMotion ? 1 : 0,
              y: summaryVisible || reducedMotion ? 0 : 6,
            }}
            transition={{ duration: 0.32, ease: "easeOut" }}
          >
            <p className="mt-4 text-sm font-medium leading-5">
              The cache boundary needs hardening before this is ready to merge.
            </p>
            <dl className="mt-5 divide-y divide-border border-y border-border text-xs">
              {[
                ["High", "1", "text-danger"],
                ["Medium", "2", "text-warning"],
                ["Low", "1", "text-muted"],
              ].map(([label, value, tone]) => (
                <div key={label} className="flex items-center justify-between py-2.5">
                  <dt className={tone}>{label}</dt>
                  <dd className="font-medium tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 flex items-start gap-2 text-xs leading-5 text-muted">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
              Merge is blocked by one high-severity finding.
            </div>
            <div className="mt-5 flex items-center gap-2 border-t border-border pt-4 text-xs font-medium text-success">
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              Review posted to GitHub
            </div>
          </motion.div>
        </aside>
      </div>
    </div>
  );
}
