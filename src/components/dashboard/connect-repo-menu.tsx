"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, FolderGit2, Loader2, UserPlus } from "lucide-react";
import { connectGithubAccount } from "@/app/dashboard/account-actions";
import type { LinkedGithubAccount } from "@/lib/github/account";
import { buttonClasses } from "@/lib/ui";

const ITEM_CLASSES =
  "flex w-full items-start gap-2.5 rounded-[2px] px-2.5 py-2 text-left transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-60";

function ItemText({ label, hint }: { label: string; hint: string }) {
  return (
    <span className="min-w-0">
      <span className="block text-sm font-medium text-foreground">{label}</span>
      <span className="mt-0.5 block text-xs leading-5 text-subtle">{hint}</span>
    </span>
  );
}

/** Submit row for the account-linking form — needs its own component so `useFormStatus` sees the form. */
function ConnectAccountItem() {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending} aria-busy={pending} className={ITEM_CLASSES} role="menuitem">
      {pending ? (
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-subtle" aria-hidden="true" />
      ) : (
        <UserPlus className="mt-0.5 h-4 w-4 shrink-0 text-subtle" aria-hidden="true" />
      )}
      <ItemText
        label="Connect a GitHub account"
        hint={pending ? "Opening GitHub…" : "Link another GitHub login to this workspace"}
      />
    </button>
  );
}

/**
 * The connect entry point: install the app on more repositories, or link a
 * second GitHub login so its repositories land in the same workspace.
 */
export function ConnectRepoMenu({
  installUrl,
  accounts = [],
  placement = "bottom",
  fullWidth = false,
}: {
  installUrl?: string;
  accounts?: LinkedGithubAccount[];
  /** "top" opens the menu upward — for the trigger pinned to the bottom of the sidebar. */
  placement?: "top" | "bottom";
  fullWidth?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }

    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const knownLogins = accounts.map((account) => account.login).filter((login): login is string => !!login);

  return (
    <div ref={containerRef} className={`relative ${fullWidth ? "w-full" : ""}`}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`${buttonClasses("secondary")} ${fullWidth ? "w-full" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Connect another repo
        <ChevronDown
          className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: placement === "top" ? 4 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: placement === "top" ? 4 : -4 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            role="menu"
            aria-label="Connect"
            className={`absolute right-0 z-30 rounded-[2px] border border-border bg-card p-1.5 shadow-[0_18px_48px_rgba(20,20,16,0.14)] ${
              // Pinned to the bottom of the sidebar the menu matches the
              // trigger's width; in a page header it would be too narrow, so
              // it gets a fixed width that still fits a small viewport.
              placement === "top"
                ? "bottom-full left-0 mb-2"
                : "top-full mt-2 w-[300px] max-w-[calc(100vw-2rem)]"
            }`}
          >
            {installUrl ? (
              <a href={installUrl} className={ITEM_CLASSES} role="menuitem" onClick={() => setOpen(false)}>
                <FolderGit2 className="mt-0.5 h-4 w-4 shrink-0 text-subtle" aria-hidden="true" />
                <ItemText label="Add repositories" hint="Pick repositories on an account you already connected" />
              </a>
            ) : (
              <p className="px-2.5 py-2 text-xs leading-5 text-subtle">
                Set{" "}
                <code className="rounded border border-border px-1 py-0.5 text-[11px]">GITHUB_APP_SLUG</code> to
                enable the install flow.
              </p>
            )}

            <div className="my-1 border-t border-border" />

            <form action={connectGithubAccount}>
              <ConnectAccountItem />
            </form>

            {knownLogins.length > 0 && (
              <p className="mt-1 border-t border-border px-2.5 pt-2 pb-1 text-[11px] leading-5 text-subtle">
                Connected as {knownLogins.map((login) => `@${login}`).join(", ")}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Standalone account-linking button for first-run states, where there is no menu to hang it off. */
export function ConnectAccountButton() {
  return (
    <form action={connectGithubAccount}>
      <ConnectAccountSubmit />
    </form>
  );
}

function ConnectAccountSubmit() {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending} aria-busy={pending} className={buttonClasses("ghost")}>
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <UserPlus className="h-4 w-4" aria-hidden="true" />
      )}
      {pending ? "Opening GitHub…" : "Use a different GitHub account"}
    </button>
  );
}
