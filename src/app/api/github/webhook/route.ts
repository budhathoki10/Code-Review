// this file is the heart of the project
import { NextRequest, NextResponse } from "next/server";
import type {
  PullRequestEvent,
  IssueCommentEvent,
  PullRequestReviewCommentEvent,
} from "@octokit/webhooks-types";
import type { Logger } from "pino";
import type { WithId } from "mongodb";
import { isForceCommand } from "@/lib/review/gate";
import { verifyWebhookSignature } from "@/lib/github/webhook";
import { isTrustedCommenter } from "@/lib/github/commenter";
import { enqueueReviewJob } from "@/lib/queue/review-queue";
import { enqueueReplyJob } from "@/lib/queue/reply-queue";
import { claimThrottleWindow, throttleWindowRemainingMs } from "@/lib/queue/pr-throttle";
import { scheduleThrottleTrailer } from "@/lib/queue/throttle-queue";
import { ensureIndexes, installations, pullRequests, repositories, reviews, type RepositoryDoc } from "@/lib/db/collections";
import { getRedisConnection } from "@/lib/queue/connection";
import { checkRateLimit } from "@/lib/rate-limit";
import { isDuplicateKeyError } from "@/lib/db/mongo-errors";
import { logger } from "@/lib/logger";

/**
 * Deliveries accepted per repository per window, across EVERY event type —
 * the key is the repo id alone, so pushes, PR opens, comment replies and
 * force-command comments all draw on one budget. Exceeding it returns 429
 * and the event is dropped, not queued.
 *
 * 2 (the previous default) was far too tight for that shared budget: opening
 * a PR and pushing once to it already spends both, and a developer replying
 * to two findings exhausts it on its own. Matched to the 20 that
 * .env.example has always documented.
 */
const WEBHOOK_RATE_LIMIT_MAX = Number(process.env.WEBHOOK_RATE_LIMIT_MAX ?? 20);
const WEBHOOK_RATE_LIMIT_WINDOW_SECONDS = Number(process.env.WEBHOOK_RATE_LIMIT_WINDOW_SECONDS ?? 60);

/**
 * At most one review is triggered per PR per window — a burst of pushes
 * (e.g. someone force-pushing fixups repeatedly) debounces to a single
 * review of whichever commit is HEAD once the window ends, instead of one
 * AI review per commit. See pr-throttle.ts / throttle-queue.ts.
 */
const PR_REVIEW_THROTTLE_WINDOW_MS = Number(process.env.PR_REVIEW_THROTTLE_WINDOW_MS ?? 60_000);

/**
 * Questions ACCEPTED per PR per window, at the webhook door. Generous enough
 * for a real back-and-forth, low enough that a comment flood on one PR can't
 * run up an unbounded provider bill.
 *
 * Distinct from the reply worker's BullMQ limiter (REPLY_WORKER_RATE_LIMIT_*),
 * which bounds how fast accepted jobs are *drained*. The two used to share the
 * name REPLY_RATE_LIMIT_MAX while carrying different defaults (10 here, 20
 * there), so setting it moved both knobs at once and neither to the value the
 * operator saw documented. The old names are still read as a fallback so an
 * existing deployment keeps working.
 */
const REPLY_ACCEPT_RATE_LIMIT_MAX = Number(
  process.env.REPLY_ACCEPT_RATE_LIMIT_MAX ?? process.env.REPLY_RATE_LIMIT_MAX ?? 10,
);
const REPLY_ACCEPT_RATE_LIMIT_WINDOW_SECONDS = Number(
  process.env.REPLY_ACCEPT_RATE_LIMIT_WINDOW_SECONDS ?? process.env.REPLY_RATE_LIMIT_WINDOW_SECONDS ?? 600,
);

function ok() {
  return NextResponse.json({ ok: true }, { status: 200 });
}

/**
 * Handles `@prsentry review --force` on a pull request.
 *
 * Only PR comments count — `issue_comment` fires for plain issues too, and a
 * comment on an issue has no diff to review. The forced review reuses the
 * whole normal path; the only difference is the `forced` flag, which makes
 * the pipeline skip the size gate and the cheap-triage filter.
 *
 * A forced review deliberately bypasses the per-PR throttle window: it is an
 * explicit human request, not an automatic reaction to a push, and making
 * someone wait out a debounce they didn't trigger would read as the command
 * being ignored.
 */
