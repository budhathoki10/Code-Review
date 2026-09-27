/**
 * Copies the worker's dashboard-only env vars from the local .env to Render.
 *
 *   npx tsx scripts/_render-env.ts            dry run, prints key names only
 *   npx tsx scripts/_render-env.ts --apply    writes them, then triggers a deploy
 *
 * Needs RENDER_API_KEY in .env or the shell (Render dashboard > Account > API Keys).
 * Values are never printed. Each key is written on its own, so env vars already
 * set on the service and not listed here are left untouched.
 */
import { config } from "dotenv";

config({ quiet: true });

const SERVICE_NAME = "ai-code-review-worker";
const API = "https://api.render.com/v1";

/** The keys render.yaml marks `sync: false`, which Render expects in the dashboard. */
const KEYS = [
  "MONGODB_URI",
  "MONGODB_DB",
  "REDIS_URL",
  "NVIDIA_API_KEY",
  "NVIDIA_BASE_URL",
  "NVIDIA_TOP_P",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
];

const apply = process.argv.includes("--apply");
const token = process.env.RENDER_API_KEY;

async function render(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
  return res.status === 204 ? undefined : res.json();
}

async function main() {
  if (!token) throw new Error("RENDER_API_KEY is not set. Add it to .env or your shell.");

  const services = (await render(`/services?name=${SERVICE_NAME}&limit=20`)) as { service: { id: string; name: string } }[];
  const service = services.find((s) => s.service.name === SERVICE_NAME)?.service;
  if (!service) throw new Error(`No Render service named ${SERVICE_NAME} on this account.`);

  const present = KEYS.filter((key) => process.env[key]);
  const missing = KEYS.filter((key) => !process.env[key]);

  console.log(`service: ${service.name} (${service.id})`);
  console.log(`will set: ${present.join(", ") || "nothing"}`);
  if (missing.length) console.log(`not in local .env, skipped: ${missing.join(", ")}`);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to write these to Render.");
    return;
  }

  for (const key of present) {
    await render(`/services/${service.id}/env-vars/${key}`, {
      method: "PUT",
      body: JSON.stringify({ value: process.env[key] }),
    });
    console.log(`set ${key}`);
  }

  await render(`/services/${service.id}/deploys`, { method: "POST", body: JSON.stringify({}) });
  console.log("deploy triggered");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
