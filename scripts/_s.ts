import "dotenv/config";
import { getRedisConnection } from "@/lib/queue/connection";
import { Queue } from "bullmq";
import { pullRequests, reviews } from "@/lib/db/collections";
async function main() {
  const q = new Queue("review", { connection: getRedisConnection() });
  for (const j of await q.getActive(0, 3)) {
    console.log(`ACTIVE ${String(j.id).slice(-8)} running ${j.processedOn ? Math.round((Date.now()-j.processedOn)/1000) : 0}s`);
  }
  console.log("queue:", JSON.stringify(await q.getJobCounts("waiting","active","delayed","failed")));
  await q.close();
  const pr = await (await pullRequests()).findOne({ githubPrNumber: 90 });
  const r = await (await reviews()).findOne({ pullRequestId: String(pr!._id) }, { sort: { createdAt: -1 } });
  const age = r ? Math.round((Date.now() - new Date(r.createdAt as never).getTime())/1000) : 0;
  console.log(`review head=${String(r?.headSha).slice(0,7)} status=${r?.status} stage=${r?.stage ?? "-"} age=${age}s`);
}
main().then(()=>process.exit(0),(e)=>{console.error(String(e).slice(0,160));process.exit(1);});
