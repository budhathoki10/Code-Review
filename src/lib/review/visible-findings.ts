import type { FindingDoc, ReviewDoc } from "@/lib/db/collections";

/**
 * `review.findings` also carries forward still-open findings from files
 * this round's diff never touched (see filterCarriedForwardFindings in
 * pipeline.ts) — kept there for check-run gating, so a stale critical bug
 * still fails the gate even on a round that didn't touch that file. The
 * dashboard shouldn't re-display those every round, though: that reads as
 * "this file was reviewed again," which it wasn't. `touchedFiles` (absent
 * only on reviews saved before this field existed, in which case every
 * finding is shown, matching the old behavior) scopes display to what this
 * round's diff actually covered — the same scope GitHub's own comment uses.
 */
export function visibleFindings(review: ReviewDoc): FindingDoc[] {
  if (!review.touchedFiles) return review.findings;
  const touched = new Set(review.touchedFiles);
  return review.findings.filter((f) => touched.has(f.file));
}
