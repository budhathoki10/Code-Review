"use client";

import { useState, useTransition } from "react";
import { setFindingFeedback } from "@/app/dashboard/repos/[repositoryId]/actions";

export function FindingFeedback({ reviewId, repositoryId, findingId, value }: {
  reviewId: string; repositoryId: string; findingId: string; value?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();
  function rate(label: string) {
    setError(undefined);
    startTransition(async () => {
      try {
        const result = await setFindingFeedback(reviewId, repositoryId, findingId, label === value ? "clear" : label);
        if (result.error) setError(result.error);
      } catch { setError("Could not save feedback. Try again."); }
    });
  }
  return <div className="mt-3">
    <div className="flex flex-wrap items-center gap-2" aria-label="Rate this finding">
      <span className="text-xs text-subtle">Was this useful?</span>
      {[["correct", "Correct"], ["false-positive", "False positive"], ["duplicate", "Duplicate"]].map(([label, title]) =>
        <button key={label} type="button" disabled={pending} aria-pressed={value === label} onClick={() => rate(label)}
          className={`rounded border px-2 py-1 text-xs disabled:opacity-50 ${value === label ? "border-foreground text-foreground" : "border-border text-muted hover:text-foreground"}`}>
          {title}
        </button>)}
    </div>
    {value && <p className="mt-1 text-xs text-subtle">Click the selected rating to undo. Feedback does not change the merge check.</p>}
    {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
  </div>;
}
