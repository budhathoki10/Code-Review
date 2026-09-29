import { ObjectId } from "mongodb";
import webpush from "web-push";
import { installations, pullRequests, pushSubscriptions, reviews } from "@/lib/db/collections";
import { getUserIdForGithubAccount } from "@/lib/github/account";
import type { ReviewJobData } from "@/lib/queue/review-queue";
import { logger } from "@/lib/logger";
import { pushConfigured } from "./subscription";

type ReviewNotice = Pick<ReviewJobData, "reviewId" | "pullRequestId" | "headSha" | "githubInstallationId" | "owner" | "repo" | "prNumber">;

let configured = false;

function configureWebPush(): boolean {
  if (!pushConfigured()) return false;
  if (!configured) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT!,
      process.env.VAPID_PUBLIC_KEY!,
      process.env.VAPID_PRIVATE_KEY!,
    );
    configured = true;
  }
  return true;
}

/** Send only to an endpoint already registered to this signed-in user. */
export async function sendTestPush(userId: string, endpoint: string): Promise<"sent" | "missing" | "expired" | "unconfigured"> {
  if (!configureWebPush()) return "unconfigured";
  const collection = await pushSubscriptions();
  const subscription = await collection.findOne({ userId, endpoint });
  if (!subscription) return "missing";
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: subscription.keys },
      JSON.stringify({ title: "Notifications are working", body: "PRSentry can alert this browser when a review finishes.", url: "/dashboard", tag: "push-test" }),
      { TTL: 60, timeout: 5_000 },
    );
    return "sent";
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 404 || statusCode === 410) {
      await collection.deleteOne({ userId, endpoint });
      return "expired";
    }
    throw error;
  }
}

/** Best effort: notification delivery must never change the review's result. */
export async function notifyReviewOutcome(data: ReviewNotice, outcome: "completed" | "failed"): Promise<void> {
  try {
    if (!configureWebPush()) return;
    const installation = await (await installations()).findOne({ githubInstallationId: data.githubInstallationId });
    if (!installation?.githubUserId) return;
    const userId = await getUserIdForGithubAccount(installation.githubUserId);
    if (!userId) return;
    const subscriptionsCol = await pushSubscriptions();
    const subscriptions = await subscriptionsCol.find({ userId }).limit(20).toArray();
    if (!subscriptions.length) return;

    const reviewsCol = await reviews();
    const review = await reviewsCol.findOneAndUpdate(
      { pullRequestId: data.pullRequestId, headSha: data.headSha, status: outcome, pushNotifiedAt: { $exists: false } },
      { $set: { pushNotifiedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!review) return;

    const repository = `${data.owner}/${data.repo}`;
    const title = outcome === "completed" ? "Code review ready" : "Code review could not finish";
    const body = outcome === "completed"
      ? `${repository} #${data.prNumber}: ${review.findings.length} finding${review.findings.length === 1 ? "" : "s"}.`
      : `${repository} #${data.prNumber}: open the dashboard for details.`;
    const pullRequest = ObjectId.isValid(data.pullRequestId)
      ? await (await pullRequests()).findOne({ _id: new ObjectId(data.pullRequestId) as unknown as string })
      : null;
    const url = pullRequest?.repositoryId && ObjectId.isValid(pullRequest.repositoryId)
      ? `/dashboard/repos/${pullRequest.repositoryId}?pr=${encodeURIComponent(data.pullRequestId)}`
      : "/dashboard";
    const payload = JSON.stringify({ title, body, url, tag: `review-${data.reviewId}` });

    await Promise.allSettled(subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: subscription.keys },
          payload,
          { TTL: 60 * 60, timeout: 5_000 },
        );
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await subscriptionsCol.deleteOne({ endpoint: subscription.endpoint, userId });
        } else {
          logger.warn({ reviewId: data.reviewId, statusCode, err: error }, "web push delivery failed");
        }
      }
    }));
  } catch (error) {
    logger.warn({ reviewId: data.reviewId, err: error }, "review push notification failed");
  }
}
