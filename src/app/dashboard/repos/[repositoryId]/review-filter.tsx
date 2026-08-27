"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, ListFilter } from "lucide-react";

export type ReviewFilterValue =
  | { kind: "latest" }
  | { kind: "all" }
  | { kind: "pull-request"; pullRequestId: string };

interface PullRequestOption {
  id: string;
  number: number;
  title: string;
}

function optionClasses(active: boolean) {
  return `flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
    active ? "text-foreground" : "text-muted"
  }`;
}

export function ReviewFilter({
  repositoryId,
  value,
  pullRequests,
}: {
  repositoryId: string;
  value: ReviewFilterValue;
  pullRequests: PullRequestOption[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const activePullRequest =
    value.kind === "pull-request"
      ? pullRequests.find((pullRequest) => pullRequest.id === value.pullRequestId)
      : undefined;
  const label =
    value.kind === "latest"
      ? "Most recent"
      : value.kind === "all"
        ? "All pull requests"
        : activePullRequest
          ? `PR #${activePullRequest.number}`
          : "Filter reviews";

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-10 items-center gap-2 rounded-[3px] border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:border-foreground/40 hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <ListFilter className="h-4 w-4" aria-hidden="true" />
        {label}
        <ChevronDown
          className={`h-3.5 w-3.5 text-subtle transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Filter reviews"
          className="absolute top-full right-0 z-20 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-md border border-border bg-card p-1.5 shadow-[0_18px_48px_rgba(20,20,16,0.14)]"
        >
          <Link
            href={`/dashboard/repos/${repositoryId}`}
            aria-current={value.kind === "latest" ? "page" : undefined}
            onClick={() => setOpen(false)}
            className={optionClasses(value.kind === "latest")}
          >
            <Check
              className={`mt-0.5 h-4 w-4 shrink-0 ${value.kind === "latest" ? "opacity-100" : "opacity-0"}`}
              aria-hidden="true"
            />
            <span>
              <span className="block text-sm font-medium">Most recent review</span>
              <span className="mt-0.5 block text-xs text-subtle">Show only the newest review in this repository.</span>
            </span>
          </Link>

          <Link
            href={`/dashboard/repos/${repositoryId}?view=all`}
            aria-current={value.kind === "all" ? "page" : undefined}
            onClick={() => setOpen(false)}
            className={optionClasses(value.kind === "all")}
          >
            <Check
              className={`mt-0.5 h-4 w-4 shrink-0 ${value.kind === "all" ? "opacity-100" : "opacity-0"}`}
              aria-hidden="true"
            />
            <span>
              <span className="block text-sm font-medium">All pull requests</span>
              <span className="mt-0.5 block text-xs text-subtle">Show the latest review for every pull request.</span>
            </span>
          </Link>

          {pullRequests.length > 0 && (
            <>
              <div className="mx-2 my-1.5 border-t border-border" />
              <p className="px-2.5 py-1 text-[11px] font-semibold tracking-wide text-subtle uppercase">
                Pull request history
              </p>
              <div className="max-h-72 overflow-y-auto">
                {pullRequests.map((pullRequest) => {
                  const active =
                    value.kind === "pull-request" && value.pullRequestId === pullRequest.id;

                  return (
                    <Link
                      key={pullRequest.id}
                      href={`/dashboard/repos/${repositoryId}?pr=${encodeURIComponent(pullRequest.id)}`}
                      aria-current={active ? "page" : undefined}
                      onClick={() => setOpen(false)}
                      title={`#${pullRequest.number} — ${pullRequest.title}`}
                      className={optionClasses(active)}
                    >
                      <Check
                        className={`mt-0.5 h-4 w-4 shrink-0 ${active ? "opacity-100" : "opacity-0"}`}
                        aria-hidden="true"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium tabular-nums">PR #{pullRequest.number}</span>
                        <span className="mt-0.5 block truncate text-xs text-subtle">{pullRequest.title}</span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
