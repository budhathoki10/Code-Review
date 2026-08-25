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

/** Binary files (no `patch` field from GitHub) are skipped rather than guessed at. Shared by getPullRequestDiff and getIncrementalDiff so both build the same diffText shape the AI/linters already expect. */
function buildDiffText(files: { filename: string; patch?: string }[]): string {
  return files
    .filter((file) => file.patch)
    .map((file) => `--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch}`)
    .join("\n\n");
}

/**
 * Builds a unified-diff-style text blob from a PR's changed files, diffed
 * against its base branch — always the *entire* PR, regardless of what was
 * reviewed before. Used for the first review of a PR, and as the fallback
 * whenever getIncrementalDiff isn't usable.
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

  return {
    fileCount: files.length,
    diffText: buildDiffText(files),
    files: files.map((file) => ({ filename: file.filename, patch: file.patch, status: file.status })),
  };
}

/**
 * Builds the same PullRequestDiff shape, but diffed between two arbitrary
 * commits (the previous review's headSha and this push's headSha) instead
 * of against the PR's base branch — the delta since the last review, not
 * the whole PR. Uses GitHub's compare API, which computes a merge-base
 * ("three-dot") diff, so it still returns a sensible result even if history
 * was rewritten (e.g. a force-push) rather than erroring outright — callers
 * should still treat this as fallible (see pipeline.ts's fallback to
 * getPullRequestDiff on any rejection here).
 */
export async function getIncrementalDiff(
  installationId: number,
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
): Promise<PullRequestDiff> {
  const octokit = await getInstallationOctokit(installationId);

  const { data } = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
    owner,
    repo,
    basehead: `${baseSha}...${headSha}`,
  });

  const files = data.files ?? [];

  return {
    fileCount: files.length,
    diffText: buildDiffText(files),
    files: files.map((file) => ({ filename: file.filename, patch: file.patch, status: file.status })),
  };
}
