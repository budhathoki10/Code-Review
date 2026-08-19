"use client";

import { useState, useTransition } from "react";
import { Loader2, Trash2, X } from "lucide-react";
import { buttonClasses, iconButtonClasses } from "@/lib/ui";
import { useToast } from "@/components/toast";
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
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  if (confirming) {
    return (
      <div className="flex shrink-0 items-center gap-2">
        <span className="hidden text-xs text-muted md:inline">Disconnect {repoName}?</span>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={isPending}
          className={iconButtonClasses()}
          aria-label="Cancel disconnect"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          disabled={isPending}
          aria-busy={isPending}
          onClick={() =>
            startTransition(async () => {
              await disconnectRepository(githubRepoId);
              toast({ title: `Disconnected ${repoName}`, variant: "info" });
            })
          }
          className={buttonClasses("destructive")}
        >
          {isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          Disconnect
        </button>
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
