import "dotenv/config";
import { createHmac } from "node:crypto";
import { getInstallationOctokit } from "@/lib/github/app";

/**
 * Replays a signed pull_request event straight at the local webhook route.
 *
 * The GitHub App has no webhook URL configured (`probe-webhook.mjs` reports
 * "(none configured)"), so nothing is delivered and pushing a branch does
 * nothing at all. Rather than repoint the App's public configuration to
 * whatever tunnel happens to be up, this exercises the identical code path
 * from the signature check onward — rate limit, tracking, throttle, queue,
 * worker, review, and the real posting back to the pull request.
 *
 * The payload carries the fields the route actually dereferences, notably
 * `pull_request.id` (the upsert key) and `merged`; omitting either produces a
 * 500 with an empty body, which is a slow thing to diagnose from the outside.
 *
 *   REPLAY_PR=84 npx tsx tests/manual/scripts/replay-pr-event.ts
 */
const PR = Number(process.env.REPLAY_PR ?? 0);
const ACTION = process.env.REPLAY_ACTION ?? "opened";
const OWNER = process.env.REPLAY_OWNER ?? "budhathoki10";
const REPO = process.env.REPLAY_REPO ?? "Code-Review";
const TARGET = process.env.REPLAY_TARGET ?? "http://localhost:3000/api/github/webhook";

async function main() {
  // Truthiness alone accepts -1, 1.5 and Infinity, each of which reaches the
  // GitHub client as an identifier and fails somewhere less obvious.
  const positiveInt = (value: number) => Number.isInteger(value) && value > 0;
  if (!positiveInt(PR)) throw new Error("set REPLAY_PR to a positive integer pull request number");
  const installationId = Number(process.env.REPLAY_INSTALLATION_ID ?? process.env.BENCH_INSTALLATION_ID);
  if (!positiveInt(installationId)) throw new Error("set REPLAY_INSTALLATION_ID to a positive integer");

  const octokit = await getInstallationOctokit(installationId);
  const { data: pr } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner: OWNER, repo: REPO, pull_number: PR,
  });

  const payload = {
    action: ACTION,
    number: pr.number,
    pull_request: {
      id: pr.id,
      merged: pr.merged,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      draft: pr.draft,
      state: pr.state,
      head: { sha: pr.head.sha, ref: pr.head.ref },
      base: { sha: pr.base.sha, ref: pr.base.ref },
      user: { login: pr.user?.login },
    },
    repository: {
      id: pr.base.repo.id,
      name: pr.base.repo.name,
      full_name: pr.base.repo.full_name,
      owner: { login: pr.base.repo.owner.login },
    },
    installation: { id: installationId },
  };

  const body = JSON.stringify(payload);
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new Error("GITHUB_WEBHOOK_SECRET is not set");

  const response = await fetch(TARGET, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": `replay-${Date.now()}`,
      "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
    },
    body,
  });
  // fetch resolves for 4xx and 5xx, so without this the script printed the
  // failure and still exited 0 — which is how an HTTP 500 from the webhook
  // route read as a successful replay until someone happened to look closely.
  const text = await response.text();
  console.log(`PR #${PR} ${ACTION} @ ${pr.head.sha.slice(0, 7)} -> HTTP ${response.status} ${text}`);
  if (!response.ok) throw new Error(`webhook rejected the replay: HTTP ${response.status}`);
}

main().then(() => process.exit(0), (error) => { console.error(String(error)); process.exit(1); });
