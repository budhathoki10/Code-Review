import { getInstallationOctokit } from "@/lib/github/app";

/**
 * Fetches a single file's content at a specific ref. Returns `undefined` for
 * anything that isn't a plain file blob (a directory listing, a submodule,
 * a symlink) or on any API error — callers treat a missing file as "skip",
 * never as fatal.
 */
export async function getFileContent(
  installationId: number,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | undefined> {
  try {
    const octokit = await getInstallationOctokit(installationId);
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path,
      ref,
    });

    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
      return undefined;
    }

    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch {
    return undefined;
  }
}
