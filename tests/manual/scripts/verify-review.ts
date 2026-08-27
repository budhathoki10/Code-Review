/**
 * Checks a posted review against what the pipeline should have done.
 *
 * Reads three sources and cross-checks them, because each one alone has
 * missed real bugs in this codebase:
 *   - the DB review record (call count, tokens, cost, metrics)
 *   - the PR's actual inline comments and summary comment on GitHub
 *   - the prediction from the real selection/gate code
 *
 * Exits non-zero if any check fails, so it can gate a future CI job.
 *
 *   npx tsx tests/manual/scripts/verify-review.ts <scenario> <owner/repo> <prNumber>
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { MongoClient } from "mongodb";
import { scenarioById } from "./fixtures";
import { predict } from "./predict";
import { MAX_INLINE_COMMENTS } from "@/lib/github/diff-lines";

function api<T>(path: string): T {
  return JSON.parse(
    execFileSync("gh", ["api", path, "--paginate"], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }),
  ) as T;
}

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
}

const [, , idArg, repo, prArg] = process.argv;
if (!idArg || !repo || !prArg) {
  console.error("usage: verify-review.ts <scenario> <owner/repo> <prNumber>");
  process.exit(1);
}

const scenario = scenarioById(Number(idArg));
const prNumber = Number(prArg);
const prediction = predict(scenario);

// ---- GitHub side -----------------------------------------------------------

const inlineComments = api<{ id: number; path: string; line: number | null; body: string }[]>(
  `repos/${repo}/pulls/${prNumber}/comments`,
);
const issueComments = api<{ id: number; body: string; created_at: string; user: { login: string } }[]>(
  `repos/${repo}/issues/${prNumber}/comments`,
);
const reviewEvents = api<{ id: number; state: string; submitted_at: string }[]>(`repos/${repo}/pulls/${prNumber}/reviews`);

const summary = issueComments.find((c) => c.body.includes("AI Code Review"));

check("summary comment posted", Boolean(summary), summary ? `comment ${summary.id}` : "NONE FOUND");

check(
  `inline comments <= ${MAX_INLINE_COMMENTS}`,
  inlineComments.length <= MAX_INLINE_COMMENTS,
  `${inlineComments.length} inline comments`,
);

check(
  "one review event (not one per comment)",
  reviewEvents.length <= 1,
  `${reviewEvents.length} review events`,
);

if (summary) {
  const body = summary.body;

  // Any gap must be stated in plain text, not implied by absence.
  const gapPhrases = ["were skipped", "were not reviewed", "could not be reviewed", "no obtainable diff", "only partially reviewed"];
  const statesGaps = gapPhrases.some((p) => body.includes(p));
  const expectsGaps = prediction.filtered > 0 || prediction.covered < prediction.reviewable;
  check(
    "skipped/unreviewed files stated in summary",
    !expectsGaps || statesGaps,
    expectsGaps ? (statesGaps ? "gap statement present" : "EXPECTED a gap statement, found none") : "no gaps expected",
  );

  const overflowExpected = inlineComments.length >= MAX_INLINE_COMMENTS;
  check(
    "overflow findings in collapsed section",
    !overflowExpected || body.includes("<details>"),
    overflowExpected ? (body.includes("<details>") ? "<details> present" : "MISSING <details> despite hitting the cap") : "no overflow expected",
  );

  if (scenario.expect.bails) {
    check("bail comment names the override", body.includes("--force"), body.includes("--force") ? "offers --force" : "MISSING --force offer");
    check("bail comment shows real counts", /\|\s*\d+\s*\|/.test(body), "counts table present");
  }
}

// ---- DB side ---------------------------------------------------------------

const client = new MongoClient(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 10_000 });
await client.connect();
const db = client.db(process.env.MONGODB_DB);

const prDoc = await db.collection("pull_requests").findOne({ githubPrNumber: prNumber });
const reviewDocs = prDoc
  ? await db.collection("reviews").find({ pullRequestId: String(prDoc._id) }).sort({ createdAt: 1 }).toArray()
  : [];

check("review record exists in DB", reviewDocs.length > 0, `${reviewDocs.length} review row(s)`);

const latest = reviewDocs[reviewDocs.length - 1];
if (latest) {
  const m = latest.metrics;
  check("metrics recorded", Boolean(m), m ? "present" : "MISSING — pipeline did not reach the metrics write");

  if (m) {
    if (scenario.expect.zeroLlmCalls) {
      check("zero LLM calls", m.calls === 0, `metrics.calls = ${m.calls}`);
      check("zero tokens", m.totalTokens === 0, `metrics.totalTokens = ${m.totalTokens}`);
    } else {
      check("made LLM calls", m.calls > 0, `metrics.calls = ${m.calls}`);
      // The prediction is a floor/ceiling, not an exact figure: the model may
      // submit on round 1 (cheapest) or use its full tool budget.
      const withinPredicted = m.calls >= prediction.typicalCalls - 1 && m.calls <= prediction.worstCalls;
      check(
        "call count within predicted range",
        withinPredicted,
        `actual ${m.calls}, predicted ${prediction.typicalCalls}-${prediction.worstCalls}${withinPredicted ? "" : "  <-- MISMATCH"}`,
      );
      // Tokens: the estimate is deliberately crude (chars/4), so allow 3x.
      const tokenRatio = prediction.expectedTokens === 0 ? 0 : m.totalTokens / prediction.expectedTokens;
      check(
        "token count within 3x of prediction",
        tokenRatio > 0.2 && tokenRatio < 3,
        `actual ${m.totalTokens.toLocaleString()}, predicted ~${prediction.expectedTokens.toLocaleString()} (ratio ${tokenRatio.toFixed(2)})`,
      );
    }

    check("files seen matches prediction", m.filesSeen === prediction.filesSeen, `actual ${m.filesSeen}, predicted ${prediction.filesSeen}`);
    check(
      "comments posted matches GitHub",
      m.commentsPosted === inlineComments.length,
      `metrics ${m.commentsPosted}, GitHub ${inlineComments.length}`,
    );

    const wallClockMs = summary ? new Date(summary.created_at).getTime() - new Date(latest.createdAt).getTime() : -1;
    check(
      "wall clock recorded",
      m.durationMs > 0,
      `pipeline ${(m.durationMs / 1000).toFixed(1)}s; queued-to-comment ${wallClockMs > 0 ? (wallClockMs / 1000).toFixed(1) + "s" : "n/a"}`,
    );
  }

  check(
    "bail-out expectation",
    Boolean(latest.incomplete) === scenario.expect.bails,
    scenario.expect.bails
      ? `expected bail, got ${latest.incomplete?.reason ?? "none"}`
      : `expected review, got ${latest.incomplete?.reason ?? "review"}`,
  );

  if (latest.aiCheckpoint) {
    check("ai checkpoint persisted", true, `${latest.aiCheckpoint.calls} calls checkpointed`);
  }
}

await client.close();

// ---- report ----------------------------------------------------------------

console.log(`\n=== Scenario ${scenario.id} verification — ${repo}#${prNumber} ===`);
console.log(`  ${scenario.title}\n`);
let failed = 0;
for (const c of checks) {
  if (!c.pass) failed++;
  console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name.padEnd(42)} ${c.detail}`);
}
console.log(`\n  ${checks.length - failed}/${checks.length} checks passed`);
for (const note of scenario.expect.notes) console.log(`  MANUAL: ${note}`);
console.log();

process.exit(failed === 0 ? 0 : 1);
