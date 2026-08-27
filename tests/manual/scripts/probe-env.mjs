/**
 * Preflight for the large-PR runbook: proves the pipeline's dependencies are
 * reachable and reports which repositories the GitHub App is actually
 * tracking, before anyone pushes a 100-file test branch at it.
 *
 * Read-only. Prints no secrets.
 *
 *   node tests/manual/scripts/probe-env.mjs
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import Redis from "ioredis";

const REQUIRED = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "MONGODB_URI",
  "MONGODB_DB",
  "REDIS_URL",
  "NVIDIA_API_KEY",
  "NVIDIA_BASE_URL",
];

let ok = true;

console.log("--- credentials ---");
for (const key of REQUIRED) {
  const present = Boolean(process.env[key]);
  if (!present) ok = false;
  console.log(`  ${key.padEnd(24)} ${present ? "set" : "MISSING"}`);
}

console.log("\n--- mongo ---");
try {
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB);
  const repos = await db.collection("repositories").find({}).toArray();
  console.log(`  connected (db: ${process.env.MONGODB_DB})`);
  console.log(`  tracked repositories: ${repos.length}`);
  for (const r of repos) console.log(`    - ${r.fullName}  (installation ${r.githubInstallationId})`);
  console.log(`  reviews: ${await db.collection("reviews").countDocuments()}`);
  console.log(`  pull_requests: ${await db.collection("pull_requests").countDocuments()}`);
  await client.close();
} catch (error) {
  ok = false;
  console.log(`  FAILED — ${error.message.slice(0, 160)}`);
}

console.log("\n--- redis ---");
try {
  const redis = new Redis(process.env.REDIS_URL, {
    connectTimeout: 8000,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  await redis.connect();
  console.log(`  connected (${await redis.ping()})`);
  redis.disconnect();
} catch (error) {
  ok = false;
  console.log(`  FAILED — ${error.message.slice(0, 160)}`);
}

console.log(`\n${ok ? "PREFLIGHT OK" : "PREFLIGHT FAILED"}`);
process.exit(ok ? 0 : 1);
