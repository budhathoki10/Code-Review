import "dotenv/config";
import { Queue } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";

const names = ["review", "review-throttle-trailer", "finding-reply"];

async function main() {
  for (const name of names) {
    const q = new Queue(name, { connection: getRedisConnection() });
    const counts = await q.getJobCounts("waiting", "active", "delayed", "failed", "completed", "wait");
    const workers = await q.getWorkers();
    console.log(`\n[${name}] workers=${workers.length} ${workers.map((w) => `${w.name ?? "?"}@${w.addr ?? "?"}`).join(", ")}`);
    console.log(`  counts=${JSON.stringify(counts)}`);
    for (const j of await q.getActive(0, 4)) {
      console.log(`  ACTIVE ${j.id} age=${j.processedOn ? Math.round((Date.now() - j.processedOn) / 1000) : 0}s`);
    }
    for (const j of await q.getFailed(0, 2)) {
      console.log(`  FAILED ${j.id} ${String(j.failedReason).slice(0, 160)}`);
    }
    const done = await q.getCompleted(0, 1);
    if (done[0]?.finishedOn) console.log(`  last completed ${Math.round((Date.now() - done[0].finishedOn) / 1000)}s ago`);
    await q.close();
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
