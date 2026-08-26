import { NextRequest, NextResponse } from "next/server";
import type { Worker } from "bullmq";
import { createReviewWorker } from "@/lib/queue/review-worker-factory";
import { createThrottleTrailerWorker } from "@/lib/queue/throttle-worker-factory";
import { logger } from "@/lib/logger";

/**
 * Netlify (and most external cron pingers) can't hold a process open, so
 * unlike src/worker/review-worker.ts — which starts once and waits on the
 * queue forever — this route starts a worker, drains whatever's currently
 * queued, and exits. Call it on a schedule (e.g. every minute); BullMQ's
 * per-job locking means overlapping invocations won't double-process a job.
 */
const MAX_DURATION_MS = Number(process.env.CRON_MAX_DURATION_MS ?? 25_000);

interface SweepCounts {
  completed: number;
  failed: number;
}

/**
 * Runs one worker until its queue drains or `maxDurationMs` elapses,
 * whichever comes first, then closes it. A queue holding only jobs still
 * delayed (e.g. throttle trailers waiting out their window — see
 * pr-throttle.ts) drains immediately with nothing processed; those become
 * due and get picked up by a later invocation, same as any backlog bigger
 * than fits in one sweep.
 */
async function sweep(worker: Worker, maxDurationMs: number): Promise<SweepCounts> {
  const counts: SweepCounts = { completed: 0, failed: 0 };
  worker.on("completed", () => counts.completed++);
  worker.on("failed", () => counts.failed++);

  const runPromise = worker.run();

  await Promise.race([
    new Promise<void>((resolve) => worker.once("drained", resolve)),
    new Promise<void>((resolve) => setTimeout(() => resolve(), maxDurationMs)),
  ]);

  // Waits for any job currently in flight to finish rather than killing it
  // mid-run — see BullMQ's Worker#close semantics.
  await worker.close();
  await runPromise.catch((err) => logger.error({ err }, "worker run loop errored"));

  return counts;
}

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    logger.error("cron sweep rejected — CRON_SECRET is not configured please test it ");
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const reviewWorker = createReviewWorker({ autorun: false });
  const throttleTrailerWorker = createThrottleTrailerWorker({ autorun: false });

  const [review, throttleTrailer] = await Promise.all([
    sweep(reviewWorker, MAX_DURATION_MS),
    sweep(throttleTrailerWorker, MAX_DURATION_MS),
  ]);

  logger.info({ review, throttleTrailer }, "cron review sweep finished");
  return NextResponse.json({ ok: true, review, throttleTrailer });
}
