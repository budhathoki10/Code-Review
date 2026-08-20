import { NextRequest, NextResponse } from "next/server";
import type { InstallationEvent, InstallationRepositoriesEvent, PullRequestEvent } from "@octokit/webhooks-types";
import { verifyWebhookSignature } from "@/lib/github/webhook";
import { enqueueReviewJob } from "@/lib/queue/review-queue";
import { ensureIndexes, installations, pullRequests, repositories, reviews } from "@/lib/db/collections";
import { getRedisConnection } from "@/lib/queue/connection";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import type pino from "pino";

const WEBHOOK_RATE_LIMIT_MAX = Number(process.env.WEBHOOK_RATE_LIMIT_MAX ?? 20);
const WEBHOOK_RATE_LIMIT_WINDOW_SECONDS = Number(process.env.WEBHOOK_RATE_LIMIT_WINDOW_SECONDS ?? 60);

function ok() {
  return NextResponse.json({ ok: true }, { status: 200 });
}

export async function POST(request: NextRequest) {
  const deliveryId = request.headers.get("x-github-delivery") ?? "unknown";
  const eventType = request.headers.get("x-github-event") ?? "unknown";
  const log = logger.child({ requestId: deliveryId });
  log.info({ eventType }, "webhook received");

  const rawBody = await request.text();

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

  if (eventType === "installation") {
    await handleInstallationEvent(rawPayload as unknown as InstallationEvent, log);
    return ok();
  }

  if (eventType === "installation_repositories") {
    await handleInstallationRepositoriesEvent(rawPayload as unknown as InstallationRepositoriesEvent, log);
    return ok();
  }

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
  const pullRequestDoc = await pullRequestsCol.findOneAndUpdate(
    { githubPrId: payload.pull_request.id },
    {
      $set: {
        repositoryId: String(repositoryDoc._id),
        githubPrNumber: payload.number,
        title: payload.pull_request.title,
        headSha,
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  if (!pullRequestDoc?._id) {
    throw new Error(`Failed to upsert pull request ${payload.pull_request.id}`);
  }

  const reviewsCol = await reviews();
  let reviewId: string;
  try {
    const insertResult = await reviewsCol.insertOne({
      pullRequestId: String(pullRequestDoc._id),
      headSha,
      status: "pending",
      findings: [],
      createdAt: new Date(),
    });
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
      pullRequestId: String(pullRequestDoc._id),
      headSha,
      githubInstallationId: repositoryDoc.githubInstallationId,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      prNumber: payload.number,
      requestId: deliveryId,
    });
    log.info({ reviewId }, "job enqueued");
  } catch (error) {
    log.error({ reviewId, err: error }, "failed to enqueue review job");
    await reviewsCol.updateOne(
      { pullRequestId: String(pullRequestDoc._id), headSha },
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

/**
 * Keeps our DB in sync when a user uninstalls the GitHub App entirely.
 * Without this, a revoked installation leaves its repositories (and the
 * installation row itself) behind forever — they just silently stop
 * receiving webhooks while still showing up in the dashboard.
 */
async function handleInstallationEvent(payload: InstallationEvent, log: pino.Logger) {
  if (payload.action !== "deleted") {
    log.info({ action: payload.action }, "installation event ignored — action not tracked");
    return;
  }

  await ensureIndexes();

  const installationsCol = await installations();
  const installationDoc = await installationsCol.findOneAndDelete({
    githubInstallationId: payload.installation.id,
  });
  if (!installationDoc?._id) {
    log.info({ githubInstallationId: payload.installation.id }, "installation deleted — no matching installation on file");
    return;
  }

  const repositoriesCol = await repositories();
  const { deletedCount } = await repositoriesCol.deleteMany({
    installationId: String(installationDoc._id),
  });
  log.info(
    { githubInstallationId: payload.installation.id, reposRemoved: deletedCount },
    "installation uninstalled — installation and repositories removed",
  );
}

/**
 * Keeps the tracked repo list in sync when a user adds/removes individual
 * repos from an existing installation, without uninstalling the whole app.
 */
async function handleInstallationRepositoriesEvent(payload: InstallationRepositoriesEvent, log: pino.Logger) {
  await ensureIndexes();

  const repositoriesCol = await repositories();

  if (payload.repositories_removed.length > 0) {
    const { deletedCount } = await repositoriesCol.deleteMany({
      githubRepoId: { $in: payload.repositories_removed.map((repo) => repo.id) },
    });
    log.info({ githubInstallationId: payload.installation.id, deletedCount }, "repositories removed from installation");
  }

  if (payload.repositories_added.length > 0) {
    const installationsCol = await installations();
    const installationDoc = await installationsCol.findOne({
      githubInstallationId: payload.installation.id,
    });
    if (!installationDoc?._id) {
      log.warn({ githubInstallationId: payload.installation.id }, "repositories added — no matching installation on file");
      return;
    }

    await Promise.all(
      payload.repositories_added.map((repo) =>
        repositoriesCol.updateOne(
          { githubRepoId: repo.id },
          {
            $set: {
              installationId: String(installationDoc._id),
              githubInstallationId: payload.installation.id,
              fullName: repo.full_name,
            },
          },
          { upsert: true },
        ),
      ),
    );
    log.info(
      { githubInstallationId: payload.installation.id, added: payload.repositories_added.length },
      "repositories added to installation",
    );
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === 11000
  );
}
