// this file is the heart of the project
import { NextRequest, NextResponse } from "next/server";
import type { PullRequestEvent } from "@octokit/webhooks-types";
import { verifyWebhookSignature } from "@/lib/github/webhook";
import { enqueueReviewJob } from "@/lib/queue/review-queue";
import { claimThrottleWindow, throttleWindowRemainingMs } from "@/lib/queue/pr-throttle";
import { scheduleThrottleTrailer } from "@/lib/queue/throttle-queue";
import { ensureIndexes, pullRequests, repositories, reviews } from "@/lib/db/collections";
import { getRedisConnection } from "@/lib/queue/connection";
import { checkRateLimit } from "@/lib/rate-limit";
import { isDuplicateKeyError } from "@/lib/db/mongo-errors";
import { logger } from "@/lib/logger";

const WEBHOOK_RATE_LIMIT_MAX = Number(process.env.WEBHOOK_RATE_LIMIT_MAX ?? 20);
const WEBHOOK_RATE_LIMIT_WINDOW_SECONDS = Number(process.env.WEBHOOK_RATE_LIMIT_WINDOW_SECONDS ?? 60);

/**
 * At most one review is triggered per PR per window — a burst of pushes
 * (e.g. someone force-pushing fixups repeatedly) debounces to a single
 * review of whichever commit is HEAD once the window ends, instead of one
 * AI review per commit. See pr-throttle.ts / throttle-queue.ts.
 */
const PR_REVIEW_THROTTLE_WINDOW_MS = Number(process.env.PR_REVIEW_THROTTLE_WINDOW_MS ?? 60_000);

function ok() {
  return NextResponse.json({ ok: true }, { status: 200 });
}

export async function POST(request: NextRequest) {
  // verifying the signature 
  const deliveryId = request.headers.get("x-github-delivery") ?? "unknown";
  const eventType = request.headers.get("x-github-event") ?? "unknown";
  const log = logger.child({ requestId: deliveryId });
  log.info({ eventType }, "webhook received");

  const rawBody = await request.text();
// checking the signature if webhook is really from the github or not 
  if (!verifyWebhookSignature(rawBody, request.headers.get("x-hub-signature-256"))) {
    log.warn("webhook rejected — invalid signature");
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }
  log.info("webhook signature OK");

  // Every GitHub webhook payload carries a `repository` object regardless of
  // event type, so parse once up front and log which repo it's for before
  // filtering by event type.
  const rawPayload = JSON.parse(rawBody) as { repository?: { id?: number; full_name?: string } };
  log.info({ repo: rawPayload.repository?.full_name ?? "unknown" }, "webhook payload parsed");

  if (rawPayload.repository?.id !== undefined) {
    const rateLimitKey = `ratelimit:webhook:${rawPayload.repository.id}`;
    const withinLimit = await checkRateLimit(
      getRedisConnection(),
      rateLimitKey,
      WEBHOOK_RATE_LIMIT_MAX,
      WEBHOOK_RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!withinLimit) {
      log.warn({ repo: rawPayload.repository.full_name }, "webhook rate limit exceeded");
      return NextResponse.json(
        { error: "rate limit exceeded" },
        { status: 429, headers: { "Retry-After": String(WEBHOOK_RATE_LIMIT_WINDOW_SECONDS) } },
      );
    }
  }

  //only cares about the pull request
  if (eventType !== "pull_request") {
    log.info({ eventType }, "webhook ignored — not a pull_request event");
    return ok();
  }

  const payload = rawPayload as unknown as PullRequestEvent;
  log.info({ action: payload.action, prNumber: payload.number }, "pull_request event");

  if (payload.action !== "opened" && payload.action !== "synchronize") {
    log.info({ action: payload.action }, "webhook ignored — action not tracked");
    return ok();
  }

  await ensureIndexes();

  const repositoriesCol = await repositories();
  const repositoryDoc = await repositoriesCol.findOne({
    githubRepoId: payload.repository.id,
  });
  if (!repositoryDoc?._id) {
    // App installed, but this repo isn't one we're tracking — shouldn't
    // normally happen, but don't fail the delivery over it.
    log.info({ repo: payload.repository.full_name }, "webhook ignored — repo isn't tracked");
    return ok();
  }

  const headSha = payload.pull_request.head.sha;

  const pullRequestsCol = await pullRequests();
  //saves the meta data of the github webhook
  const pullRequestDoc = await pullRequestsCol.findOneAndUpdate(
    { githubPrId: payload.pull_request.id },
    {
      $set: {
        repositoryId: String(repositoryDoc._id),
        githubPrNumber: payload.number,
        title: payload.pull_request.title,
        headSha,
        // Kept current on every push so a throttle-debounced trailing
        // review (see throttle-worker-factory.ts) still has PR context —
        // that job runs later, off the webhook payload's timeline.
        body: payload.pull_request.body,
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  if (!pullRequestDoc?._id) {
    throw new Error(`Failed to upsert pull request ${payload.pull_request.id}`);
  }
  const pullRequestId = String(pullRequestDoc._id);

  // At most one review triggered per PR per PR_REVIEW_THROTTLE_WINDOW_MS.
  // A push landing inside an already-open window is debounced: it doesn't
  // get its own review, but a trailing job (fixed jobId per PR, so a burst
  // of pushes only schedules it once) reviews whatever's HEAD once the
  // window ends.
  const redis = getRedisConnection();
  const allowedNow = await claimThrottleWindow(redis, pullRequestId, PR_REVIEW_THROTTLE_WINDOW_MS);
  if (!allowedNow) {
    const remainingMs = await throttleWindowRemainingMs(redis, pullRequestId);
    await scheduleThrottleTrailer({ pullRequestId, requestId: deliveryId }, remainingMs);
    log.info({ prNumber: payload.number, remainingMs }, "webhook throttled — trailing review scheduled");
    return ok();
  }

  const reviewsCol = await reviews();
  let reviewId: string;
  try {
    // creates the pending status of the pr 
    const insertResult = await reviewsCol.insertOne({
      pullRequestId,
      headSha,
      status: "pending",
      findings: [],
      createdAt: new Date(),
    });
    //  extract the object of the document 
    reviewId = String(insertResult.insertedId);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      // Same PR + head SHA already has a review (in progress or done) —
      // this is a duplicate webhook delivery. Nothing to do.
      log.info("webhook ignored — duplicate delivery for this head SHA");
      return ok();
    }
    throw error;
  }
  log.info({ reviewId }, "review row created, enqueuing job");

  // The AI/GitHub work (fetch diff → AI → post comment → inline comments)
  // runs in the BullMQ worker, not here — this handler only needs to get a
  // job on the queue and respond, regardless of how long the review takes.
  try {
    await enqueueReviewJob({
      reviewId,
      pullRequestId,
      headSha,
      githubInstallationId: repositoryDoc.githubInstallationId,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      prNumber: payload.number,
      requestId: deliveryId,
      prTitle: payload.pull_request.title,
      prBody: payload.pull_request.body,
    });
    log.info({ reviewId }, "job enqueued");
  } catch (error) {
    log.error({ reviewId, err: error }, "failed to enqueue review job");
    await reviewsCol.updateOne(
      { pullRequestId, headSha },
      {
        $set: {
          status: "failed",
          summary: `Failed to enqueue review job: ${error instanceof Error ? error.message : "unknown error"}`,
        },
      },
    );
    return NextResponse.json({ error: "failed to enqueue review job" }, { status: 500 });
  }

  return ok();
}
