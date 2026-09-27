import "dotenv/config";
import { Queue } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
async function main() {
  const q = new Queue("finding-reply", { connection: getRedisConnection() });
  for (const j of await q.getFailed(0, 3)) {
    console.log(`${j.id} failedAt=${j.finishedOn ? new Date(j.finishedOn).toISOString() : "?"} ago=${j.finishedOn ? Math.round((Date.now()-j.finishedOn)/3600000)+"h" : "?"} attempts=${j.attemptsMade} reason=${String(j.failedReason).slice(0,200)}`);
  }
  await q.close();
}
main().then(()=>process.exit(0),(e)=>{console.error(String(e).slice(0,200));process.exit(1);});
