import type { Logger } from "pino";
import { ObjectId } from "mongodb";
import { generateReplyAnswer } from "@/lib/ai/reply";
import { getBotLogin } from "@/lib/github/app";
import { getReviewCommentThread, postReviewCommentReply } from "@/lib/github/review-comments";
import { pullRequests, reviews, type FindingDoc, type ReviewDoc } from "@/lib/db/collections";
import { recordUsage } from "@/lib/db/usage";
import type { ReplyJobData } from "@/lib/queue/reply-queue";

/**
 * Finds the finding a thread is about.
 *
 * Scoped to this PR's reviews rather than searched globally: comment ids are
 * unique across GitHub, but scoping keeps the query small and means a bug in
 * id handling can never surface a finding from an unrelated repository.
 * Searches all of the PR's reviews, not just the newest, because a thread
 * stays open across later pushes — the question may be about a finding from
 * two commits ago.
 */
export async function findFindingByCommentId(
  pullRequestId: string,
  commentId: number,
): Promise<{ review: ReviewDoc; finding: FindingDoc } | undefined> {
  const reviewsCol = await reviews();
  const review = await reviewsCol.findOne({
    pullRequestId,
    "findings.githubCommentId": commentId,
  });
  if (!review) return undefined;

  const finding = review.findings.find((f) => f.githubCommentId === commentId);
  return finding ? { review, finding } : undefined;
}

/**
 * Answers one question in a finding's comment thread.
 *
 * Returns without posting when there's nothing to answer — an unresolvable
 * thread, or one whose last message is our own. Those are normal outcomes
 * (someone replying to a bot comment we never mapped, a redelivered
 * webhook), not failures, so they must not throw: a throw here costs a
 * retry and, once retries are exhausted, a dead-lettered job.
 */
export async function runReplyPipeline(data: ReplyJobData, log: Logger): Promise<void> {
  const { githubInstallationId, owner, repo, prNumber, pullRequestId, rootCommentId } = data;

  const match = await findFindingByCommentId(pullRequestId, rootCommentId);
  if (!match) {
    log.info({ rootCommentId }, "reply ignored — no finding maps to this comment");
    return;
  }

  const botLogin = await getBotLogin();
  const thread = await getReviewCommentThread(githubInstallationId, owner, repo, prNumber, rootCommentId);
  if (thread.length === 0) {
    log.info({ rootCommentId }, "reply ignored — thread came back empty");
    return;
  }

  // If our own message is last, the question has already been answered —
  // either this is a duplicate delivery, or another attempt of this job
  // already posted. Posting again would double-answer the thread.
  const last = thread[thread.length - 1];
  if (last.author === botLogin) {
    log.info({ rootCommentId }, "reply skipped — last message in the thread is already ours");
    return;
  }

  let prTitle: string | undefined;
  let headSha: string | undefined;
  if (ObjectId.isValid(pullRequestId)) {
    const pullRequestsCol = await pullRequests();
    const prDoc = await pullRequestsCol.findOne({
      _id: new ObjectId(pullRequestId) as unknown as string,
    });
    prTitle = prDoc?.title;
    headSha = prDoc?.headSha;
  }
// send to the ai for the comment 
  const { answer, usage } = await generateReplyAnswer({
    finding: match.finding,
    thread,
    botLogin,
    prTitle,
    // Read the file at the PR's current head, not the commit the finding was
    // written against — the developer is asking about the code as it stands
    // now, which may already include their fix.
    repo: headSha
      ? { installationId: githubInstallationId, owner, repo, ref: headSha }
      : undefined,
  });
// reply back to the comment
  const replyId = await postReviewCommentReply(
    githubInstallationId,
    owner,
    repo,
    prNumber,
    rootCommentId,
    answer,
  );
  log.info({ rootCommentId, replyId, tokens: usage.totalTokens }, "posted reply");

  // Same treatment as the review path: usage accounting must never fail work
  // that already succeeded and is visible on the PR.
  await recordUsage(usage).catch((err) => log.warn({ err }, "failed to record reply usage"));
}
