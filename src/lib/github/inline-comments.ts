import { getInstallationOctokit } from "@/lib/github/app";
import type { InlineComment } from "@/lib/github/diff-lines";
import { logger } from "@/lib/logger";

/** One posted inline comment, paired with the GitHub comment id it landed as. */
export interface PostedInlineComment {
  comment: InlineComment;
  commentId: number;
}

/**
 * Matches the comments GitHub created back to the ones we sent.
 *
 * Keyed on body text rather than path+line because two findings on the same
 * line would be indistinguishable by position, whereas the body we generated
 * is stored verbatim. Identical bodies (the same finding text twice) are
 * handed out in order via a per-body queue, so a duplicate still maps to a
 * distinct comment id rather than both claiming the first one.
 *
 * Anything that doesn't match is simply left unmapped — the review is already
 * posted at this point, and an unmapped comment only costs the ability to
 * reply to that one finding.
 */
export function matchCommentIds(
  sent: InlineComment[],
  created: { id: number; body?: string }[],
): PostedInlineComment[] {
  const byBody = new Map<string, number[]>();
  for (const c of created) {
    if (typeof c.body !== "string") continue;
    const queue = byBody.get(c.body);
    if (queue) queue.push(c.id);
    else byBody.set(c.body, [c.id]);
  }

  const matched: PostedInlineComment[] = [];
  for (const comment of sent) {
    const queue = byBody.get(comment.body);
    const commentId = queue?.shift();
    if (commentId !== undefined) matched.push({ comment, commentId });
  }
  return matched;
}

/**
 * Posts findings as one batch review and returns the GitHub comment id each
 * one landed as, so the caller can persist the finding→comment mapping the
 * reply feature resolves against (see FindingDoc.githubCommentId).
 *
 * The create-review response carries only the review's own id, not its
 * comments, so the ids come from a second read of that review's comments.
 * That read is best-effort: if it fails, the comments are still posted and
 * visible on the PR — the only loss is that those findings can't be replied
 * to. Failing the whole review over a lookup for a secondary feature would
 * trade the primary output for the optional one.
 */
export async function postInlineReview(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  comments: InlineComment[],
): Promise<PostedInlineComment[]> {
  const octokit = await getInstallationOctokit(installationId);
  // octo kit post request for the reviews the code
  // requesting the octo kit for the review according ti the pr number
  const { data: review } = await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
    owner,
    repo,
    pull_number: prNumber,
    commit_id: headSha,
    event: "COMMENT",
    comments: comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })),
  });

  try {
    // Unpaginated on purpose: this reads back one review's own comments, and
    // that review can never hold more than MAX_INLINE_COMMENTS (25) of them,
    // so a single 100-per-page request always covers it.
    const { data: created } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments",
      { owner, repo, pull_number: prNumber, review_id: Number(review.id), per_page: 100 },
    );
    return matchCommentIds(comments, created.map((c) => ({ id: Number(c.id), body: c.body })));
  } catch (err) {
    logger.warn(
      { err, owner, repo, prNumber, reviewId: review.id },
      "posted inline comments but could not read back their ids — findings in this review won't be replyable",
    );
    return [];
  }
}
