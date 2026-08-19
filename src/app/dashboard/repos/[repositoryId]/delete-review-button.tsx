"use client";

import { useState, useTransition } from "react";
import { Loader2, Trash2, X } from "lucide-react";
import { iconButtonClasses } from "@/lib/ui";
import { useToast } from "@/components/toast";
import { deleteReview } from "./actions";

/**
 * Sits inside a <summary> row, so every handler stops propagation — a plain
 * click would otherwise also toggle the parent <details> disclosure. Same
 * two-step inline confirm as `DisconnectRepoButton`, sized for a row action.
 */
export function DeleteReviewButton({
  reviewId,
  repositoryId,
  prLabel,
}: {
  reviewId: string;
  repositoryId: string;
  prLabel: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  if (confirming) {
    return (
      <div
        className="flex shrink-0 items-center gap-1.5"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={isPending}
          className={`${iconButtonClasses()} h-7 w-7`}
          aria-label="Cancel delete"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          disabled={isPending}
          aria-busy={isPending}
          onClick={() =>
            startTransition(async () => {
              await deleteReview(reviewId, repositoryId);
              toast({ title: `Deleted review for ${prLabel}`, variant: "info" });
            })
          }
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-danger px-2.5 text-xs font-semibold text-white transition-[background-color] hover:brightness-95 disabled:pointer-events-none disabled:opacity-50"
        >
          {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          Delete
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setConfirming(true);
      }}
      className={`${iconButtonClasses()} h-7 w-7 shrink-0 hover:bg-danger/10 hover:text-danger`}
      aria-label={`Delete review for ${prLabel}`}
      title="Delete review"
    >
      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}
