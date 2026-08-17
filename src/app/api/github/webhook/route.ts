import { NextRequest, NextResponse } from "next/server";
import type { PullRequestEvent } from "@octokit/webhooks-types";
import { verifyWebhookSignature } from "@/lib/github/webhook";
import { enqueueReviewJob } from "@/lib/queue/review-queue";
import { ensureIndexes, pullRequests, repositories, reviews } from "@/lib/db/collections";

function ok() {
  return NextResponse.json({ ok: true }, { status: 200 });
}

export async function POST(request: NextRequest) {
  const deliveryId = request.headers.get("x-github-delivery") ?? "unknown";
  const eventType = request.headers.get("x-github-event") ?? "unknown";
  console.log(`[webhook] received delivery=${deliveryId} event=${eventType}`);

  const rawBody = await request.text();

  if (!verifyWebhookSignature(rawBody, request.headers.get("x-hub-signature-256"))) {
    console.log(`[webhook] delivery=${deliveryId} REJECTED — invalid signature`);
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }
  console.log(`[webhook] delivery=${deliveryId} signature OK`);

  // Every GitHub webhook payload carries a `repository` object regardless of
  // event type, so parse once up front and log which repo it's for before
  // filtering by event type.
  const rawPayload = JSON.parse(rawBody) as { repository?: { full_name?: string } };
  console.log(`[webhook] delivery=${deliveryId} repo=${rawPayload.repository?.full_name ?? "unknown"}`);
// filtering by event type before parsing the payload as a PullRequestEvent, since other event types may not have the same structure and could cause runtime errors if we try to access properties that don't exist.
  if (eventType !== "pull_request") {
    console.log(`[webhook] delivery=${deliveryId} ignoring — not a pull_request event (got "${eventType}")`);
    return ok();
  }

  const payload = rawPayload as unknown as PullRequestEvent;
  console.log(
    `[webhook] delivery=${deliveryId} pull_request action=${payload.action} #${payload.number}`,
  );

  if (payload.action !== "opened" && payload.action !== "synchronize") {
    console.log(`[webhook] delivery=${deliveryId} ignoring — action "${payload.action}" not tracked`);
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
    console.log(
      `[webhook] delivery=${deliveryId} ignoring — repo ${payload.repository.full_name} isn't tracked`,
    );
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
      console.log(`[webhook] delivery=${deliveryId} ignoring — duplicate delivery for this head SHA`);
      return ok();
    }
    throw error;
  }
  console.log(`[webhook] delivery=${deliveryId} review row created, enqueuing job...`);

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
    });
    console.log(`[webhook] delivery=${deliveryId} job enqueued`);
  } catch (error) {
    console.log(`[webhook] delivery=${deliveryId} FAILED to enqueue —`, error);
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

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === 11000
  );
}
