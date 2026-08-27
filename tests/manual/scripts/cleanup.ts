/**
 * Closes every [verify] PR and deletes every verify/* branch created by this
 * runbook. Leaves DB rows alone — those are the evidence the run produced.
 *
 *   npx tsx tests/manual/scripts/cleanup.ts <owner/repo> [--dry-run]
 */
import { execFileSync } from "node:child_process";

const [, , repo, ...flags] = process.argv;
if (!repo) {
  console.error("usage: cleanup.ts <owner/repo> [--dry-run]");
  process.exit(1);
}
const dryRun = flags.includes("--dry-run");

function api<T>(args: string[]): T {
  return JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 })) as T;
}

const pulls = api<{ number: number; title: string; state: string }[]>([
  `repos/${repo}/pulls?state=open&per_page=100`,
]);
const verifyPulls = pulls.filter((p) => p.title.startsWith("[verify]"));

console.log(`${verifyPulls.length} open [verify] PR(s)`);
for (const pr of verifyPulls) {
  console.log(`  ${dryRun ? "would close" : "closing"} #${pr.number}: ${pr.title}`);
  if (!dryRun) {
    execFileSync("gh", ["api", `repos/${repo}/pulls/${pr.number}`, "--method", "PATCH", "-f", "state=closed"], {
      encoding: "utf-8",
    });
  }
}

const refs = api<{ ref: string }[]>([`repos/${repo}/git/matching-refs/heads/verify/`]);
console.log(`${refs.length} verify/* branch(es)`);
for (const ref of refs) {
  const branch = ref.ref.replace("refs/heads/", "");
  console.log(`  ${dryRun ? "would delete" : "deleting"} ${branch}`);
  if (!dryRun) {
    execFileSync("gh", ["api", `repos/${repo}/git/refs/heads/${branch}`, "--method", "DELETE"], { encoding: "utf-8" });
  }
}

console.log(dryRun ? "\ndry run — nothing changed" : "\ncleanup complete");
