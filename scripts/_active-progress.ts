import "dotenv/config";
import { Queue } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { reviews, pullRequests } from "@/lib/db/collections";

async function main() {
  const q = new Queue("review", { connection: getRedisConnection() });
  for (const j of await q.getActive(0, 9)) {
    console.log(`JOB ${j.id} attempts=${j.attemptsMade} age=${Math.round((Date.now() - (j.processedOn ?? Date.now())) / 1000)}s data=${JSON.stringify(j.data).slice(0, 200)}`);
  }
  await q.close();
  const rs = await (await reviews()).find({}, { sort: { createdAt: -1 }, limit: 6 }).toArray();
  for (const r of rs as any[]) {
    const pr = await (await pullRequests()).findOne({ _id: r.pullRequestId as never }).catch(() => null);
    console.log(`review ${String(r._id).slice(-8)} pr#${(pr as any)?.githubPrNumber ?? "?"} head=${String(r.headSha).slice(0,7)} status=${r.status} stage=${r.stage ?? "-"} created=${Math.round((Date.now()-new Date(r.createdAt).getTime())/1000)}s ago updated=${r.updatedAt ? Math.round((Date.now()-new Date(r.updatedAt).getTime())/1000)+"s ago" : "-"} findings=${r.findings?.length ?? "-"}`);
  }
}
main().then(() => process.exit(0), (e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
