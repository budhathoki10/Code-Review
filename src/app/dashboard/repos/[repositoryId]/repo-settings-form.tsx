"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Settings2, X } from "lucide-react";
import { buttonClasses, iconButtonClasses } from "@/lib/ui";
import { SubmitButton } from "@/components/submit-button";
import { useToast } from "@/components/toast";
import { updateRepositoryConfig } from "@/app/dashboard/actions";
import type { FindingDoc, RepositoryDoc } from "@/lib/db/collections";

const SEVERITIES: NonNullable<RepositoryDoc["config"]>["severityThreshold"][] = [
  "info",
  "low",
  "medium",
  "high",
  "critical",
];

type Category = FindingDoc["category"];

/**
 * Listed with a plain-English gloss rather than the bare enum value: "quality"
 * and "testing" both sound like things you obviously want on, and the reason
 * someone reaches for this control is usually one specific kind of noise.
 */
const CATEGORIES: { value: Category; label: string; hint: string }[] = [
  { value: "security", label: "Security", hint: "Injection, auth, secrets, unsafe input" },
  { value: "bug", label: "Bugs", hint: "Logic errors and crashes" },
  { value: "performance", label: "Performance", hint: "Slow paths, N+1s, wasted work" },
  { value: "quality", label: "Quality", hint: "Readability, structure, dead code" },
  { value: "testing", label: "Testing", hint: "Missing or inadequate test coverage" },
];

/**
 * Anchored popover, same pattern as the account menu in `DashboardShell` —
 * a toggle button reveals the form absolutely positioned over the page, so
 * it never pushes the review list down. Wires up `RepositoryDoc.config`
 * (severity threshold + custom instructions), which existed in the schema
 * but had no UI to actually set it before Phase 6.
 */
export function RepoSettingsForm({
  repositoryId,
  config,
}: {
  repositoryId: string;
  config?: RepositoryDoc["config"];
}) {
  const [open, setOpen] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function handleSubmit(formData: FormData) {
    const severityThreshold = formData.get("severityThreshold") as NonNullable<
      RepositoryDoc["config"]
    >["severityThreshold"];
    const customInstructions = String(formData.get("customInstructions") ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    // CategoryToggles submits the disabled list through a hidden field rather
    // than through the checkboxes themselves: the last remaining category's
    // checkbox is `disabled` to stop it being switched off, and a disabled
    // input contributes nothing to FormData — reading the boxes directly would
    // silently drop exactly the category the lock exists to protect.
    const disabledCategories = String(formData.get("disabledCategories") ?? "")
      .split(",")
      .filter((value): value is Category => CATEGORIES.some((c) => c.value === value));

    await updateRepositoryConfig(repositoryId, {
      severityThreshold,
      customInstructions,
      disabledCategories,
    });
    toast({ title: "Review settings saved" });
    setOpen(false);
  }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={buttonClasses("secondary")}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Settings2 className="h-4 w-4" aria-hidden="true" />
        Review settings
      </button>

      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden="true" />
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              role="dialog"
              aria-label="Review settings"
              className="absolute top-full right-0 z-30 mt-2 w-[calc(100vw-2.5rem)] rounded-lg border border-border bg-card p-5 shadow-[0_18px_48px_rgba(20,20,16,0.14)] sm:w-96"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">Review settings</h3>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className={iconButtonClasses()}
                  aria-label="Close review settings"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>

              <form action={handleSubmit} className="mt-3 space-y-4">
                <div>
                  <label htmlFor="severityThreshold" className="text-xs font-medium text-muted">
                    Post to GitHub from severity
                  </label>
                  <select
                    id="severityThreshold"
                    name="severityThreshold"
                    defaultValue={config?.severityThreshold ?? "info"}
                    className="mt-1.5 h-9 w-full rounded-[2px] border border-border bg-background px-2.5 text-sm text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {SEVERITIES.map((severity) => (
                      <option key={severity} value={severity}>
                        {severity === "info" ? "info (everything)" : severity}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-subtle">
                    Findings below this level still show on the dashboard, just not on GitHub.
                    Also gates the check run (defaults to high/critical if left unset).
                  </p>
                </div>

                <CategoryToggles saved={config?.disabledCategories} />

                <div>
                  <label htmlFor="customInstructions" className="text-xs font-medium text-muted">
                    Custom instructions (one per line)
                  </label>
                  <textarea
                    id="customInstructions"
                    name="customInstructions"
                    rows={3}
                    defaultValue={(config?.customInstructions ?? []).join("\n")}
                    placeholder="e.g. Flag any use of `any` in TypeScript"
                    className="mt-1.5 w-full rounded-[2px] border border-border bg-background px-2.5 py-2 text-sm text-foreground placeholder:text-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  />
                </div>

                <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
              </form>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * The category switches, kept in their own component so their state is owned
 * by something that only exists while the popover is open. Closing the
 * popover unmounts this, so edits abandoned that way are discarded for free —
 * no effect resetting state on the way back in, which is what
 * react-hooks/set-state-in-effect exists to prevent.
 *
 * The value reaches the form through a hidden field rather than through the
 * checkboxes: the last enabled category's checkbox is `disabled` so it can't
 * be switched off, and a disabled input submits nothing.
 */
function CategoryToggles({ saved }: { saved?: Category[] }) {
  const [enabled, setEnabled] = useState<Category[]>(() =>
    CATEGORIES.map((c) => c.value).filter((c) => !saved?.includes(c)),
  );

  const disabled = CATEGORIES.map((c) => c.value).filter((c) => !enabled.includes(c));

  function toggle(category: Category) {
    setEnabled((current) =>
      current.includes(category)
        ? current.filter((c) => c !== category)
        : // Rebuilt in CATEGORIES order rather than appended, so the value
          // submitted doesn't depend on the order the user clicked.
          CATEGORIES.map((c) => c.value).filter((c) => current.includes(c) || c === category),
    );
  }

  return (
    <fieldset>
      <legend className="text-xs font-medium text-muted">Categories to review</legend>
      <input type="hidden" name="disabledCategories" value={disabled.join(",")} />

      <ul className="mt-1.5 divide-y divide-border rounded-[2px] border border-border">
        {CATEGORIES.map(({ value, label, hint }) => {
          const on = enabled.includes(value);
          const locked = on && enabled.length === 1;
          return (
            <li key={value}>
              <label
                className={`flex items-center justify-between gap-3 px-2.5 py-2 ${
                  locked ? "cursor-not-allowed" : "cursor-pointer"
                }`}
              >
                <span className="min-w-0">
                  <span className="block text-sm text-foreground">{label}</span>
                  <span className="block text-xs text-subtle">
                    {locked ? "The last category on — at least one must stay." : hint}
                  </span>
                </span>
                <span className="relative inline-flex shrink-0">
                  <input
                    type="checkbox"
                    className="peer sr-only"
                    checked={on}
                    disabled={locked}
                    onChange={() => toggle(value)}
                  />
                  <span
                    aria-hidden="true"
                    className="h-5 w-9 rounded-full bg-border transition-colors peer-checked:bg-accent peer-disabled:opacity-60 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent motion-reduce:transition-none"
                  />
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4 motion-reduce:transition-none"
                  />
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <p className="mt-1 text-xs text-subtle">
        Off means dropped entirely — not posted to GitHub, not shown on the dashboard, and unable
        to fail the check run. A repo&rsquo;s <code>.prsentry.yaml</code> can switch categories off
        too; the two combine.
      </p>
    </fieldset>
  );
}
