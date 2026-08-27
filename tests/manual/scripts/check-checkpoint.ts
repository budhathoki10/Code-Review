/**
 * Scenario 7's assertion: after a killed-and-retried review, did the second
 * attempt reuse the AI checkpoint or re-spend the token budget?
 *
 *   npx tsx tests/manual/scripts/check-checkpoint.ts <owner/repo> <prNumber>
 */
import "dotenv/config";
import { MongoClient } from "mongodb";

const [, , , prArg] = process.argv;
if (!prArg) {
  console.error("usage: check-checkpoint.ts <owner/repo> <prNumber>");
  process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 10_000 });
await client.connect();
const db = client.db(process.env.MONGODB_DB);

const prDoc = await db.collection("pull_requests").findOne({ githubPrNumber: Number(prArg) });
const rows = prDoc
  ? await db.collection("reviews").find({ pullRequestId: String(prDoc._id) }).sort({ createdAt: 1 }).toArray()
  : [];

let failed = 0;
for (const r of rows) {
  const cp = r.aiCheckpoint;
  const m = r.metrics;
  console.log(`\nreview ${String(r._id)}  head ${String(r.headSha).slice(0, 8)}  status ${r.status}`);
  if (!cp) {
    console.log("  checkpoint: ABSENT");
    console.log("  -> If this review reached the model at all, a retry would have re-spent the full budget.");
    if (m && m.calls > 0) failed++;
    continue;
  }
  console.log(`  checkpoint: present (written ${cp.at})`);
  console.log(`    calls checkpointed : ${cp.calls}`);
  console.log(`    tokens checkpointed: ${cp.totalTokens.toLocaleString()}`);
  console.log(`    findings           : ${cp.findings.length}`);
  console.log(`    unreviewed files   : ${cp.unreviewedFiles.length}`);
  if (m) {
    const reused = m.calls === cp.calls && m.totalTokens === cp.totalTokens;
    console.log(`  final metrics match checkpoint: ${reused ? "yes" : "no"}`);
    console.log(
      reused
        ? "  PASS — the recorded cost equals the checkpointed cost, i.e. no second generation was paid for."
        : "  INVESTIGATE — metrics differ from the checkpoint; generation may have run more than once.",
    );
    if (!reused) failed++;
  }
}

console.log(
  `\nWatch the worker log for "reusing the model output from a previous attempt" — that line is the direct proof.\n`,
);

await client.close();
process.exit(failed === 0 ? 0 : 1);
