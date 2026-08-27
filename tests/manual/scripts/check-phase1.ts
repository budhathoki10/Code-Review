/**
 * Runs the REAL Phase 1 diff-fetching code against a live pull request and
 * reports what it actually produced.
 *
 * This is the check unit tests cannot make. It exercises, against real
 * GitHub, in one pass:
 *   - octokit.paginate existing at all (the plugin was never wired in once)
 *   - full pagination rather than a truncated first page
 *   - `patch: null` detection
 *   - the lazy base/head SHA fetch
 *   - getFileContent, its cache, and the Contents -> Blobs fallback
 *   - local diff reconstruction, and whether the result parses as a patch
 *
 * Needs no webhook, no worker and no model calls — it only reads from GitHub.
 *
 *   npx tsx tests/manual/scripts/check-phase1.ts <installationId> <owner> <repo> <prNumber>
 */
import "dotenv/config";
import { getPullRequestDiff } from "@/lib/github/diff";
import { computeCommentableLines } from "@/lib/github/diff-lines";
import { selectDiffForReview, coverageRatio, fileCoverage, charCoverage } from "@/lib/review/diff-selection";
import { evaluateSizeGate, estimateReviewCost } from "@/lib/review/gate";
import { DEFAULT_CONFIG } from "@/lib/review/config";

const [, , installationArg, owner, repo, prArg] = process.argv;
if (!installationArg || !owner || !repo || !prArg) {
  console.error("usage: check-phase1.ts <installationId> <owner> <repo> <prNumber>");
  process.exit(1);
}

const started = Date.now();
const diff = await getPullRequestDiff(Number(installationArg), owner, repo, Number(prArg));
const fetchMs = Date.now() - started;

console.log(`\n=== Phase 1 against ${owner}/${repo}#${prArg} ===`);
console.log(`  fetch wall clock     : ${(fetchMs / 1000).toFixed(1)}s`);
console.log(`  fileCount            : ${diff.fileCount}`);
console.log(`  totalChangedLines    : ${diff.totalChangedLines.toLocaleString()}`);
console.log(`  oversized            : ${Boolean(diff.oversized)}`);
console.log(`  diffText chars       : ${diff.diffText.length.toLocaleString()}`);

const bySource = new Map<string, number>();
for (const f of diff.files) bySource.set(f.patchSource ?? "none", (bySource.get(f.patchSource ?? "none") ?? 0) + 1);
console.log(`  patch sources        : ${[...bySource].map(([k, v]) => `${k}=${v}`).join(", ")}`);

console.log(`\n  per-file (first 10):`);
for (const f of diff.files.slice(0, 10)) {
  console.log(
    `    ${f.filename.padEnd(28)} status=${String(f.status).padEnd(9)} changes=${String(f.changes ?? "?").padEnd(6)} ` +
      `source=${String(f.patchSource).padEnd(11)} patchLen=${(f.patch?.length ?? 0).toLocaleString()}`,
  );
}

// A reconstructed patch is only useful if the hunk parser can read line
// numbers out of it — otherwise inline comments can never attach to it.
const commentable = computeCommentableLines(diff.files);
console.log(`\n  commentable lines parsed:`);
for (const f of diff.files.slice(0, 10)) {
  const lines = commentable.get(f.filename);
  console.log(`    ${f.filename.padEnd(28)} ${lines ? `${lines.size} lines` : "NONE — inline comments impossible"}`);
}

const selection = selectDiffForReview(diff.files);
const gate = evaluateSizeGate(selection, DEFAULT_CONFIG);
const cost = estimateReviewCost(selection);

console.log(`\n  --- selection + gate ---`);
console.log(`  reviewable files     : ${selection.reviewableCount}`);
console.log(`  filtered             : ${selection.skippedAsNoise.length + selection.triaged.length}`);
console.log(`  diffUnavailable      : ${selection.diffUnavailable.length}${selection.diffUnavailable.length ? ` (${selection.diffUnavailable.join(", ")})` : ""}`);
console.log(`  truncated            : ${selection.truncatedFiles.length}${selection.truncatedFiles.length ? ` (${selection.truncatedFiles.join(", ")})` : ""}`);
console.log(`  coverage             : ${Math.round(coverageRatio(selection) * 100)}%  (files ${Math.round(fileCoverage(selection) * 100)}%, chars ${Math.round(charCoverage(selection) * 100)}%)`);
console.log(`  chunks               : ${selection.chunks.length}`);
console.log(`  GATE                 : ${gate.bail ? `BAIL (${gate.reason})` : selection.chunks.length === 0 ? "nothing to review" : "review"}`);
if (gate.detail) console.log(`  detail               : ${gate.detail}`);
console.log(`  projected tokens     : ~${cost.expectedTokens.toLocaleString()}`);

console.log(`\n  --- assertions ---`);
let failed = 0;
const assert = (name: string, pass: boolean, detail: string) => {
  if (!pass) failed++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name.padEnd(46)} ${detail}`);
};

assert("every file has a patch or is reported", diff.files.every((f) => f.patch !== undefined || f.status === "removed"),
  `${diff.files.filter((f) => f.patch === undefined && f.status !== "removed").length} file(s) with no patch and no marker`);
assert("no file silently vanished from selection",
  selection.reviewableCount + selection.skippedAsNoise.length + selection.triaged.length + selection.diffUnavailable.length === diff.fileCount,
  `${selection.reviewableCount}+${selection.skippedAsNoise.length}+${selection.triaged.length}+${selection.diffUnavailable.length} vs ${diff.fileCount}`);
assert("per-file change counts recorded", diff.files.every((f) => typeof f.changes === "number"),
  "changes/additions/deletions present");
assert("totalChangedLines is non-zero", diff.totalChangedLines > 0, String(diff.totalChangedLines));

console.log(`\n  ${failed === 0 ? "ALL PHASE 1 ASSERTIONS PASSED" : `${failed} ASSERTION(S) FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
