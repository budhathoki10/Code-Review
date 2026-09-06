import type { ReviewDoc } from "@/lib/db/collections";

/**
 * Observed, explicitly rated sample only — a review nobody rated is absent
 * from the denominator rather than counted as correct. Duplicates are a
 * separate noise measure and do not enter the false-positive rate.
 */
export function feedbackStats(reviews: Pick<ReviewDoc, "feedback">[]) {
  const correct = reviews.filter((review) => review.feedback?.label === "correct").length;
  const falsePositive = reviews.filter((review) => review.feedback?.label === "false-positive").length;
  const duplicate = reviews.filter((review) => review.feedback?.label === "duplicate").length;
  const assessed = correct + falsePositive;
  return { correct, falsePositive, duplicate, assessed, falsePositiveRate: assessed ? falsePositive / assessed : null };
}
