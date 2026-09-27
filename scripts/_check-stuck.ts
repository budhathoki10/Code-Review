import "dotenv/config";
import { Queue } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { reviews, pullRequests } from "@/lib/db/collections";

async function main() {
  const q = new Queue("review", { connection: getRedisConnection() });
  const rs = await (await reviews()).find({ status: "pending" }, { sort: { createdAt: -1 } }).toArray();
  for (const r of rs as any[]) {
    const pr = await (await pullRequests()).findOne({ _id: r.pullRequestId as never }).catch(() => null);
    const jobId = `${r.pullRequestId}-${r.headSha}`;
    const job = await q.getJob(jobId);
    const state = job ? await job.getState() : "gone";
    console.log(`review ${String(r._id).slice(-8)} pr#${(pr as any)?.githubPrNumber ?? "?"} head=${String(r.headSha).slice(0,7)} created=${Math.round((Date.now()-new Date(r.createdAt).getTime())/60000)}min ago checkRunId=${r.checkRunId ?? "-"} coverageComplete=${r.coverageComplete} jobState=${state} attemptsMade=${job?.attemptsMade ?? "-"}`);
  }
  await q.close();
}
main().then(()=>process.exit(0),(e)=>{console.error(String(e).slice(0,300));process.exit(1);});
