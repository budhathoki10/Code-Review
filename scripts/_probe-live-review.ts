/**
 * Same idea as _real-pr-check.ts, but against the current WORKING TREE diff
 * (uncommitted changes included) instead of a committed range, so it can be
 * used to sanity-check a config change before committing anything.
 *
 *   npx tsx scripts/_probe-live-review.ts [base]
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { generateChunkedReview } from "@/lib/ai/review";
import { selectDiffForReview } from "@/lib/review/diff-selection";
import type { PullRequestFile } from "@/lib/github/diff";

async function main() {
  const BASE = process.argv[2] ?? "origin/main";

  const names = execFileSync("git", ["diff", "--name-only", BASE], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const files: PullRequestFile[] = names.map((filename) => {
    const patch = execFileSync("git", ["diff", "--unified=3", BASE, "--", filename], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
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
  console.log(`model=${process.env.NVIDIA_MODEL}  backup=${process.env.NVIDIA_BACKUP_MODEL}  thinking=${process.env.NVIDIA_THINKING}`);
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
  for (const f of result.findings.slice(0, 8)) {
    console.log(`  [${f.severity}] ${f.file}:${f.line ?? "?"} — ${f.title}`);
  }
  console.log(result.unreviewedFiles.length === 0 ? "\nPASS: every file was reviewed" : "\nFAIL: files were left unreviewed");
  process.exit(result.unreviewedFiles.length === 0 ? 0 : 1);
}

main();
