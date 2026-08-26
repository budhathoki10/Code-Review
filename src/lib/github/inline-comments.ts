import { getInstallationOctokit } from "@/lib/github/app";
import type { InlineComment } from "@/lib/github/diff-lines";

export async function postInlineReview(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  comments: InlineComment[],
): Promise<void> {
  const octokit = await getInstallationOctokit(installationId);
  // octo kit post requesr for the reviews the code 
  await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
    owner,
    repo,
    pull_number: prNumber,
    commit_id: headSha,
    event: "COMMENT",
    comments: comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })),
  });
}
