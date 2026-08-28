import { getInstallationOctokit } from "@/lib/github/app";

/** One message in a review-comment thread, in the order GitHub returned it. */
export interface ThreadMessage {
  id: number;
  author: string;
  authorType: string;
  body: string;
  createdAt: string;
}

/**
 * Reads one review-comment thread: the root comment plus every reply under it.
 *
 * GitHub flattens threads — a reply to a reply still carries the ROOT
 * comment's id in `in_reply_to_id`, never the intermediate one — so a thread
 * is exactly "the comment with this id, plus everything whose in_reply_to_id
 * is this id", no recursion needed.
 *
 * Fetched live rather than stored, so the model always sees the real current
 * thread (including edits and any human replies we never saw a webhook for)
 * instead of a private copy that drifts.
 */
export async function getReviewCommentThread(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  rootCommentId: number,
): Promise<ThreadMessage[]> {
  const octokit = await getInstallationOctokit(installationId);
  const all = (await octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/comments", {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  })) as {
    id: number;
    in_reply_to_id?: number;
    body?: string;
    created_at: string;
    user?: { login?: string; type?: string } | null;
  }[];

  return all
    .filter((c) => c.id === rootCommentId || c.in_reply_to_id === rootCommentId)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map((c) => ({
      id: c.id,
      author: c.user?.login ?? "unknown",
      authorType: c.user?.type ?? "User",
      body: c.body ?? "",
      createdAt: c.created_at,
    }));
}

/**
 * Posts a reply into an existing review-comment thread. GitHub threads it
 * under the root comment automatically, so the answer appears directly below
 * the question rather than as a detached comment elsewhere on the PR.
 */

// this is the function where we make to reply back to the comment in github. this function was called on reply-pipeline.ts line no 93
export async function postReviewCommentReply(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  rootCommentId: number,
  body: string,
): Promise<number> {
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.request(
    "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies",
    { owner, repo, pull_number: prNumber, comment_id: rootCommentId, body },
  );
  return Number(data.id);
}
