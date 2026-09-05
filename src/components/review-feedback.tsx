"use client";

import { useState, useTransition } from "react";
import { setReviewFeedback } from "@/app/dashboard/repos/[repositoryId]/actions";

const RATINGS: [label: string, title: string][] = [
  ["correct", "Correct"],
  ["false-positive", "False positive"],
  ["duplicate", "Duplicate"],
];

/**
 * One rating for the review as a whole.
 *
 * Deliberately not per finding: that put this control under every finding in
 * every file, so the common case — "this review was useful" — cost a click
 * per item. A reader forms one opinion about a review, and rating it once is
 * both the honest granularity and the only version anyone actually uses.
 */
export function ReviewFeedback({ reviewId, repositoryId, value }: {
  reviewId: string; repositoryId: string; value?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();

  function rate(label: string) {
    setError(undefined);
    startTransition(async () => {
      try {
        // Clicking the active rating clears it, so a misclick is undoable
        // without a separate control.
        const result = await setReviewFeedback(reviewId, repositoryId, label === value ? "clear" : label);
        if (result.error) setError(result.error);
      } catch {
        setError("Could not save feedback. Try again.");
      }
    });
  }

  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2" aria-label="Rate this review">
        <span className="text-xs text-subtle">Was this review useful?</span>
        {RATINGS.map(([label, title]) => (
          <button
            key={label}
            type="button"
            disabled={pending}
            aria-pressed={value === label}
            onClick={() => rate(label)}
            className={`rounded border px-2 py-1 text-xs transition-colors disabled:opacity-50 ${
              value === label
                ? "border-foreground text-foreground"
                : "border-border text-muted hover:text-foreground"
            }`}
          >
            {title}
          </button>
        ))}
      </div>
      {value && (
        <p className="mt-1 text-xs text-subtle">
          Click the selected rating to undo. Feedback does not change the merge check.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
