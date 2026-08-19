"use client";

import { useRef } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { GitPullRequest } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { GitHubMark } from "@/components/github-mark";

const FILES = [
  { label: "auth/session.ts", y: 38, opacity: 0.45 },
  { label: "api/webhook.ts", y: 82, opacity: 0.65 },
  { label: "review/pipeline.ts", y: 126, opacity: 1 },
  { label: "db/collections.ts", y: 170, opacity: 0.65 },
  { label: "worker/queue.ts", y: 214, opacity: 0.45 },
];

const FILE_X = 192;
const PATH_START_X = 207;
const MERGE_X = 444;
const MERGE_Y = 126;

function filePath(y: number) {
  return `M ${PATH_START_X} ${y} C 310 ${y}, 340 ${MERGE_Y}, ${MERGE_X} ${MERGE_Y}`;
}

function MobileFlow({
  motionEnabled,
  started,
  pulse,
}: {
  motionEnabled: boolean;
  started: boolean;
  pulse: boolean;
}) {
  return (
    <div className="grid grid-cols-[1fr_30px_1fr_30px_1fr] items-center gap-1 py-7 sm:hidden">
      <div className="min-w-0">
        <span className="text-[9px] font-medium text-subtle">Changed files</span>
        <div className="mt-3 space-y-1.5">
          {FILES.slice(0, 3).map((file, index) => (
            <motion.div
              key={file.label}
              initial={motionEnabled ? { opacity: 0, x: -4 } : false}
              animate={started ? { opacity: 1, x: 0 } : { opacity: 0, x: -4 }}
              transition={{ duration: 0.2, delay: index * 0.08 }}
              className="truncate border-l border-border pl-2 font-mono text-[8px] text-muted"
            >
              {file.label}
            </motion.div>
          ))}
          <span className="block pl-2 font-mono text-[8px] text-subtle">+2 more</span>
        </div>
      </div>

      <div className="relative h-px overflow-hidden bg-border" aria-hidden="true">
        {pulse && (
          <motion.span
            className="absolute inset-y-0 left-0 w-3 bg-accent"
            animate={{ x: [-12, 30] }}
            transition={{ duration: 1.1, repeat: Infinity, ease: "linear" }}
          />
        )}
      </div>

      <div className="rounded-md border border-border bg-background px-2 py-3 text-center">
        <BrandMark className="mx-auto h-6 w-6" />
        <p className="mt-2 text-[9px] font-semibold leading-3">Review engine</p>
        <p className="mt-1 text-[8px] text-subtle">Analyze</p>
      </div>

      <div className="relative h-px overflow-hidden bg-border" aria-hidden="true">
        {pulse && (
          <motion.span
            className="absolute inset-y-0 left-0 w-3 bg-success"
            animate={{ x: [-12, 30] }}
            transition={{ duration: 1.1, repeat: Infinity, ease: "linear", delay: 0.55 }}
          />
        )}
      </div>

      <div className="rounded-md border border-border bg-background px-2 py-3 text-center">
        <GitHubMark className="mx-auto h-5 w-5" />
        <p className="mt-2 text-[9px] font-semibold leading-3">GitHub review</p>
        <p className="mt-1 text-[8px] font-medium text-success">Posted</p>
      </div>
    </div>
  );
}

