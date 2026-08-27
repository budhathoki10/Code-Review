/**
 * Reports the GitHub App's configured webhook URL and whether it currently
 * answers. Without a reachable webhook there is no end-to-end path: pushing a
 * branch will do nothing at all, and the runbook's scenarios cannot run.
 *
 *   node tests/manual/scripts/probe-webhook.mjs
 */
import "dotenv/config";
import { App } from "@octokit/app";

const app = new App({
  appId: process.env.GITHUB_APP_ID,
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY.replace(/\n/g, "\n"),
});

const { data } = await app.octokit.request("GET /app");
console.log("app:", data.slug);
console.log("webhook url:", data.hook_attributes?.url ?? "(none configured)");
console.log("webhook active:", data.hook_attributes?.active);
console.log("subscribed events:", (data.events ?? []).join(", ") || "(none)");

const url = data.hook_attributes?.url;
if (url) {
  try {
    const res = await fetch(url, { method: "POST", body: "{}", signal: AbortSignal.timeout(8000) });
    // A 401 is the healthy answer: the endpoint is up and rejected an unsigned body.
    console.log(`reachability: HTTP ${res.status} ${res.status === 401 ? "(endpoint live — rejected unsigned payload, as expected)" : ""}`);
  } catch (error) {
    console.log(`reachability: UNREACHABLE — ${error.message.slice(0, 120)}`);
  }
}

console.log("\nissue_comment subscribed (needed for @prsentry review --force):",
  (data.events ?? []).includes("issue_comment") ? "yes" : "NO");
