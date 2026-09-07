import "dotenv/config";
import { readFileSync } from "node:fs";
import type { Logger } from "pino";
import { logger } from "@/lib/logger";
import { runMultiStageReview } from "@/lib/review/multi-stage";
import { runPrimaryReview } from "@/lib/ai/primary-review";
import { runSecondaryReview } from "@/lib/ai/secondary-review";
import { reconcile } from "@/lib/review/reconciliation";
import { buildReviewContext } from "@/lib/review/context-builder";
import { validateLocation, isPresentable } from "@/lib/review/location-validation";
import { toFindingDoc } from "@/lib/review/stage-types";
import type { PullRequestFile } from "@/lib/github/diff";
import type { FindingDoc } from "@/lib/db/collections";

/**
 * Measures whether the extra stages actually improve accuracy.
 *
 * The specification is explicit that more stages must not be assumed to help,
 * and the assumption is a genuinely dangerous one here: every stage after the
 * first can only remove findings, so a pipeline that adds verification, debate
 * and arbitration is guaranteed to raise precision and equally guaranteed to
 * risk recall. Which of those dominates is an empirical question about this
 * model on this code, and nothing about the architecture answers it.
 *
 * So four configurations are run over the same pull request, against ground
 * truth someone wrote down beforehand:
 *
 *   A  primary review only
 *   B  primary + independent verification
 *   C  + debate
 *   D  + arbitration and deterministic validation (the full pipeline)
 *
 * A finding counts as a hit when it lands in the same file and its line range
 * overlaps the range the ground truth names, within a small slack. Matching on
 * wording would score the model on vocabulary rather than on whether it found
 * the defect.
 *
 * Usage:
 *   BENCH_INSTALLATION_ID=... BENCH_OWNER=... BENCH_REPO=... BENCH_REF=... \
 *   npx tsx tests/manual/scripts/evaluate-pipeline.ts <patch> <truth.json>
 *
 * truth.json:
 *   { "defects": [ { "file": "src/a.ts", "startLine": 26, "endLine": 28,
 *                    "severity": "high", "note": "off-by-one" } ] }
 */

interface GroundTruthDefect {
  file: string;
  startLine: number;
  endLine: number;
  severity?: FindingDoc["severity"];
  note?: string;
}

const LINE_SLACK = 5;

function parsePatch(raw: string): PullRequestFile[] {
  const files: PullRequestFile[] = [];
  let filename: string | undefined;
  let lines: string[] = [];
  const flush = () => {
    if (!filename || lines.length === 0) return;
    files.push({
      filename, status: "modified", patch: lines.join("\n"), patchSource: "github",
      changes: lines.filter((l) => /^[+-]/.test(l)).length,
    } as PullRequestFile);
  };
  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git")) {
      flush();
      filename = line.split(" b/").pop()?.replace(/^(old|new|before|after)\//, "");
      lines = [];
      continue;
    }
    if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) continue;
    if (line.startsWith("@@") || lines.length > 0) lines.push(line);
  }
  flush();
  return files;
}

function hits(finding: FindingDoc, defect: GroundTruthDefect): boolean {
  if (finding.file !== defect.file) return false;
  const start = finding.startLine ?? finding.line ?? 0;
  const end = finding.endLine ?? start;
  return start - LINE_SLACK <= defect.endLine && defect.startLine - LINE_SLACK <= end;
}

interface Score {
  label: string;
  reported: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  severityCorrect: number;
  durationMs: number;
  calls: number;
}

function score(label: string, reported: FindingDoc[], truth: GroundTruthDefect[], durationMs: number, calls: number): Score {
  const matchedDefects = new Set<number>();
  let truePositives = 0;
  let severityCorrect = 0;
  for (const finding of reported) {
    const index = truth.findIndex((d) => hits(finding, d));
    if (index >= 0) {
      truePositives++;
      matchedDefects.add(index);
      if (truth[index].severity && truth[index].severity === finding.severity) severityCorrect++;
    }
  }
  const falsePositives = reported.length - truePositives;
  const falseNegatives = truth.length - matchedDefects.size;
  return {
    label,
    reported: reported.length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: reported.length === 0 ? 1 : truePositives / reported.length,
    recall: truth.length === 0 ? 1 : matchedDefects.size / truth.length,
    severityCorrect,
    durationMs,
    calls,
  };
}

