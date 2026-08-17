import { getInstallationOctokit } from "@/lib/github/app";

export type CheckConclusion = "success" | "failure" | "neutral";

/**
 * Requires the GitHub App's "Checks: Read & write" permission. Callers must
 * treat this as fallible (a missing permission 403s) and never let a failure
 * here break the rest of the review pipeline.
 */
export async function createCheckRun(
  installationId: number,
  owner: string,
  repo: string,
  headSha: string,
): Promise<number> {
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
    owner,
    repo,
    name: "AI Code Review",
    head_sha: headSha,
    status: "in_progress",
    started_at: new Date().toISOString(),
  });
  return Number(data.id);
}

export async function completeCheckRun(
  installationId: number,
  owner: string,
  repo: string,
  checkRunId: number,
  output: { conclusion: CheckConclusion; title: string; summary: string },
): Promise<void> {
  const octokit = await getInstallationOctokit(installationId);
  await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
    owner,
    repo,
    check_run_id: checkRunId,
    status: "completed",
    conclusion: output.conclusion,
    completed_at: new Date().toISOString(),
    output: { title: output.title, summary: output.summary },
  });
}
