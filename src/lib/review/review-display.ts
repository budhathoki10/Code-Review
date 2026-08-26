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

export interface FileFindingGroup {
  file: string;
  findings: FindingDoc[];
  /** Index into SEVERITY_ORDER, or SEVERITY_ORDER.length for a clean (zero-finding) file — lets callers sort worst-first with clean files trailing. */
  worst: number;
}

/**
 * Groups findings under the file they belong to, worst-severity file first —
 * turns a flat list into something scannable when a review touches several
 * files. `touchedFiles`, when given, adds a zero-finding entry (sorted after
 * every file that has findings) for each file this round reviewed but found
 * nothing in — so an all-clear review still shows the scope of what was
 * actually checked, not just an empty list.
 */
export function groupFindingsByFile(findings: FindingDoc[], touchedFiles?: string[]): FileFindingGroup[] {
  const order: string[] = [];
  const byFile = new Map<string, FindingDoc[]>();
  for (const finding of findings) {
    if (!byFile.has(finding.file)) order.push(finding.file);
    byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
  }
  for (const file of touchedFiles ?? []) {
    if (!byFile.has(file)) {
      order.push(file);
      byFile.set(file, []);
    }
  }
  return order
    .map((file) => {
      const items = [...byFile.get(file)!].sort(
        (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
      );
      const worst = items.length > 0 ? SEVERITY_ORDER.indexOf(items[0].severity) : SEVERITY_ORDER.length;
      return { file, findings: items, worst };
    })
    .sort((a, b) => a.worst - b.worst);
}
