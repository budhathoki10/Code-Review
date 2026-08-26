import { NextRequest, NextResponse } from "next/server";
import { createReviewWorker } from "@/lib/queue/review-worker-factory";
import { logger } from "@/lib/logger";

/**
 * Netlify (and most external cron pingers) can't hold a process open, so
 * unlike src/worker/review-worker.ts — which starts once and waits on the
 * queue forever — this route starts a worker, drains whatever's currently
 * queued, and exits. Call it on a schedule (e.g. every minute); BullMQ's
 * per-job locking means overlapping invocations won't double-process a job.
 */
const MAX_DURATION_MS = Number(process.env.CRON_MAX_DURATION_MS ?? 25_000);

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    logger.error("cron sweep rejected — CRON_SECRET is not configured please test it ");
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const worker = createReviewWorker({ autorun: false });

  let completed = 0;
  let failed = 0;
  worker.on("completed", () => completed++);
  worker.on("failed", () => failed++);

  const runPromise = worker.run();

  // "drained" fires once the queue has no more waiting jobs — that's the
  // normal exit. The timeout is a backstop for a backlog bigger than fits
  // in one invocation; whatever's left over gets picked up next tick.
  await Promise.race([
    new Promise<void>((resolve) => worker.once("drained", resolve)),
    new Promise<void>((resolve) => setTimeout(() => resolve(), MAX_DURATION_MS)),
  ]);

  // Waits for any job currently in flight to finish rather than killing it
  // mid-run — see BullMQ's Worker#close semantics.
  await worker.close();
  await runPromise.catch((err) => logger.error({ err }, "worker run loop errored"));

  logger.info({ completed, failed }, "cron review sweep finished");
  return NextResponse.json({ ok: true, completed, failed });
}
