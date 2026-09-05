import type { FindingDoc } from "@/lib/db/collections";

/** Observed, explicitly labeled sample only. Duplicates are a separate noise measure. */
export function feedbackStats(findings: FindingDoc[]) {
  const correct = findings.filter((finding) => finding.feedback?.label === "correct").length;
  const falsePositive = findings.filter((finding) => finding.feedback?.label === "false-positive").length;
  const duplicate = findings.filter((finding) => finding.feedback?.label === "duplicate").length;
  const assessed = correct + falsePositive;
  return { correct, falsePositive, duplicate, assessed, falsePositiveRate: assessed ? falsePositive / assessed : null };
}
