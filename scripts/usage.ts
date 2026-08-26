import "dotenv/config";
import { getUsageSummary } from "@/lib/db/usage";
import getMongoClient from "@/lib/mongodb";

/**
 * One-off check of app-wide AI token consumption: `npm run usage`.
 * Reads the single shared counter every review accumulates into — see
 * src/lib/db/usage.ts.
 */
async function main() {
  const summary = await getUsageSummary();

  if (!summary) {
    console.log("No AI usage recorded yet.");
    return;
  }

  const { inputTokens, outputTokens, totalTokens, calls, reviews, updatedAt } = summary;
  const n = (value: number) => value.toLocaleString("en-US");

  console.log("AI token usage (all users, all time)");
  console.log("------------------------------------");
  console.log(`  Input tokens  : ${n(inputTokens)}`);
  console.log(`  Output tokens : ${n(outputTokens)}`);
  console.log(`  Total tokens  : ${n(totalTokens)}`);
  console.log(`  Provider calls: ${n(calls)}`);
  console.log(`  Reviews       : ${n(reviews)}`);
  if (reviews > 0) {
    console.log(`  Avg per review: ${n(Math.round(totalTokens / reviews))} tokens, ${(calls / reviews).toFixed(1)} calls`);
  }
  console.log(`  Last updated  : ${updatedAt.toISOString()}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // The shared client is a module-level singleton (see lib/mongodb.ts), so a
    // short-lived script has to close it explicitly or the process hangs.
    await (await getMongoClient()).close();
  });
