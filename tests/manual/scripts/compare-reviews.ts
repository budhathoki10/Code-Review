/**
 * Compares every review row for one PR, in order. Scenario 4's whole point is
 * that the SECOND review costs a fraction of the first — a claim only visible
 * by putting the two rows side by side.
 *
 *   npx tsx tests/manual/scripts/compare-reviews.ts <owner/repo> <prNumber>
 */
import "dotenv/config";
import { MongoClient } from "mongodb";

const [, , repo, prArg] = process.argv;
if (!repo || !prArg) {
  console.error("usage: compare-reviews.ts <owner/repo> <prNumber>");
  process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 10_000 });
await client.connect();
const db = client.db(process.env.MONGODB_DB);

const prDoc = await db.collection("pull_requests").findOne({ githubPrNumber: Number(prArg) });
if (!prDoc) {
  console.error(`no tracked pull request #${prArg}`);
  await client.close();
  process.exit(1);
}

const rows = await db
  .collection("reviews")
  .find({ pullRequestId: String(prDoc._id) })
  .sort({ createdAt: 1 })
  .toArray();

console.log(`\n=== ${repo}#${prArg} — ${rows.length} review(s) ===`);
console.log(`  lastReviewedSha: ${prDoc.lastReviewedSha ?? "(unset)"}\n`);

const header = ["#", "headSha", "status", "calls", "tokens", "files", "findings", "inline", "duration", "checkpoint"];
const table = rows.map((r, i) => {
  const m = r.metrics;
  return [
    String(i + 1),
    String(r.headSha).slice(0, 8),
    r.incomplete ? `bail:${r.incomplete.reason}` : r.status,
    m ? String(m.calls) : "-",
    m ? m.totalTokens.toLocaleString() : "-",
    m ? `${m.filesReviewed}/${m.filesSeen}` : "-",
    String((r.findings ?? []).length),
    m ? String(m.commentsPosted) : "-",
    m ? `${(m.durationMs / 1000).toFixed(1)}s` : "-",
    r.aiCheckpoint ? "yes" : "no",
  ];
});

const widths = header.map((h, i) => Math.max(h.length, ...table.map((r) => r[i].length)));
const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
console.log("  " + line(header));
console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
for (const row of table) console.log("  " + line(row));

if (rows.length >= 2) {
  const first = rows[0].metrics;
  const last = rows[rows.length - 1].metrics;
  if (first?.totalTokens && last) {
    const pct = (last.totalTokens / first.totalTokens) * 100;
    console.log(
      `\n  incremental saving: latest review used ${pct.toFixed(1)}% of the first review's tokens ` +
        `(${last.totalTokens.toLocaleString()} vs ${first.totalTokens.toLocaleString()})`,
    );
    console.log(`  ${pct < 25 ? "PASS" : "INVESTIGATE"} — a follow-up push should be a small fraction, not a re-review.`);
  }
}
console.log();

await client.close();
