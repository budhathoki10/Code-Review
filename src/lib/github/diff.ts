import { getInstallationOctokit } from "@/lib/github/app";

//  this  ask for the github to get the changed file

/** Beyond this, skip the AI call entirely rather than send a partial or truncated diff. */
export const MAX_DIFF_FILES = 40;
export const MAX_DIFF_CHARS = 100_000;

export interface PullRequestFile {
  filename: string;
  patch?: string;
  status: string;
}

export interface PullRequestDiff {
  fileCount: number;
  diffText: string;
  files: PullRequestFile[];
}

/**
 * Builds a unified-diff-style text blob from a PR's changed files. Binary
 * files (no `patch` field from GitHub) are skipped rather than guessed at.
 */
export async function getPullRequestDiff(
  installationId: number,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PullRequestDiff> {
  const octokit = await getInstallationOctokit(installationId);

  // A single 100-file page is enough here: anything beyond MAX_DIFF_FILES
  // gets skipped by the caller regardless, so there's no need to paginate
  // further just to count files we're not going to review anyway.


  //This GitHub API request gets the files changed in the pull request: 
  const { data: files } = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
    { owner, repo, pull_number: pullNumber, per_page: 100 },
  );
//this code converts the changed GitHub files into one large diff string for the AI.
  const diffText = files
    .filter((file) => file.patch)
    .map((file) => `--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch}`)
    .join("\n\n");

  return {
    fileCount: files.length,
    diffText,
    files: files.map((file) => ({ filename: file.filename, patch: file.patch, status: file.status })),
  };
}
