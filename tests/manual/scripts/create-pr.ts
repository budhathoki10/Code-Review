/**
 * Creates a real PR for a scenario: a base branch holding the "before" tree,
 * a head branch holding the "after" tree, and a pull request between them.
 *
 * Two branches rather than one so files come back from GitHub as `modified`
 * rather than `added`. A PR of purely added files skips most of what these
 * scenarios test — GitHub renders those diffs differently, and the triage
 * heuristics behave differently on them.
 *
 *   npx tsx tests/manual/scripts/create-pr.ts <scenario> <owner/repo>
 *   npx tsx tests/manual/scripts/create-pr.ts 4 acme/widgets --follow-up <branch>
 *
 * Uses the GitHub Contents/Git Data API rather than a local clone, so it needs
 * no working copy of the target repo and cannot disturb this one.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { scenarioById, type Scenario } from "./fixtures";

function gh(args: string[], input?: string): string {
  return execFileSync("gh", args, {
    encoding: "utf-8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function api<T>(args: string[], input?: string): T {
  return JSON.parse(gh(["api", ...args], input)) as T;
}

/** Creates one git tree + commit holding exactly `files`, on top of `parentSha`. */
function commitTree(
  repo: string,
  parentSha: string,
  baseTreeSha: string | null,
  files: Record<string, string>,
  message: string,
): string {
  // Blobs first. Batched sequentially on purpose: a 400-file scenario firing
  // 400 concurrent blob creates is a reliable way to get secondary-rate-limited.
  const tree: { path: string; mode: string; type: string; sha: string }[] = [];
  let done = 0;
  for (const [path, content] of Object.entries(files)) {
    const blob = api<{ sha: string }>(
      [`repos/${repo}/git/blobs`, "--method", "POST", "--input", "-"],
      JSON.stringify({ content: Buffer.from(content, "utf-8").toString("base64"), encoding: "base64" }),
    );
    tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
    if (++done % 50 === 0) process.stderr.write(`    ...${done}/${Object.keys(files).length} blobs\n`);
  }

  const treeBody: Record<string, unknown> = { tree };
  if (baseTreeSha) treeBody.base_tree = baseTreeSha;
  const createdTree = api<{ sha: string }>(
    [`repos/${repo}/git/trees`, "--method", "POST", "--input", "-"],
    JSON.stringify(treeBody),
  );

  const commit = api<{ sha: string }>(
    [`repos/${repo}/git/commits`, "--method", "POST", "--input", "-"],
    JSON.stringify({ message, tree: createdTree.sha, parents: [parentSha] }),
  );
  return commit.sha;
}

function createRef(repo: string, branch: string, sha: string): void {
  api([`repos/${repo}/git/refs`, "--method", "POST", "--input", "-"], JSON.stringify({ ref: `refs/heads/${branch}`, sha }));
}

function updateRef(repo: string, branch: string, sha: string): void {
  api([`repos/${repo}/git/refs/heads/${branch}`, "--method", "PATCH", "--input", "-"], JSON.stringify({ sha, force: true }));
}

export interface CreatedPr {
  scenario: number;
  repo: string;
  prNumber: number;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  url: string;
  createdAt: string;
}

export function createScenarioPr(scenario: Scenario, repo: string): CreatedPr {
  const stamp = Date.now().toString(36);
  const baseBranch = `verify/${scenario.slug}-${stamp}-base`;
  const headBranch = `verify/${scenario.slug}-${stamp}-head`;

  const repoInfo = api<{ default_branch: string }>([`repos/${repo}`]);
  const defaultRef = api<{ object: { sha: string } }>([`repos/${repo}/git/ref/heads/${repoInfo.default_branch}`]);
  const rootSha = defaultRef.object.sha;

  console.log(`  base branch: ${baseBranch} (${Object.keys(scenario.base).length} files)`);
  const baseCommit = commitTree(repo, rootSha, null, scenario.base, `verify(${scenario.slug}): base state`);
  createRef(repo, baseBranch, baseCommit);

  console.log(`  head branch: ${headBranch} (${Object.keys(scenario.head).length} files)`);
  const baseCommitInfo = api<{ tree: { sha: string } }>([`repos/${repo}/git/commits/${baseCommit}`]);
  const headCommit = commitTree(repo, baseCommit, baseCommitInfo.tree.sha, scenario.head, `verify(${scenario.slug}): head state`);
  createRef(repo, headBranch, headCommit);

  const pr = api<{ number: number; html_url: string }>(
    [`repos/${repo}/pulls`, "--method", "POST", "--input", "-"],
    JSON.stringify({
      title: `[verify] Scenario ${scenario.id}: ${scenario.title}`,
      head: headBranch,
      base: baseBranch,
      body: `Automated fixture for the large-PR verification runbook.\n\n**Intent:** ${scenario.intent}\n\nSafe to close and delete.`,
    }),
  );

  return {
    scenario: scenario.id,
    repo,
    prNumber: pr.number,
    baseBranch,
    headBranch,
    headSha: headCommit,
    url: pr.html_url,
    createdAt: new Date().toISOString(),
  };
}

/** Scenario 4's second push: a tiny change on top of an already-reviewed head. */
export function pushFollowUp(scenario: Scenario, repo: string, headBranch: string): string {
  if (!scenario.followUp) throw new Error(`scenario ${scenario.id} has no follow-up defined`);

  const ref = api<{ object: { sha: string } }>([`repos/${repo}/git/ref/heads/${headBranch}`]);
  const parent = ref.object.sha;
  const parentInfo = api<{ tree: { sha: string } }>([`repos/${repo}/git/commits/${parent}`]);

  const sha = commitTree(repo, parent, parentInfo.tree.sha, scenario.followUp, `verify(${scenario.slug}): follow-up push`);
  updateRef(repo, headBranch, sha);
  return sha;
}

if (process.argv[1]?.includes("create-pr")) {
  const [, , idArg, repo, ...rest] = process.argv;
  if (!idArg || !repo) {
    console.error("usage: create-pr.ts <scenario> <owner/repo> [--follow-up <headBranch>]");
    process.exit(1);
  }
  const scenario = scenarioById(Number(idArg));

  const followUpIndex = rest.indexOf("--follow-up");
  if (followUpIndex !== -1) {
    const branch = rest[followUpIndex + 1];
    console.log(`pushing follow-up commit to ${branch}...`);
    console.log(JSON.stringify({ headSha: pushFollowUp(scenario, repo, branch) }, null, 2));
  } else {
    console.log(`creating scenario ${scenario.id} against ${repo}...`);
    const created = createScenarioPr(scenario, repo);
    console.log(JSON.stringify(created, null, 2));
  }
}
