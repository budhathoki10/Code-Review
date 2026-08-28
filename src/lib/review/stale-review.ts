import { reviews } from "@/lib/db/collections";

/**
 * How long a review may sit in "pending" before it is treated as abandoned —
 * a worker that died mid-job leaves the row pending forever otherwise.
 */
const STALE_AFTER_MS = 30 * 60_000;

/** Reviews still pending well past any plausible runtime, newest first. */
export async function findStaleReviews(now: Date = new Date()) {
  const reviewsCol = await reviews();
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS);

  return reviewsCol
    .find({ status: "pending", createdAt: { $lt: cutoff } })
    .sort({ createdAt: -1 })
    .toArray();
}

/** Marks one abandoned review as failed so it stops showing as in-progress. */
export async function markReviewAbandoned(reviewId: string): Promise<void> {
  const reviewsCol = await reviews();

  reviewsCol.updateOne(
    { _id: reviewId },
    {
      $set: {
        status: "failed",
        error: { message: "Review abandoned — worker did not finish", attempts: 0, failedAt: new Date() },
      },
    },
  );
}
