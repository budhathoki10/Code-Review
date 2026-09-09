"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, History } from "lucide-react";

/**
 * Picks which run of one pull request is on screen.
 *
 * A pull request reviewed five times used to render five expandable cards
 * stacked down the page, and only one of them described the branch as it
 * stands — the reader scrolled past four superseded reviews to reach the
 * current one. This shows a single run and moves between them, which is also
 * why the default is the latest rather than "all".
 *
 * Runs count from the first review of the pull request, so a given number
 * keeps meaning the same run as later pushes add to the top.
 */
export interface RunOption {
  /** 1-based, oldest first. */
  number: number;
  sha: string;
}

function optionClasses(active: boolean) {
  return `flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
    active ? "text-foreground" : "text-muted"
  }`;
}

export function RunFilter({
  repositoryId,
  pullRequestId,
  runs,
  selected,
}: {
  repositoryId: string;
  pullRequestId: string;
  /** Newest first, matching the order they are listed in. */
  runs: RunOption[];
  /** The run on screen, or "all" when every run is listed. */
  selected: number | "all";
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

  const base = `/dashboard/repos/${repositoryId}?pr=${encodeURIComponent(pullRequestId)}`;
  const latest = runs[0]?.number;
  const label = selected === "all" ? "All runs" : `Run ${selected}`;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-10 items-center gap-2 rounded-[3px] border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:border-foreground/40 hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <History className="h-4 w-4" aria-hidden="true" />
        {label}
        <ChevronDown
          className={`h-3.5 w-3.5 text-subtle transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Choose a review run"
          className="absolute top-full right-0 z-20 mt-2 w-[min(18rem,calc(100vw-2rem))] rounded-md border border-border bg-card p-1.5 shadow-[0_18px_48px_rgba(20,20,16,0.14)]"
        >
          <div className="max-h-72 overflow-y-auto">
            {runs.map((run) => {
              const active = selected === run.number;
              return (
                <Link
                  key={run.number}
                  href={`${base}&run=${run.number}`}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setOpen(false)}
                  className={optionClasses(active)}
                >
                  <Check
                    className={`mt-0.5 h-4 w-4 shrink-0 ${active ? "opacity-100" : "opacity-0"}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium tabular-nums">
                      Run {run.number}
                      {run.number === latest && (
                        <span className="ml-1.5 text-[11px] font-medium text-subtle">latest</span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-xs text-subtle">
                      {run.sha.slice(0, 7)}
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>

          <div className="mx-2 my-1.5 border-t border-border" />
          <Link
            href={`${base}&run=all`}
            aria-current={selected === "all" ? "page" : undefined}
            onClick={() => setOpen(false)}
            className={optionClasses(selected === "all")}
          >
            <Check
              className={`mt-0.5 h-4 w-4 shrink-0 ${selected === "all" ? "opacity-100" : "opacity-0"}`}
              aria-hidden="true"
            />
            <span>
              <span className="block text-sm font-medium">All runs</span>
              <span className="mt-0.5 block text-xs text-subtle">
                Every review of this pull request, newest first.
              </span>
            </span>
          </Link>
        </div>
      )}
    </div>
  );
}
