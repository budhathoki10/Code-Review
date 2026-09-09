import { createHash } from "node:crypto";
import type { FindingDoc } from "@/lib/db/collections";

export function findingId(finding: FindingDoc): string {
  return createHash("sha256").update(`${finding.file}\0${finding.category}\0${finding.title.trim().toLowerCase().replace(/\s+/g, " ")}`)
    .digest("hex").slice(0, 24);
}

export function dedupeFindings(findings: FindingDoc[]): FindingDoc[] {
  const unique = new Map<string, FindingDoc>();
  const rank = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
  for (const finding of findings) {
    const id = findingId(finding);
    const previous = unique.get(id);
    if (!previous || rank[finding.severity] > rank[previous.severity]) unique.set(id, { ...finding, id });
  }
  return [...unique.values()];
}

/**
 * Severity decides this now, not a second model's sign-off.
 *
 * It used to also require `verification.status === "accepted"`, from when a
 * separate assessment pass ran after discovery. That pass is gone — precision
 * is the review call's job now — and leaving the check in would have meant no
 * finding could ever block again, silently turning every gate into a no-op.
 *
 * An explicit "this is not blocking-grade" verdict is still honoured, because
 * some findings still carry one: reviews written before the change, and the
 * staged pipeline behind REVIEW_MULTI_STAGE. A finding something actually
 * assessed and threw out must not start failing builds just because the stage
 * that threw it out no longer runs by default. `skipped` is not such a
 * verdict — it means nothing looked — so it falls through to severity like an
 * unassessed finding does.
 */
export function canBlock(finding: FindingDoc): boolean {
  const verdict = finding.verification?.status;
  return (finding.severity === "high" || finding.severity === "critical")
    && verdict !== "rejected" && verdict !== "downgraded";
}

export function evidenceLabel(finding: FindingDoc): string {
  if (finding.proof?.status === "reproduced") return "Regression reproduced · proposed test passes on base and fails on head";
  if (finding.source === "static-analysis") return "Static analysis";
  // Only reviews from before the assessment pass was removed carry one.
  if (finding.verification?.status === "accepted") return "Probable · evidence checked by AI; not test-proven";
  if (finding.verification && finding.verification.status !== "skipped") return `Advisory · ${finding.verification.reason}`;
  return "Read by AI · not proven by a test run";
}
