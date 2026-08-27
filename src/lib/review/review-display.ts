import type { FindingDoc, ReviewDoc } from "@/lib/db/collections";
import { SEVERITY_ORDER } from "@/lib/ui";

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

export interface SeverityFindingGroup {
  severity: FindingDoc["severity"];
  findings: FindingDoc[];
}

/**
 * Groups findings by severity — critical first, then high, medium, low,
 * info — with each finding still carrying its own `file`/`line` so nothing
 * is lost by no longer grouping on file. Severities with zero findings are
 * omitted entirely, so a clean review renders no groups at all rather than
 * five empty folders.
 *
 * This is the grouping the reviewer actually scans by: "what's critical"
 * matters more than "which file", especially on a review that touches
 * dozens of files — a single file view buries three unrelated highs among
 * forty clean rows, where a severity view puts them one tap away.
 */
export function groupFindingsBySeverity(findings: FindingDoc[]): SeverityFindingGroup[] {
  return SEVERITY_ORDER.map((severity) => ({
    severity,
    findings: findings.filter((f) => f.severity === severity),
  })).filter((group) => group.findings.length > 0);
}
