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

export function canBlock(finding: FindingDoc): boolean {
  return (finding.severity === "high" || finding.severity === "critical") &&
    finding.verification?.status === "accepted" && finding.verification.evidence.length > 0;
}

export function evidenceLabel(finding: FindingDoc): string {
  if (finding.proof?.status === "reproduced") return "Regression reproduced · proposed test passes on base and fails on head";
  if (!finding.verification) return finding.source === "static-analysis" ? "Static analysis" : "Advisory · not independently assessed";
  return finding.verification.status === "accepted"
    ? "Probable · evidence checked by AI; not test-proven"
    : `Advisory · ${finding.verification.reason}`;
}
