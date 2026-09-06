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
console.log("subscribed events:", (data.events ?? []).join(", ") || "(none)");

// GET /app does NOT carry the configured webhook URL — hook_attributes is
// undefined on it, so reading that reported "(none configured)" for an app
// whose webhook was set and working, and sent a whole debugging session down
// the manual-replay path. The delivery config lives on its own endpoint.
const config = await app.octokit.request("GET /app/hook/config").then((r) => r.data).catch(() => ({}));
console.log("webhook url:", config.url ?? "(none configured)");
console.log("webhook secret set:", Boolean(config.secret));
console.log("content type:", config.content_type ?? "(unset)");

const url = config.url;
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
