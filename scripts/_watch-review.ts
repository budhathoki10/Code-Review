import "dotenv/config";
import { Queue } from "bullmq";
import { ObjectId } from "mongodb";
import { getRedisConnection } from "@/lib/queue/connection";
import { reviews } from "@/lib/db/collections";

const reviewId = "6aa8ec5c04ed3a5c21bb34a5";
const jobId = "6aa8ec5c077e24390d1f6f2d-4aa931e7bb758c5794b3648e67ca002a31699ab1";

async function main() {
  const q = new Queue("review", { connection: getRedisConnection() });
  let last = "";
  for (;;) {
    try {
      const workers = (await q.getWorkers()).length;
      const job = await q.getJob(jobId);
      const state = job ? await job.getState() : "gone";
      const r = (await (await reviews()).findOne({ _id: new ObjectId(reviewId) as never })) as any;
      const line = `workers=${workers} job=${state} attempts=${job?.attemptsMade ?? "-"} review=${r?.status} findings=${r?.findings?.length ?? "-"}${job?.failedReason ? ` reason=${String(job.failedReason).slice(0, 160)}` : ""}`;
      if (line !== last) { console.log(line); last = line; }
      if (["completed", "failed"].includes(r?.status) || state === "failed" || state === "gone") break;
    } catch (e) {
      console.log(`poll error: ${String(e).slice(0, 160)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20000));
  }
  await q.close();
}
main().then(() => process.exit(0), (e) => { console.log(String(e).slice(0, 300)); process.exit(1); });
