"use client";

import { Fragment, forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LayoutDashboard, FolderGit2, Search } from "lucide-react";
import { toneDotClasses } from "@/lib/ui";
import { GitHubMark } from "@/components/github-mark";
import type { RepoSummary } from "@/lib/db/repo-stats";

const HEALTH_TONE: Record<RepoSummary["health"], Parameters<typeof toneDotClasses>[0]> = {
  critical: "danger",
  attention: "warning",
  clean: "success",
  unreviewed: "neutral",
};

function fuzzyMatch(query: string, target: string): boolean {
  if (!query) return true;
  const t = target.toLowerCase();
  const needle = query.trim().toLowerCase();
  let q = 0;
  for (let i = 0; i < t.length && q < needle.length; i++) {
    if (t[i] === needle[q]) q++;
  }
  return q === needle.length;
}

type Section = "Navigation" | "Actions" | "Repositories";
type Item = {
  key: string;
  label: string;
  sublabel?: string;
  href: string;
  icon: "dashboard" | "repos" | "connect" | RepoSummary["health"];
  section: Section;
};

export type CommandPaletteHandle = { open: () => void };

/**
 * ⌘K / Ctrl+K jump-to-anywhere palette — grouped navigation, actions and
 * every connected repo, fuzzy-filtered. A native <dialog> gives us focus
 * trap, Escape-to-close and a backdrop for free, matching the rest of the
 * app's no-extra-library shell.
 */
export const CommandPalette = forwardRef<
  CommandPaletteHandle,
  { repos: RepoSummary[]; installUrl?: string }
>(function CommandPalette({ repos, installUrl }, ref) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  useImperativeHandle(ref, () => ({
    open: () => {
      dialogRef.current?.showModal();
      inputRef.current?.focus();
    },
  }));

  const items = useMemo<Item[]>(() => {
    const navItems: Item[] = [
      { key: "nav-dashboard", label: "Dashboard", href: "/dashboard", icon: "dashboard", section: "Navigation" },
      { key: "nav-repos", label: "All repositories", href: "/dashboard/repos", icon: "repos", section: "Navigation" },
    ];
    const nav = navItems.filter((item) => fuzzyMatch(query, item.label));

    const actionItems: Item[] = installUrl
      ? [
          {
            key: "action-connect",
            label: "Connect another repository",
            href: installUrl,
            icon: "connect",
            section: "Actions",
          },
        ]
      : [];
    const actions = actionItems.filter((item) => fuzzyMatch(query, item.label));

    const repoItems: Item[] = repos
      .filter((repo) => fuzzyMatch(query, repo.fullName))
      .map((repo) => ({
        key: `repo-${repo.id}`,
        label: repo.fullName,
        sublabel: "Repository",
        href: `/dashboard/repos/${repo.id}`,
        icon: repo.health,
        section: "Repositories" as const,
      }));

    return [...nav, ...actions, ...repoItems];
  }, [query, repos, installUrl]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function close() {
    dialogRef.current?.close();
  }

  function navigate(item: Item) {
    close();
    if (item.icon === "connect") {
      window.location.href = item.href;
    } else {
      router.push(item.href);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={() => setQuery("")}
      onCancel={() => setQuery("")}
      className="m-auto max-h-[85vh] w-full max-w-xl overflow-hidden rounded-lg border border-border bg-card p-0 text-foreground shadow-[0_24px_64px_rgba(20,20,16,0.22)] backdrop:bg-black/40 backdrop:backdrop-blur-sm"
      aria-label="Command palette"
    >
      <div
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex((i) => Math.min(i + 1, items.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const item = items[activeIndex];
            if (item) navigate(item);
          }
        }}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-subtle" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages, repositories, actions…"
            aria-label="Search"
            className="h-13 w-full bg-transparent text-sm text-foreground placeholder:text-subtle focus:outline-none"
          />
        </div>

        <ul ref={listRef} role="listbox" aria-label="Results" className="max-h-80 overflow-y-auto p-1.5">
          {items.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-subtle">No matches for &ldquo;{query}&rdquo;.</li>
          ) : (
            items.map((item, i) => {
              const showHeader = i === 0 || items[i - 1].section !== item.section;
              return (
                <Fragment key={item.key}>
                  {showHeader && (
                    <li
                      role="presentation"
                      className="px-3 pt-3 pb-1 text-[10px] font-semibold tracking-wide text-subtle uppercase first:pt-1.5"
                    >
                      {item.section}
                    </li>
                  )}
                  <li role="option" aria-selected={i === activeIndex} data-index={i}>
                    <button
                      type="button"
                      onClick={() => navigate(item)}
                      onMouseEnter={() => setActiveIndex(i)}
                      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                        i === activeIndex ? "bg-surface-hover text-foreground" : "text-muted"
                      }`}
                    >
                      {item.icon === "dashboard" && <LayoutDashboard className="h-4 w-4 shrink-0 text-subtle" aria-hidden="true" />}
                      {item.icon === "repos" && <FolderGit2 className="h-4 w-4 shrink-0 text-subtle" aria-hidden="true" />}
                      {item.icon === "connect" && <GitHubMark className="h-4 w-4 shrink-0 text-subtle" />}
                      {item.icon !== "dashboard" && item.icon !== "repos" && item.icon !== "connect" && (
                        <span className={`shrink-0 ${toneDotClasses(HEALTH_TONE[item.icon])}`} aria-hidden="true" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.sublabel && <span className="shrink-0 text-xs text-subtle">{item.sublabel}</span>}
                    </button>
                  </li>
                </Fragment>
              );
            })
          )}
        </ul>

        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2 text-[11px] text-subtle">
          <span className="tabular-nums">
            {items.length} result{items.length === 1 ? "" : "s"}
          </span>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="border border-border px-1 font-mono">↑↓</kbd> navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="border border-border px-1 font-mono">↵</kbd> open
            </span>
            <span className="flex items-center gap-1">
              <kbd className="border border-border px-1 font-mono">esc</kbd> close
            </span>
          </div>
        </div>
      </div>
    </dialog>
  );
});
