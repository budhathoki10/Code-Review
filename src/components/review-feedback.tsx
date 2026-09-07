"use client";

import { useState, useTransition } from "react";
import { markFindingNotABug, setReviewFeedback } from "@/app/dashboard/repos/[repositoryId]/actions";
import type { FindingDoc } from "@/lib/db/collections";

const RATINGS: [label: string, title: string][] = [
  ["correct", "Correct"],
  ["false-positive", "False positive"],
  ["duplicate", "Duplicate"],
];

/**
 * One rating for the review as a whole, and — only when it is needed — which
 * finding was wrong.
 *
 * The review-level rating is deliberately not per finding: that put this
 * control under every finding in every file, so the common case, "this review
 * was useful", cost a click per item. A reader forms one opinion about a
 * review, and rating it once is both the honest granularity and the only
 * version anyone actually used.
 *
 * But one opinion per review is too coarse to learn from. A review with three
 * findings and one bad one, rated "false positive", would teach the reviewer
 * that all three were wrong. So the second question is asked only of someone
 * who has already said something was wrong — the point at which they are
 * looking at the findings anyway and know which one they mean. The common
 * case still costs one click; the case that produces a usable signal costs
 * two, from a person who has already decided to spend them.
 *
 * Unlike the rating, this one changes future reviews: a finding marked here
 * is not reported again for this repository, and is shown to the verifier as
 * this team's own judgement. That is said plainly on screen, because a
 * control that quietly silences future output is one people should be able to
 * see the consequences of before clicking.
 */
export function ReviewFeedback({ reviewId, repositoryId, value, findings, notABugIds }: {
  reviewId: string;
  repositoryId: string;
  value?: string;
  findings: FindingDoc[];
  notABugIds: string[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();
  const [marked, setMarked] = useState<string[]>(notABugIds);

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

  function toggleFinding(findingId: string) {
    setError(undefined);
    startTransition(async () => {
      try {
        const result = await markFindingNotABug(reviewId, repositoryId, findingId);
        if (result.error) {
          setError(result.error);
          return;
        }
        setMarked((current) => result.marked
          ? [...current, findingId]
          : current.filter((id) => id !== findingId));
      } catch {
        setError("Could not save that. Try again.");
      }
    });
  }

  // Only findings the pipeline gave an id can be marked: the record is keyed
  // by it, and the findings array is rewritten on every re-review, so an
  // index would name a different finding an hour later. Older reviews predate
  // the id and simply do not offer the question.
  const markable = findings.filter((f): f is FindingDoc & { id: string } => Boolean(f.id));
  const askWhich = value === "false-positive" && markable.length > 0;

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

      {askWhich && (
        <div className="mt-3 rounded border border-border p-3">
          <p className="text-xs font-medium text-foreground">Which one was wrong?</p>
          <p className="mt-1 text-xs leading-relaxed text-subtle">
            Anything you select here stops being reported for this repository, and future
            reviews are told your team does not consider it a defect. Select it again to undo.
          </p>
          <ul className="mt-2 space-y-1">
            {markable.map((finding) => {
              const isMarked = marked.includes(finding.id);
              return (
                <li key={finding.id}>
                  <button
                    type="button"
                    disabled={pending}
                    aria-pressed={isMarked}
                    onClick={() => toggleFinding(finding.id)}
                    className={`flex w-full items-start gap-2 rounded border px-2 py-1.5 text-left text-xs transition-colors disabled:opacity-50 ${
                      isMarked
                        ? "border-foreground text-foreground"
                        : "border-transparent text-muted hover:border-border hover:text-foreground"
                    }`}
                  >
                    <span aria-hidden="true" className="mt-0.5 shrink-0">{isMarked ? "✓" : "○"}</span>
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[11px] text-subtle">
                        {finding.file}{finding.line ? `:${finding.line}` : ""}
                      </span>
                      <span className="block">{finding.title}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {value && !askWhich && (
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
