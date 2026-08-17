"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { ChevronLeft, ChevronRight, FolderGit2, Menu, Search, X } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { buttonClasses, iconButtonClasses, toneDotClasses } from "@/lib/ui";
import type { RepoSummary } from "@/lib/db/repo-stats";

const HEALTH_TONE: Record<RepoSummary["health"], Parameters<typeof toneDotClasses>[0]> = {
  critical: "danger",
  attention: "warning",
  clean: "success",
  unreviewed: "neutral",
};

const SIDEBAR_PAGE_SIZE = 15;

function RepoList({ repos, activeId, onNavigate }: { repos: RepoSummary[]; activeId?: string; onNavigate?: () => void }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const filtered = query.trim()
    ? repos.filter((repo) => repo.fullName.toLowerCase().includes(query.trim().toLowerCase()))
    : repos;

  const totalPages = Math.max(1, Math.ceil(filtered.length / SIDEBAR_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageItems = filtered.slice((currentPage - 1) * SIDEBAR_PAGE_SIZE, currentPage * SIDEBAR_PAGE_SIZE);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative px-3 pt-3">
        <Search className="pointer-events-none absolute top-1/2 left-6 h-3.5 w-3.5 -translate-y-1/2 text-subtle" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
          placeholder="Find a repository…"
          aria-label="Find a repository"
          className="h-9 w-full rounded-md border border-border bg-background pr-2 pl-8 text-xs text-foreground placeholder:text-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
      </div>

      <div className="mt-4 flex items-center justify-between px-4">
        <span className="text-[11px] font-semibold tracking-wide text-subtle uppercase">Repositories</span>
        <span className="text-[11px] tabular-nums text-subtle">{filtered.length}</span>
      </div>

      <nav aria-label="Repositories" className="mt-1.5 min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {pageItems.length === 0 ? (
          <p className="px-2 py-3 text-xs text-subtle">No repositories match.</p>
        ) : (
          <ul className="space-y-0.5">
            {pageItems.map((repo) => {
              const active = repo.id === activeId;
              return (
                <li key={repo.id}>
                  <Link
                    href={`/dashboard/repos/${repo.id}`}
                    onClick={onNavigate}
                    title={repo.fullName}
                    className={`flex items-center gap-2 rounded-md border-l-2 py-1.5 pr-2 pl-2.5 text-xs transition-colors ${
                      active
                        ? "border-accent bg-accent/8 font-medium text-foreground"
                        : "border-transparent text-muted hover:bg-surface-hover hover:text-foreground"
                    }`}
                  >
                    <FolderGit2
                      className={`h-3.5 w-3.5 shrink-0 ${active ? "text-accent" : "text-subtle"}`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{repo.fullName}</span>
                    <span className={toneDotClasses(HEALTH_TONE[repo.health])} aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            className={`${iconButtonClasses()} h-6 w-6 disabled:opacity-30`}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <span className="text-[11px] tabular-nums text-subtle">
            {currentPage} / {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages}
            className={`${iconButtonClasses()} h-6 w-6 disabled:opacity-30`}
            aria-label="Next page"
          >
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

function SidebarContent({
  repos,
  activeId,
  installUrl,
  onNavigate,
}: {
  repos: RepoSummary[];
  activeId?: string;
  installUrl?: string;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full w-64 flex-col">
      <Link href="/dashboard" className="flex items-center gap-2 px-4 py-4" onClick={onNavigate}>
        <BrandMark className="h-5 w-5" />
        <span className="text-sm font-semibold tracking-tight text-foreground">AI Code Review</span>
      </Link>

      <RepoList repos={repos} activeId={activeId} onNavigate={onNavigate} />

      {installUrl && (
        <div className="border-t border-border p-3">
          <a href={installUrl} className={`${buttonClasses("secondary")} w-full`}>
            Connect another repo
          </a>
        </div>
      )}
    </div>
  );
}

/** Docked toggle handle riding the sidebar's edge — same screen position whether expanded or collapsed, so it's never lost. */
function CollapseToggle({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      animate={{ left: collapsed ? 12 : 256 - 12 }}
      transition={{ duration: 0.22, ease: "easeInOut" }}
      className="absolute top-16 z-20 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card text-subtle shadow-sm transition-colors hover:border-accent/50 hover:text-foreground active:bg-surface-hover"
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
    >
      <ChevronLeft
        className={`h-3.5 w-3.5 transition-transform duration-200 ${collapsed ? "rotate-180" : ""}`}
        aria-hidden="true"
      />
    </motion.button>
  );
}

export function DashboardShell({
  repos,
  installUrl,
  userName,
  userImage,
  signOutForm,
  children,
}: {
  repos: RepoSummary[];
  installUrl?: string;
  userName?: string | null;
  userImage?: string | null;
  signOutForm: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopCollapsed, setDesktopCollapsed] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const activeId = pathname.startsWith("/dashboard/repos/") ? pathname.split("/")[3] : undefined;

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMobileOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  return (
    <div className="flex flex-1">
      <div className="relative hidden lg:flex">
        <motion.aside
          animate={{ width: desktopCollapsed ? 0 : 256 }}
          transition={{ duration: 0.22, ease: "easeInOut" }}
          className={`shrink-0 overflow-hidden ${desktopCollapsed ? "" : "border-r border-border"}`}
        >
          <SidebarContent repos={repos} activeId={activeId} installUrl={installUrl} />
        </motion.aside>

        <CollapseToggle collapsed={desktopCollapsed} onClick={() => setDesktopCollapsed((v) => !v)} />
      </div>

      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="fixed inset-0 z-40 bg-foreground/20 lg:hidden"
              onClick={() => setMobileOpen(false)}
              aria-hidden="true"
            />
            <motion.aside
              key="drawer"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="fixed inset-y-0 left-0 z-50 w-72 border-r border-border bg-background lg:hidden"
            >
              <div className="flex items-center justify-end px-2 pt-2">
                <button
                  type="button"
                  onClick={() => setMobileOpen(false)}
                  className={iconButtonClasses()}
                  aria-label="Close navigation"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              <SidebarContent
                repos={repos}
                activeId={activeId}
                installUrl={installUrl}
                onNavigate={() => setMobileOpen(false)}
              />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-border bg-background px-4 py-3 sm:px-6">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className={`${iconButtonClasses()} lg:hidden`}
            aria-label="Open navigation"
          >
            <Menu className="h-4 w-4" aria-hidden="true" />
          </button>

          <div className="flex-1" />

          <div className="relative">
            <button
              type="button"
              onClick={() => setUserMenuOpen((v) => !v)}
              className="flex items-center gap-2 rounded-md p-1 transition-colors hover:bg-surface-hover"
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
            >
              {userImage ? (
                <Image src={userImage} alt="" width={26} height={26} className="rounded-full" />
              ) : (
                <div className="h-[26px] w-[26px] rounded-full bg-surface-hover" />
              )}
              <span className="hidden max-w-[140px] truncate text-sm text-muted sm:inline">{userName}</span>
            </button>

            <AnimatePresence>
              {userMenuOpen && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setUserMenuOpen(false)} />
                  <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.15, ease: "easeOut" }}
                    className="absolute top-full right-0 z-30 mt-2 w-56 rounded-lg border border-border bg-card p-1.5 shadow-sm"
                    role="menu"
                  >
                    <a
                      href="https://github.com/settings/installations"
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded-md px-2.5 py-2 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
                      role="menuitem"
                    >
                      Manage GitHub App
                    </a>
                    <div className="my-1 border-t border-border" />
                    {signOutForm}
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>
        </header>

        <main className="flex flex-1 flex-col px-4 py-8 sm:px-6 lg:px-10">{children}</main>
      </div>
    </div>
  );
}
