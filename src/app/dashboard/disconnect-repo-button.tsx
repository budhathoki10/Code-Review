"use client";

import { useState } from "react";
import { Trash2, X } from "lucide-react";
import { iconButtonClasses } from "@/lib/ui";
import { SubmitButton } from "@/components/submit-button";
import { disconnectRepository } from "./actions";

/**
 * Two-step inline confirm instead of a bare destructive action: click once
 * reveals a named confirmation in place of the row's trigger, click again
 * (or Cancel) to resolve it. No modal, no window.confirm.
 */
export function DisconnectRepoButton({
  githubRepoId,
  repoName,
}: {
  githubRepoId: number;
  repoName: string;
}) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div className="flex shrink-0 items-center gap-2">
        <span className="hidden text-xs text-muted md:inline">Disconnect {repoName}?</span>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className={iconButtonClasses()}
          aria-label="Cancel disconnect"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
        <form action={disconnectRepository.bind(null, githubRepoId)}>
          <SubmitButton variant="destructive">Disconnect</SubmitButton>
        </form>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className={`${iconButtonClasses()} opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`}
      aria-label={`Disconnect ${repoName}`}
      title="Disconnect"
    >
      <Trash2 className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
