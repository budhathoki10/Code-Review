import "dotenv/config";
import { createServer } from "http";
import { createReviewWorker, AI_RATE_LIMIT_MAX, AI_RATE_LIMIT_DURATION_MS } from "@/lib/queue/review-worker-factory";
import { logger } from "@/lib/logger";

// npm run worker......it creates a worker from review factory and wait for the job
const worker = createReviewWorker();

logger.info(
  { concurrency: 5, aiRateLimit: `${AI_RATE_LIMIT_MAX}/${AI_RATE_LIMIT_DURATION_MS}ms` },
  "review worker started, waiting for jobs...",
);

/**
 * Render (and similar "web service" hosts) sleep a free-tier instance after
 * a period with no inbound HTTP traffic — that's unrelated to job
 * processing, which the BullMQ worker above already handles continuously
 * and independently in the background regardless of HTTP activity. This
 * server exists only so an external pinger (e.g. cron-job.org hitting it
 * once a minute) keeps the host classified as active. Only starts when
 * PORT is set, which Render injects automatically — `npm run worker`
 * locally (no PORT set) is unaffected and behaves exactly as before.
 */
if (process.env.PORT) {
  const port = Number(process.env.PORT);
  createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }).listen(port, () => {
    logger.info({ port }, "keep-awake health server listening (unrelated to job processing)");
  });
}

/**
 * Render sends SIGTERM before restarting/redeploying an instance. Closing
 * the worker lets BullMQ finish or cleanly release the job it's holding
 * instead of the process vanishing mid-job and leaving an unrenewed lock
 * behind — the same "stalled job" failure mode this whole setup exists to
 * avoid.
 */
async function shutdown(signal: NodeJS.Signals) {
  logger.info({ signal }, "review worker shutting down");
  await worker.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
