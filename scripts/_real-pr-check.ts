/**
 * Runs the real review path against THIS branch's actual diff — the input
 * that defeated PR #100 — and reports timing and coverage.
 *
 * The smoke tests that cleared ultra + reasoning used one or two tiny files,
 * which is exactly why they missed that a real pull request takes minutes and
 * times out. This uses the whole diff.
 *
 *   npx tsx scripts/_real-pr-check.ts
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { generateChunkedReview } from "@/lib/ai/review";
import { selectDiffForReview } from "@/lib/review/diff-selection";
import type { PullRequestFile } from "@/lib/github/diff";

const BASE = process.argv[2] ?? "origin/main";

const names = execFileSync("git", ["diff", "--name-only", `${BASE}...HEAD`], { encoding: "utf8" })
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

const files: PullRequestFile[] = names.map((filename) => {
  const patch = execFileSync("git", ["diff", "--unified=3", `${BASE}...HEAD`, "--", filename], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  // Strip the file header; the pipeline stores only the hunks.
  const hunkStart = patch.indexOf("@@");
  return {
    filename,
    status: "modified",
    changes: (patch.match(/^[+-]/gm) ?? []).length,
    patch: hunkStart >= 0 ? patch.slice(hunkStart) : patch,
    patchSource: "github",
  };
});

const totalChars = files.reduce((sum, file) => sum + (file.patch?.length ?? 0), 0);
const selection = selectDiffForReview(files);
console.log(`files=${files.length}  patchChars=${totalChars.toLocaleString()}  chunks=${selection.chunks.length}`);
console.log(`model=${process.env.NVIDIA_MODEL}  thinking=${process.env.NVIDIA_THINKING}`);
console.log(`deadline=${process.env.REVIEW_DEADLINE_MS}ms  requestCeiling=${process.env.NVIDIA_REQUEST_TIMEOUT_MS}ms\n`);

const deadlineMs = Number(process.env.REVIEW_DEADLINE_MS ?? 420_000);
const startedAt = Date.now();
const result = await generateChunkedReview(
  selection.chunks.map((chunk) => chunk.files),
  { deadlineAt: startedAt + deadlineMs },
);
const elapsed = (Date.now() - startedAt) / 1000;

console.log(`\nelapsed=${elapsed.toFixed(1)}s  calls=${result.usage.calls}  tokens=${result.usage.totalTokens}`);
console.log(`reviewed=${files.length - result.unreviewedFiles.length}/${files.length}  findings=${result.findings.length}`);
if (result.unreviewedFiles.length > 0) {
  console.log(`UNREVIEWED: ${result.unreviewedFiles.join(", ")}`);
}
const spread = result.findings.reduce<Record<string, number>>((acc, f) => {
  acc[f.severity] = (acc[f.severity] ?? 0) + 1;
  return acc;
}, {});
console.log(`severity spread: ${JSON.stringify(spread)}`);
for (const f of result.findings.slice(0, 8)) {
  console.log(`  [${f.severity}] ${f.file}:${f.line ?? "?"} — ${f.title}`);
}
console.log(result.unreviewedFiles.length === 0 ? "\nPASS: every file was reviewed" : "\nFAIL: files were left unreviewed");
process.exit(result.unreviewedFiles.length === 0 ? 0 : 1);
