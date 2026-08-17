import { NextRequest, NextResponse } from "next/server";
import type { PullRequestEvent } from "@octokit/webhooks-types";
import { verifyWebhookSignature } from "@/lib/github/webhook";
import { getPullRequestDiff, MAX_DIFF_FILES, MAX_DIFF_CHARS } from "@/lib/github/diff";
import { generateReview } from "@/lib/ai/review";
import { formatSummaryComment, postSummaryComment } from "@/lib/github/comment";
import { computeCommentableLines, mapFindingsToInlineComments } from "@/lib/github/diff-lines";
import { postInlineReview } from "@/lib/github/inline-comments";
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
  try {
    await reviewsCol.insertOne({
      pullRequestId: String(pullRequestDoc._id),
      headSha,
      status: "pending",
      findings: [],
      createdAt: new Date(),
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      // Same PR + head SHA already has a review (in progress or done) —
      // this is a duplicate webhook delivery. Nothing to do.
      console.log(`[webhook] delivery=${deliveryId} ignoring — duplicate delivery for this head SHA`);
      return ok();
    }
    throw error;
  }
  console.log(`[webhook] delivery=${deliveryId} review row created, fetching diff...`);

  // Everything from here on is best-effort: whatever goes wrong (diff fetch,
  // Claude call, schema validation), the review must end up "failed" with a
  // reason rather than stuck at "pending" forever or crashing the delivery.
  try {
    const diff = await getPullRequestDiff(
      repositoryDoc.githubInstallationId,
      payload.repository.owner.login,
      payload.repository.name,
      payload.number,
    );
    console.log(`[webhook] delivery=${deliveryId} diff fetched — ${diff.fileCount} files, ${diff.diffText.length} chars`);

    if (diff.fileCount > MAX_DIFF_FILES || diff.diffText.length > MAX_DIFF_CHARS) {
      console.log(`[webhook] delivery=${deliveryId} FAILED — diff too large, skipping AI call`);
      await reviewsCol.updateOne(
        { pullRequestId: String(pullRequestDoc._id), headSha },
        {
          $set: {
            status: "failed",
            summary: "PR too large to review automatically.",
          },
        },
      );
      return ok();
    }

    console.log(`[webhook] delivery=${deliveryId} calling the model...`);
    const result = await generateReview(diff.diffText);
    console.log(
      `[webhook] delivery=${deliveryId} COMPLETED — ${result.findings.length} finding(s)`,
    );
    await reviewsCol.updateOne(
      { pullRequestId: String(pullRequestDoc._id), headSha },
      {
        $set: {
          status: "completed",
          verdict: result.verdict,
          summary: result.summary,
          findings: result.findings,
        },
      },
    );

    // Posting to GitHub is intentionally a separate try/catch: the review
    // already generated successfully and is valid in our own dashboard
    // regardless of whether publishing it back to GitHub also succeeds.
    try {
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;

      const commentBody = formatSummaryComment({ summary: result.summary, findings: result.findings });
      const commentId = await postSummaryComment(
        repositoryDoc.githubInstallationId,
        owner,
        repo,
        payload.number,
        commentBody,
      );
      console.log(`[webhook] delivery=${deliveryId} posted summary comment id=${commentId}`);
      await reviewsCol.updateOne(
        { pullRequestId: String(pullRequestDoc._id), headSha },
        { $set: { githubCommentId: commentId } },
      );

      const commentableLines = computeCommentableLines(diff.files);
      const { mappable, unmappable } = mapFindingsToInlineComments(result.findings, commentableLines);
      console.log(
        `[webhook] delivery=${deliveryId} inline mapping — ${mappable.length} mappable, ${unmappable.length} unmappable`,
      );

      if (mappable.length > 0) {
        await postInlineReview(
          repositoryDoc.githubInstallationId,
          owner,
          repo,
          payload.number,
          headSha,
          mappable,
        );
        console.log(`[webhook] delivery=${deliveryId} posted inline review with ${mappable.length} comment(s)`);
      }
    } catch (postError) {
      console.log(`[webhook] delivery=${deliveryId} posting to GitHub FAILED —`, postError);
    }
  } catch (error) {
    console.log(`[webhook] delivery=${deliveryId} FAILED —`, error);
    await reviewsCol.updateOne(
      { pullRequestId: String(pullRequestDoc._id), headSha },
      {
        $set: {
          status: "failed",
          summary: `Review generation failed: ${error instanceof Error ? error.message : "unknown error"}`,
        },
      },
    );
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
