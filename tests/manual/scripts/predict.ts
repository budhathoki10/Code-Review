/**
 * Predicts what the pipeline SHOULD do with a scenario, by running the real
 * selection and gate code over a locally-computed diff.
 *
 * The prediction deliberately imports the production modules rather than
 * restating their arithmetic: a runbook whose expected values are hand-copied
 * constants stops being a check the moment someone tunes a budget, and starts
 * being a second thing to keep in sync.
 *
 *   npx tsx tests/manual/scripts/predict.ts 1
 *   npx tsx tests/manual/scripts/predict.ts        # all scenarios
 */
import { createTwoFilesPatch } from "diff";
import {
  selectDiffForReview,
  coverageRatio,
  fileCoverage,
  charCoverage,
  REVIEW_CAPACITY,
} from "@/lib/review/diff-selection";
import { evaluateSizeGate, estimateReviewCost } from "@/lib/review/gate";
import { DEFAULT_CONFIG } from "@/lib/review/config";
import { MAX_FINDINGS_TOOL_ROUNDS } from "@/lib/ai/review";
import type { PullRequestFile } from "@/lib/github/diff";
import { SCENARIOS, scenarioById, type Scenario } from "./fixtures";

/**
 * GitHub stops returning a `patch` for a single file somewhere around this
 * size. The exact threshold is undocumented and has moved before, which is
 * precisely why scenario 3 checks the live API rather than trusting this
 * number — it exists only to make the prediction approximately honest.
 */
const APPROX_PATCH_NULL_BYTES = 400_000;

/** Mirrors MAX_GENERATED_PATCH_CHARS in patch-fallback.ts. */
const MAX_GENERATED_PATCH_CHARS = Number(process.env.MAX_GENERATED_PATCH_CHARS ?? 60_000);

/** Builds the same PullRequestFile[] the pipeline would receive, without calling GitHub. */
const reconstructed = new Map<string, string>();

export function localDiff(scenario: Scenario): PullRequestFile[] {
  const paths = new Set([...Object.keys(scenario.base), ...Object.keys(scenario.head)]);
  const files: PullRequestFile[] = [];

  for (const path of [...paths].sort()) {
    const before = scenario.base[path] ?? "";
    const after = scenario.head[path] ?? "";
    if (before === after) continue;

    const full = createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, undefined, undefined, { context: 3 });
    const firstHunk = full.indexOf("@@");
    const patch = firstHunk === -1 ? "" : full.slice(firstHunk);

    const additions = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    const deletions = patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;

    const tooBig = patch.length > APPROX_PATCH_NULL_BYTES;
    // Cached so predict() never re-diffs a large file: jsdiff is superlinear
    // in the number of differing lines, and scenario 3 exists precisely to be
    // enormous.
    reconstructed.set(path, patch.slice(0, MAX_GENERATED_PATCH_CHARS));
    files.push({
      filename: path,
      status: before === "" ? "added" : after === "" ? "removed" : "modified",
      patch: tooBig ? undefined : patch,
      changes: additions + deletions,
      additions,
      deletions,
      // Mirrors what Phase 1 does: a null patch is reconstructed locally.
      patchSource: tooBig ? "local" : "github",
    });
  }

  return files;
}

export interface Prediction {
  scenario: Scenario;
  filesSeen: number;
  totalChangedLines: number;
  filtered: number;
  reviewable: number;
  covered: number;
  fileCovPct: number;
  charCovPct: number;
  coveragePct: number;
  chunks: number;
  bails: boolean;
  bailReason?: string;
  expectedTokens: number;
  worstCaseTokens: number;
  typicalCalls: number;
  worstCalls: number;
  patchNullFiles: string[];
}

export function predict(scenario: Scenario): Prediction {
  const files = localDiff(scenario);

  // Phase 1 reconstructs a null patch before selection ever sees it, so the
  // prediction has to feed selection the reconstructed form — and it has to
  // be the REAL reconstruction (the locally-computed patch, truncated to
  // MAX_GENERATED_PATCH_CHARS), not a placeholder. A stand-in like
  // "-reconstructed/+reconstructed" is whitespace-identical on both sides and
  // gets triaged away as a formatting change, which would predict the exact
  // silent drop this scenario exists to catch.
  const forSelection = files.map((file) =>
    file.patch !== undefined ? file : { ...file, patch: reconstructed.get(file.filename) ?? "" },
  );

  const selection = selectDiffForReview(forSelection);
  const gate = evaluateSizeGate(selection, DEFAULT_CONFIG);
  const cost = estimateReviewCost(selection);
  const chunks = selection.chunks.length;

  const rounds = MAX_FINDINGS_TOOL_ROUNDS + 1;
  const worstCalls = gate.bail || chunks === 0 ? 0 : chunks * rounds + 1;
  const typicalCalls = gate.bail || chunks === 0 ? 0 : chunks + 1;

  return {
    scenario,
    filesSeen: files.length,
    totalChangedLines: files.reduce((t, f) => t + (f.changes ?? 0), 0),
    filtered: selection.skippedAsNoise.length + selection.triaged.length,
    reviewable: selection.reviewableCount,
    covered: selection.coveredCount,
    fileCovPct: Math.round(fileCoverage(selection) * 100),
    charCovPct: Math.round(charCoverage(selection) * 100),
    coveragePct: Math.round(coverageRatio(selection) * 100),
    chunks,
    bails: gate.bail,
    bailReason: gate.reason,
    expectedTokens: cost.expectedTokens,
    worstCaseTokens: cost.worstCaseTokens,
    typicalCalls,
    worstCalls,
    patchNullFiles: files.filter((f) => f.patch === undefined).map((f) => f.filename),
  };
}

export function printPrediction(p: Prediction): void {
  const s = p.scenario;
  console.log(`\n=== Scenario ${s.id}: ${s.title} ===`);
  console.log(`  ${s.intent}`);
  console.log(`  files seen           : ${p.filesSeen}`);
  console.log(`  total changed lines  : ${p.totalChangedLines.toLocaleString()}`);
  console.log(`  filtered out         : ${p.filtered}`);
  console.log(`  reviewable files     : ${p.reviewable}`);
  console.log(`  covered files        : ${p.covered}`);
  console.log(`  coverage             : ${p.coveragePct}%  (files ${p.fileCovPct}%, chars ${p.charCovPct}%)`);
  console.log(`  chunks               : ${p.chunks}`);
  console.log(`  GATE                 : ${p.bails ? `BAIL (${p.bailReason})` : p.chunks === 0 ? "nothing to review" : "review"}`);
  console.log(`  predicted LLM calls  : ${p.typicalCalls} typical, up to ${p.worstCalls}`);
  console.log(`  predicted tokens     : ~${p.expectedTokens.toLocaleString()} (worst ~${p.worstCaseTokens.toLocaleString()})`);
  if (p.patchNullFiles.length > 0) {
    console.log(`  expect patch:null on : ${p.patchNullFiles.join(", ")}`);
  }
  console.log(`  capacity             : ${REVIEW_CAPACITY.files} files / ${REVIEW_CAPACITY.chars.toLocaleString()} chars`);
  for (const note of s.expect.notes) console.log(`  CHECK: ${note}`);
}

if (process.argv[1]?.includes("predict")) {
  const arg = process.argv[2];
  const list = arg ? [scenarioById(Number(arg))] : SCENARIOS;
  for (const scenario of list) printPrediction(predict(scenario));
  console.log();
}