async function handleForceCommand(payload: IssueCommentEvent, deliveryId: string, log: Logger) {
  if (payload.action !== "created" || !payload.issue?.pull_request) {
    log.info("issue_comment ignored — not a new comment on a pull request");
    return ok();
  }
  if (!isForceCommand(payload.comment?.body)) {
    return ok();
  }

  // Authorization. The webhook signature proves the payload came from GitHub,
  // not that this commenter may spend our tokens: on a public repo any account
  // can comment on any PR. A forced review bypasses the throttle, the size
  // gate and the triage filter (up to ~65 provider calls) and deletes the
  // stored review row for the current head, so it has to be limited to people
  // with a real relationship to the repo — plus the PR's own author, who is
  // the person most likely to want their oversized PR reviewed anyway.
  const association = payload.comment?.author_association;
  if (!isTrustedCommenter(association, payload.comment?.user?.login, payload.issue?.user?.login)) {
    log.info(
      { association, actor: payload.comment?.user?.login, prNumber: payload.issue.number },
      "force review ignored — commenter is not a maintainer or the PR author",
    );
    return ok();
  }

  log.info({ prNumber: payload.issue.number, association }, "force review command received");
  await ensureIndexes();

  const repositoriesCol = await repositories();
  const repositoryDoc = await repositoriesCol.findOne({ githubRepoId: payload.repository.id });
  if (!repositoryDoc?._id) {
    log.info("force review ignored — repo isn't tracked");
    return ok();
  }

  const pullRequestsCol = await pullRequests();
  const pullRequestDoc = await pullRequestsCol.findOne({
    repositoryId: String(repositoryDoc._id),
    githubPrNumber: payload.issue.number,
  });
  if (!pullRequestDoc?._id) {
    log.info("force review ignored — no tracked pull request for this comment");
    return ok();
  }

  const pullRequestId = String(pullRequestDoc._id);
  const headSha = pullRequestDoc.headSha;

  // The (pullRequestId, headSha) unique index means a forced review of a
  // commit that already has a review row would be rejected. Delete that row
  // first: forcing is an explicit request to redo the work, so the previous
  // (bailed-out) result for this exact commit is what's being replaced.
  const reviewsCol = await reviews();
  await reviewsCol.deleteOne({ pullRequestId, headSha });

  const insertResult = await reviewsCol.insertOne({
    pullRequestId,
    headSha,
    status: "pending",
    findings: [],
    createdAt: new Date(),
  });

  await enqueueReviewJob({
    reviewId: String(insertResult.insertedId),
    pullRequestId,
    headSha,
    githubInstallationId: repositoryDoc.githubInstallationId,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    prNumber: payload.issue.number,
    requestId: deliveryId,
    prTitle: pullRequestDoc.title,
    prBody: pullRequestDoc.body,
    forced: true,
  });
  log.info({ pullRequestId, headSha }, "forced review enqueued");

  return ok();
}

/**
 * Handles a developer replying to one of the bot's inline finding comments.
 *
 * Only threaded replies count. A brand-new review comment (no
 * `in_reply_to_id`) isn't addressed to us and has no finding to answer about;
 * GitHub flattens threads, so even a reply three deep carries the ROOT
 * comment's id here, which is exactly the id stored on the finding.
 *
 * The work itself is queued rather than done inline: a provider call takes
 * far longer than GitHub's webhook timeout, so answering here would time out
 * the delivery and get it retried.
 */
async function handleFindingReply(
  payload: PullRequestReviewCommentEvent,
  deliveryId: string,
  log: Logger,
) {
  if (payload.action !== "created") {
    return ok();
  }

  const comment = payload.comment;
  const rootCommentId = comment?.in_reply_to_id;
  if (!rootCommentId) {
    log.info("review comment ignored — not a reply to an existing thread");
    return ok();
  }

  // Never answer a bot, our own replies most of all: our reply fires this
  // same event, so without this the bot answers itself forever. Excluding
  // every bot (not just ours) also keeps us out of loops with other review
  // bots installed on the same repo.
  if (comment.user?.type === "Bot") {
    log.info({ actor: comment.user?.login }, "review comment ignored — author is a bot");
    return ok();
  }

  if (!isTrustedCommenter(comment.author_association, comment.user?.login, payload.pull_request?.user?.login)) {
    log.info(
      { association: comment.author_association, actor: comment.user?.login },
      "reply ignored — commenter is not a maintainer or the PR author",
    );
    return ok();
  }

  await ensureIndexes();

  const repositoriesCol = await repositories();
  const repositoryDoc = await repositoriesCol.findOne({ githubRepoId: payload.repository.id });
  if (!repositoryDoc?._id) {
    log.info("reply ignored — repo isn't tracked");
    return ok();
  }

  const pullRequestsCol = await pullRequests();
  const pullRequestDoc = await pullRequestsCol.findOne({
    repositoryId: String(repositoryDoc._id),
    githubPrNumber: payload.pull_request.number,
  });
  if (!pullRequestDoc?._id) {
    log.info("reply ignored — no tracked pull request for this comment");
    return ok();
  }

  // Bounds how many questions one PR can turn into provider calls. Separate
  // from the per-repo webhook limiter above, which counts all traffic
  // including ordinary pushes and would let a comment flood hide inside it.
  const withinLimit = await checkRateLimit(
    getRedisConnection(),
    `ratelimit:reply:${payload.repository.id}:${payload.pull_request.number}`,
    REPLY_ACCEPT_RATE_LIMIT_MAX,
    REPLY_ACCEPT_RATE_LIMIT_WINDOW_SECONDS,
  );
  if (!withinLimit) {
    log.warn({ prNumber: payload.pull_request.number }, "reply rate limit exceeded — dropping");
    return ok();
  }

  await enqueueReplyJob({
    githubInstallationId: repositoryDoc.githubInstallationId,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    prNumber: payload.pull_request.number,
    pullRequestId: String(pullRequestDoc._id),
    rootCommentId,
    triggerCommentId: comment.id,
    requestId: deliveryId,
  });
  log.info({ rootCommentId, triggerCommentId: comment.id }, "reply enqueued");

  return ok();
}

