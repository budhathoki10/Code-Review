import "dotenv/config";
import { createServer } from "http";
import { createReviewWorker, AI_RATE_LIMIT_MAX, AI_RATE_LIMIT_DURATION_MS } from "@/lib/queue/review-worker-factory";
import { createThrottleTrailerWorker } from "@/lib/queue/throttle-worker-factory";
import { createReplyWorker } from "@/lib/queue/reply-worker-factory";
import { getReviewQueue } from "@/lib/queue/review-queue";
import { reconcileOrphanedReviews } from "@/lib/review/reconcile-orphaned";
import { logger } from "@/lib/logger";

// npm run worker......it creates a worker from review factory and wait for the job
const worker = createReviewWorker();

// Handles pushes debounced by the per-PR throttle window (see
// pr-throttle.ts) — reviews whatever's HEAD once the window ends.
const throttleTrailerWorker = createThrottleTrailerWorker();

// Answers developers' replies to a finding's inline comment. Its own queue
// and limiter (see reply-worker-factory.ts), same process — a reply is one
// provider call and must not queue behind a full review.
const replyWorker = createReplyWorker();

logger.info(
  { concurrency: 5, aiRateLimit: `${AI_RATE_LIMIT_MAX}/${AI_RATE_LIMIT_DURATION_MS}ms` },
  "review worker started, waiting for jobs...",
);

/**
 * Closes out reviews left `pending` forever by a job that vanished from the
 * queue without ever reaching this worker's own "failed" handler — see
 * reconcile-orphaned.ts. Runs here too, not just from the cron sweep,
 * because this long-running process is the primary path (the cron route is
 * a Netlify fallback) and a review can be orphaned by this very process
 * dying, so nothing else is guaranteed to run the sweep.
 */
const RECONCILE_INTERVAL_MS = Number(process.env.REVIEW_RECONCILE_INTERVAL_MS ?? 5 * 60_000);
const reconcileTimer = setInterval(() => {
  reconcileOrphanedReviews(getReviewQueue())
    .then(({ reconciled }) => {
      if (reconciled > 0) logger.warn({ reconciled }, "orphaned-review sweep closed out stuck reviews");
    })
    .catch((err) => logger.error({ err }, "orphaned-review sweep failed"));
}, RECONCILE_INTERVAL_MS);
reconcileTimer.unref();

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
  await Promise.all([worker.close(), throttleTrailerWorker.close(), replyWorker.close()]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
