"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Settings2, X } from "lucide-react";
import { buttonClasses, iconButtonClasses } from "@/lib/ui";
import { SubmitButton } from "@/components/submit-button";
import { useToast } from "@/components/toast";
import { updateRepositoryConfig } from "@/app/dashboard/actions";
import type { FindingDoc, RepositoryDoc } from "@/lib/db/collections";

type Category = FindingDoc["category"];
type Severity = FindingDoc["severity"];

/**
 * Severity switches, ordered worst-first so the levels someone is most
 * likely to keep sit at the top and the noisy end is where the eye lands.
 * Glossed for the same reason as CATEGORIES: "info" and "low" don't say
 * anything on their own about what you'd actually be silencing.
 */
const SEVERITIES: { value: Severity; label: string; hint: string }[] = [
  { value: "critical", label: "Critical", hint: "Exploitable or data-losing — fix before merge" },
  { value: "high", label: "High", hint: "Real bugs and security holes" },
  { value: "medium", label: "Medium", hint: "Likely defects and risky patterns" },
  { value: "low", label: "Low", hint: "Minor issues and small cleanups" },
  { value: "info", label: "Info", hint: "Observations, not problems" },
];

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
    const disabledSeverities = String(formData.get("disabledSeverities") ?? "")
      .split(",")
      .filter((value): value is Severity => SEVERITIES.some((sev) => sev.value === value));

    await updateRepositoryConfig(repositoryId, {
      // Carried through untouched: the posting threshold no longer has a
      // control here (severity is a set of switches now, not a floor), but
      // it still gates the check run, so dropping it from the payload would
      // silently reset a value the repo had deliberately set.
      severityThreshold: config?.severityThreshold,
      customInstructions,
      disabledCategories,
      disabledSeverities,
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
                <SeverityToggles saved={config?.disabledSeverities} />

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
 * One list of on/off switches backed by a hidden "disabled" field.
 *
 * Shared by the category and severity lists because they are the same
 * control with different labels — the toggle markup, the last-one-locked
 * rule and the hidden-field encoding were identical, and two copies of a
 * switch this fiddly drift apart the first time one gets a fix.
 *
 * State is owned here rather than by the popover so it only exists while the
 * popover is open: closing it unmounts this and abandoned edits are
 * discarded for free, with no effect resetting state on the way back in
 * (which is what react-hooks/set-state-in-effect exists to prevent).
 *
 * The value reaches the form through a hidden field rather than through the
 * checkboxes themselves: the last enabled item's checkbox is `disabled` so
 * it can't be switched off, and a disabled input contributes nothing to
 * FormData — reading the boxes directly would silently drop exactly the item
 * the lock exists to protect.
 */
function ToggleList<T extends string>({
  name,
  legend,
  items,
  saved,
  lastOnHint,
  footnote,
}: {
  name: string;
  legend: string;
  items: { value: T; label: string; hint: string }[];
  saved?: T[];
  lastOnHint: string;
  footnote: React.ReactNode;
}) {
  const all = items.map((item) => item.value);
  const [enabled, setEnabled] = useState<T[]>(() => all.filter((value) => !saved?.includes(value)));

  const disabled = all.filter((value) => !enabled.includes(value));

  function toggle(value: T) {
    setEnabled((current) =>
      current.includes(value)
        ? current.filter((entry) => entry !== value)
        : // Rebuilt in list order rather than appended, so the value
          // submitted doesn't depend on the order the user clicked.
          all.filter((entry) => current.includes(entry) || entry === value),
    );
  }

  return (
    <fieldset>
      <legend className="text-xs font-medium text-muted">{legend}</legend>
      <input type="hidden" name={name} value={disabled.join(",")} />

      <ul className="mt-1.5 divide-y divide-border rounded-[2px] border border-border">
        {items.map(({ value, label, hint }) => {
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
                  <span className="block text-xs text-subtle">{locked ? lastOnHint : hint}</span>
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

      <p className="mt-1 text-xs text-subtle">{footnote}</p>
    </fieldset>
  );
}

function SeverityToggles({ saved }: { saved?: Severity[] }) {
  return (
    <ToggleList
      name="disabledSeverities"
      legend="Severities to review"
      items={SEVERITIES}
      saved={saved}
      lastOnHint="The last severity on — at least one must stay."
      footnote={
        <>
          Off means dropped entirely — a switched-off severity is not posted to GitHub, not shown
          on the dashboard, and cannot fail the check run. The reviewer is told to skip these
          levels rather than re-label them, so nothing is smuggled through at a level that is
          still on.
        </>
      }
    />
  );
}

function CategoryToggles({ saved }: { saved?: Category[] }) {
  return (
    <ToggleList
      name="disabledCategories"
      legend="Categories to review"
      items={CATEGORIES}
      saved={saved}
      lastOnHint="The last category on — at least one must stay."
      footnote={
        <>
          Off means dropped entirely — not posted to GitHub, not shown on the dashboard, and
          unable to fail the check run. A repo&rsquo;s <code>.prsentry.yaml</code> can switch
          categories off too; the two combine.
        </>
      }
    />
  );
}