export function ReviewFlowDemo() {
  const rootRef = useRef<HTMLDivElement>(null);
  const inView = useInView(rootRef, { once: true, margin: "-60px" });
  const reducedMotion = useReducedMotion();
  const motionEnabled = !reducedMotion;
  const started = inView || Boolean(reducedMotion);
  const pulse = inView && !reducedMotion;

  return (
    <div ref={rootRef} className="px-6 sm:px-8">
      <div className="flex items-center justify-between border-b border-border py-3.5">
        <div className="flex items-center gap-2">
          <GitPullRequest className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
          <span className="text-[10px] font-medium text-muted">
            Pull request #284
          </span>
        </div>
        <span className="text-[10px] text-subtle">
          5 files changed
        </span>
      </div>

      <MobileFlow motionEnabled={motionEnabled} started={started} pulse={pulse} />

      <div className="hidden sm:block">
        <svg
          viewBox="0 0 760 252"
          role="img"
          aria-labelledby="review-flow-title review-flow-description"
          className="h-auto w-full"
        >
          <title id="review-flow-title">Pull request review flow</title>
          <desc id="review-flow-description">
            Five changed files flow into the review engine, which posts one structured review to GitHub.
          </desc>

          <text x="26" y="20" className="fill-subtle text-[12px] font-medium">
            Changed files
          </text>

          {FILES.map((file, index) => {
            const path = filePath(file.y);
            const delay = index * 0.09;
            return (
              <g key={file.label}>
                <motion.text
                  x={FILE_X - 16}
                  y={file.y + 3}
                  textAnchor="end"
                  className="fill-muted font-mono text-[11px]"
                  initial={motionEnabled ? { opacity: 0, x: -5 } : false}
                  animate={started ? { opacity: 1, x: 0 } : { opacity: 0, x: -5 }}
                  transition={{ duration: 0.24, delay }}
                >
                  {file.label}
                </motion.text>
                <motion.rect
                  x={FILE_X}
                  y={file.y - 6}
                  width="12"
                  height="12"
                  rx="2"
                  className="fill-background stroke-border"
                  strokeWidth="1.2"
                  initial={motionEnabled ? { opacity: 0, scale: 0.7 } : false}
                  animate={started ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.7 }}
                  transition={{ duration: 0.2, delay }}
                  style={{ transformOrigin: `${FILE_X + 6}px ${file.y}px` }}
                />
                <motion.path
                  d={path}
                  fill="none"
                  className="stroke-border"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  initial={motionEnabled ? { pathLength: 0 } : false}
                  animate={{ pathLength: started ? 1 : 0 }}
                  transition={{ duration: 0.75, ease: "easeOut", delay: 0.12 + delay }}
                  style={{ opacity: file.opacity }}
                />
                {pulse && (
                  <motion.path
                    d={path}
                    fill="none"
                    className="stroke-accent"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeDasharray="12 330"
                    initial={{ strokeDashoffset: 0, opacity: 0 }}
                    animate={{ strokeDashoffset: -350, opacity: [0, file.opacity, file.opacity, 0] }}
                    transition={{
                      duration: 1.75,
                      repeat: Infinity,
                      ease: "linear",
                      delay: 0.85 + delay,
                      repeatDelay: 0.35,
                    }}
                  />
                )}
              </g>
            );
          })}

          <motion.g
            initial={motionEnabled ? { opacity: 0, scale: 0.78 } : false}
            animate={started ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.78 }}
            transition={{ duration: 0.3, ease: "easeOut", delay: 0.72 }}
            style={{ transformOrigin: "478px 126px" }}
          >
            <circle cx="478" cy="126" r="28" className="fill-background stroke-foreground" strokeWidth="1.3" />
            <path d="M471 114H466V138H471" className="fill-none stroke-foreground" strokeWidth="1.7" />
            <path d="M478 118H490M478 126H490M478 134H486" className="fill-none stroke-accent" strokeWidth="2" />
          </motion.g>
          <text x="478" y="168" textAnchor="middle" className="fill-foreground text-[10px] font-semibold">
            Review engine
          </text>
          <text x="478" y="184" textAnchor="middle" className="fill-subtle text-[8px]">
            Analyze · Rank · Comment
          </text>

          <motion.path
            d="M 507 126 H 568"
            className="stroke-border"
            strokeWidth="1.4"
            initial={motionEnabled ? { pathLength: 0 } : false}
            animate={{ pathLength: started ? 1 : 0 }}
            transition={{ duration: 0.35, delay: 0.95 }}
          />
          {pulse && (
            <motion.path
              d="M 507 126 H 568"
              className="stroke-success"
              strokeWidth="2"
              strokeDasharray="10 70"
              animate={{ strokeDashoffset: [0, -80] }}
              transition={{ duration: 1.1, repeat: Infinity, ease: "linear", delay: 1.3 }}
            />
          )}

          <motion.g
            initial={motionEnabled ? { opacity: 0, x: 8 } : false}
            animate={started ? { opacity: 1, x: 0 } : { opacity: 0, x: 8 }}
            transition={{ duration: 0.32, ease: "easeOut", delay: 1.15 }}
          >
            <rect x="568" y="94" width="166" height="64" rx="3" className="fill-background stroke-border" />
            <circle cx="590" cy="116" r="10" className="fill-success/10 stroke-success" />
            <path d="M586 116L589 119L594 113" className="fill-none stroke-success" strokeWidth="1.5" />
            <text x="609" y="119" className="fill-foreground text-[10px] font-semibold">GitHub review</text>
            <text x="586" y="143" className="fill-muted text-[8px]">
              Posted · 4 findings
            </text>
          </motion.g>

          <motion.text
            x="734"
            y="176"
            textAnchor="end"
            className="fill-success text-[8px] font-medium"
            initial={motionEnabled ? { opacity: 0, y: -3 } : false}
            animate={started ? { opacity: 1, y: 0 } : { opacity: 0, y: -3 }}
            transition={{ duration: 0.25, delay: 1.4 }}
          >
            Merge gate updated
          </motion.text>
        </svg>
      </div>

      <p className="sr-only">
        Changed files are analyzed together, ranked by severity, and posted as one GitHub pull request review.
      </p>
    </div>
  );
}