function table(scores: Score[]): string {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const rows = scores.map((s) =>
    [
      s.label.padEnd(34),
      String(s.reported).padStart(8),
      String(s.truePositives).padStart(3),
      String(s.falsePositives).padStart(3),
      String(s.falseNegatives).padStart(3),
      pct(s.precision).padStart(10),
      pct(s.recall).padStart(7),
      String(s.calls).padStart(6),
      `${(s.durationMs / 1000).toFixed(1)}s`.padStart(9),
    ].join(""),
  );
  const header = ["configuration".padEnd(34), "reported".padStart(8), " TP", " FP", " FN", " precision", " recall", " calls", "     time"].join("");
  return [header, "-".repeat(header.length), ...rows].join("\n");
}

async function main() {
  const [patchPath, truthPath] = process.argv.slice(2);
  if (!patchPath || !truthPath) throw new Error("usage: evaluate-pipeline.ts <patch> <truth.json>");

  const truth = (JSON.parse(readFileSync(truthPath, "utf8")) as { defects: GroundTruthDefect[] }).defects;
  const files = parsePatch(readFileSync(patchPath, "utf8"));
  const repo = {
    installationId: Number(process.env.BENCH_INSTALLATION_ID),
    owner: process.env.BENCH_OWNER!,
    repo: process.env.BENCH_REPO!,
    ref: process.env.BENCH_REF!,
  };
  const meta = { owner: repo.owner, repo: repo.repo, prNumber: 0, headSha: repo.ref };
  const log = logger.child({ evaluation: true }) as Logger;

  console.log(`\nfiles: ${files.length}  ground-truth defects: ${truth.length}`);
  for (const d of truth) console.log(`  expected ${d.file}:${d.startLine}-${d.endLine}${d.note ? ` — ${d.note}` : ""}`);

  const scores: Score[] = [];
  const context = await buildReviewContext(files, repo, meta, Date.now() + 120_000);
  const validationInput = { sources: context.sources, files, commitSha: repo.ref };

  // A — primary only. The ceiling on everything after it.
  let startedAt = Date.now();
  const primary = await runPrimaryReview(context.text, Date.now() + 600_000);
  const aFindings = primary.findings.map((c) => toFindingDoc({ candidate: c, status: "candidate" }, repo.ref));
  scores.push(score("A  primary only", aFindings, truth, Date.now() - startedAt, primary.usage.calls));

  // B — plus independent verification, reconciled but not argued about.
  startedAt = Date.now();
  const secondary = await runSecondaryReview(context.text, primary.findings, Date.now() + 600_000);
  const reconciled = reconcile(primary.findings, secondary.verifications, secondary.newFindings);
  const bFindings = reconciled.tracked
    .filter((t) => t.status === "agreed" || t.status === "candidate")
    .map((t) => toFindingDoc(t, repo.ref));
  scores.push(score("B  + independent verification", bFindings, truth, Date.now() - startedAt, secondary.usage.calls));

  // C — B plus everything disputed also reported, which is what a pipeline
  // without debate would have to do: it cannot resolve them, so it either
  // shows them or silently drops them. Showing them is the generous reading.
  const cFindings = reconciled.tracked.map((t) => toFindingDoc(t, repo.ref));
  scores.push(score("C  + disputed reported as-is", cFindings, truth, 0, 0));

  // D — the full pipeline, including debate, arbitration and the
  // deterministic location check.
  startedAt = Date.now();
  const full = await runMultiStageReview({ files, repo, meta, deadlineAt: Date.now() + 900_000, log });
  scores.push(score("D  full pipeline", full.findings, truth, Date.now() - startedAt, full.usage.calls));

  // How many defects the deterministic check alone would have removed, so the
  // stage's cost is visible separately from the models'.
  const droppedByValidation = reconciled.tracked
    .map((t) => validateLocation(t, validationInput))
    .filter((t) => !isPresentable(t)).length;

  console.log(`\n${table(scores)}`);
  console.log(`\nunresolved in D: ${full.unresolved.length}   rejected in D: ${full.rejected.length}   dropped by location validation: ${droppedByValidation}`);
  console.log(`stage counts: ${JSON.stringify(full.stats)}`);
  console.log(`\nA finding counts as a hit when it is in the same file and its range overlaps the expected range within ${LINE_SLACK} lines.`);
  console.log("Precision and recall move in opposite directions here by construction — every stage after A can only remove findings.");
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
