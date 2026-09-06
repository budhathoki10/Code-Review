import "dotenv/config";
import { readFileSync } from "node:fs";
import { selectDiffForReview } from "@/lib/review/diff-selection";
import { generateChunkedReview } from "@/lib/ai/review";
import type { PullRequestFile } from "@/lib/github/diff";

/**
 * Scores the reviewer against known ground truth.
 *
 * Every other way we have looked at review quality asks "do these findings
 * look plausible", which is the question the reviewer is already good at
 * answering wrongly. This asks the only question that separates a reviewer
 * from a plausible-text generator: given a diff that provably introduces
 * N specific defects, how many does it name?
 *
 * The patch is built by diffing two comment-stripped copies of the same
 * files, so neither side carries the explanation of what is wrong with it.
 * Leaving the comments in scores the reviewer on reading our own commit
 * message back to us.
 *
 * Usage: npx tsx tests/manual/scripts/detection-benchmark.ts <patch> [label]
 */

function parsePatch(raw: string): PullRequestFile[] {
  const files: PullRequestFile[] = [];
  let filename: string | undefined;
  let lines: string[] = [];

  const flush = () => {
    if (!filename || lines.length === 0) return;
    const patch = lines.join("\n");
    files.push({
      filename,
      status: "modified",
      patch,
      patchSource: "github",
      changes: lines.filter((line) => /^[+-]/.test(line)).length,
    } as PullRequestFile);
  };

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git")) {
      flush();
      // b/<side>/<repo-relative path> — drop the throwaway side directory so
      // the model sees the real path it would see on a pull request.
      filename = line.split(" b/").pop()?.replace(/^(old|new)\//, "");
      lines = [];
      continue;
    }
    if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) continue;
    if (line.startsWith("@@") || lines.length > 0) lines.push(line);
  }
  flush();
  return files;
}

async function main() {
  const [patchPath, label = "benchmark"] = process.argv.slice(2);
  if (!patchPath) throw new Error("usage: detection-benchmark.ts <patch> [label]");

  const files = parsePatch(readFileSync(patchPath, "utf8"));
  const selection = selectDiffForReview(files);
  console.log(`\n=== ${label} ===`);
  console.log(`files: ${files.length}  chunks: ${selection.chunks.length}  covered: ${selection.coveredCount}`);
  console.log(files.map((f) => `  ${f.filename} (${f.changes} changed lines)`).join("\n"));

  const startedAt = Date.now();
  const result = await generateChunkedReview(
    selection.chunks.map((chunk) => chunk.files),
    {
      prTitle: "Refactor review budgets, context windows and comment reuse",
      prBody: "Housekeeping across the review pipeline.",
      deadlineAt: Date.now() + 180_000,
      // Only when asked for: without it runFindingsLoop offers no fetch_file
      // and collapses to a single forced call, which is NOT the deployed
      // config (REVIEW_FINDINGS_TOOL_ROUNDS=1). Both modes are worth scoring.
      ...(process.env.BENCH_INSTALLATION_ID
        ? { repoContext: {
            installationId: Number(process.env.BENCH_INSTALLATION_ID),
            owner: process.env.BENCH_OWNER!,
            repo: process.env.BENCH_REPO!,
            ref: process.env.BENCH_REF!,
          } }
        : {}),
    },
  );

  console.log(`\nduration: ${((Date.now() - startedAt) / 1000).toFixed(1)}s  calls: ${result.usage.calls}  tokens: ${result.usage.totalTokens}  unreviewed: ${result.unreviewedFiles.length}`);
  console.log(`findings: ${result.findings.length}\n`);
  for (const [index, finding] of result.findings.entries()) {
    console.log(`[${index + 1}] ${finding.severity.toUpperCase()} ${finding.category} — ${finding.file}:${finding.line ?? "?"}`);
    console.log(`    ${finding.title}`);
    console.log(`    ${finding.explanation.replace(/\s+/g, " ").slice(0, 400)}`);
    if (finding.confidence) console.log(`    confidence: ${finding.confidence}`);
    console.log();
  }
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
