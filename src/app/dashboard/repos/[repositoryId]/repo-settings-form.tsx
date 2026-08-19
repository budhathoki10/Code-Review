"use client";

import { useState } from "react";
import { Settings2, X } from "lucide-react";
import { buttonClasses, iconButtonClasses } from "@/lib/ui";
import { SubmitButton } from "@/components/submit-button";
import { useToast } from "@/components/toast";
import { updateRepositoryConfig } from "@/app/dashboard/actions";
import type { RepositoryDoc } from "@/lib/db/collections";

const SEVERITIES: NonNullable<RepositoryDoc["config"]>["severityThreshold"][] = [
  "info",
  "low",
  "medium",
  "high",
  "critical",
];

/**
 * Inline-disclosure settings panel, same pattern as `DisconnectRepoButton` —
 * a toggle button reveals the form in place, no modal. Wires up
 * `RepositoryDoc.config` (severity threshold + custom instructions), which
 * existed in the schema but had no UI to actually set it before Phase 6.
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

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={buttonClasses("secondary")}>
        <Settings2 className="h-4 w-4" aria-hidden="true" />
        Review settings
      </button>
    );
  }

  async function handleSubmit(formData: FormData) {
    const severityThreshold = formData.get("severityThreshold") as NonNullable<
      RepositoryDoc["config"]
    >["severityThreshold"];
    const customInstructions = String(formData.get("customInstructions") ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    await updateRepositoryConfig(repositoryId, { severityThreshold, customInstructions });
    toast({ title: "Review settings saved" });
    setOpen(false);
  }

  return (
    <div className="w-full rounded-lg border border-border bg-card p-5 sm:w-96">
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
            Findings below this level still show on the dashboard, just not on GitHub. Also
            gates the check run (defaults to high/critical if left unset).
          </p>
        </div>

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
    </div>
  );
}