/**
 * Adds a repository we've never seen to the tracked list, using the
 * installation the delivery itself names.
 *
 * Only ever called for a repo that isn't tracked yet (see the pull_request
 * handler). Requires the installation to already exist locally — someone
 * completed /api/github/setup for it — so an unknown installation is
 * declined rather than created here, where there is no session to attribute
 * it to. Returns null in that case, and the caller drops the delivery
 * exactly as it did before.
 *
 * The upsert is keyed on `githubRepoId` rather than the name so a renamed or
 * transferred repo updates its row instead of gaining a second one.
 */
async function registerRepositoryFromEvent(
  payload: PullRequestEvent,
  log: Logger,
): Promise<WithId<RepositoryDoc> | null> {
  const githubInstallationId = payload.installation?.id;
  if (githubInstallationId === undefined) {
    log.info({ repo: payload.repository.full_name }, "webhook ignored — repo isn't tracked and event names no installation");
    return null;
  }

  const installationsCol = await installations();
  const installationDoc = await installationsCol.findOne({ githubInstallationId });
  if (!installationDoc?._id) {
    log.info(
      { repo: payload.repository.full_name, githubInstallationId },
      "webhook ignored — repo isn't tracked and its installation is unknown",
    );
    return null;
  }

  const repositoriesCol = await repositories();
  const registered = await repositoriesCol.findOneAndUpdate(
    { githubRepoId: payload.repository.id },
    {
      $set: {
        installationId: String(installationDoc._id),
        githubInstallationId,
        fullName: payload.repository.full_name,
      },
    },
    { upsert: true, returnDocument: "after" },
  );

  log.info({ repo: payload.repository.full_name, githubInstallationId }, "repo auto-tracked from webhook");
  return registered;
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

  // The one chat command this bot supports: a maintainer overriding the
  // size gate on a PR the bot declined to review (see review/gate.ts).
  if (eventType === "issue_comment") {
    return handleForceCommand(rawPayload as unknown as IssueCommentEvent, deliveryId, log);
  }

  // A developer replying to one of our inline finding comments. Distinct
  // event from issue_comment, which only covers top-level PR comments.
  if (eventType === "pull_request_review_comment") {
    return handleFindingReply(rawPayload as unknown as PullRequestReviewCommentEvent, deliveryId, log);
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
  let repositoryDoc = await repositoriesCol.findOne({
    githubRepoId: payload.repository.id,
  });
  if (!repositoryDoc?._id) {
    // Not tracked yet. The repository list is otherwise only written by
    // /api/github/setup, which snapshots the installation's repos at the
    // moment someone runs it — so a repo created or added AFTER that (very
    // common on an "All repositories" installation, where GitHub grants
    // access to "all current and future repositories" without anyone
    // revisiting the app) would stay invisible until setup was re-run by
    // hand. Registering it here instead means access granted on GitHub is
    // all it takes, which is what choosing "All repositories" already says.
    //
    // The delivery's own signature is what makes this safe: GitHub only
    // sends us events for installations we belong to, and the installation
    // must already be known before we write anything, so this can adopt a
    // new repo but never invent an installation.
    repositoryDoc = await registerRepositoryFromEvent(payload, log);
    if (!repositoryDoc?._id) return ok();
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
