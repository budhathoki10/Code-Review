import { test, expect } from "@playwright/test";
import { createHmac } from "crypto";

/**
 * End-to-end: real HTTP requests against the real running Next.js server,
 * hitting the actual /api/github/webhook route handler — not a mock.
 *
 * Scoped to paths that resolve before any DB/Redis call (see
 * src/app/api/github/webhook/route.ts), so this suite runs with zero
 * external services: signature verification always runs first, and a
 * non-"pull_request" event (e.g. "ping", which GitHub sends when a webhook
 * is first configured) returns 200 without ever touching Mongo or Redis.
 */
// this is the webhook secret for end to end 
const WEBHOOK_SECRET = "e2e-test-webhook-secret";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

test.describe("POST /api/github/webhook", () => {
  test("rejects a request with no signature header", async ({ request }) => {
    const body = JSON.stringify({ zen: "test" });

    const response = await request.post("/api/github/webhook", {
      data: body,
      headers: { "content-type": "application/json", "x-github-event": "ping" },
    });

    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid signature" });
  });

  test("rejects a request with an invalid signature", async ({ request }) => {
    const body = JSON.stringify({ zen: "test" });

    const response = await request.post("/api/github/webhook", {
      data: body,
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=0000000000000000000000000000000000000000000000000000000000000000",
      },
    });

    expect(response.status()).toBe(401);
  });

  test("rejects a request whose body was tampered with after signing", async ({ request }) => {
    const signedBody = JSON.stringify({ zen: "original" });
    const signature = sign(signedBody);
    const sentBody = JSON.stringify({ zen: "tampered" });

    const response = await request.post("/api/github/webhook", {
      data: sentBody,
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": signature,
      },
    });

    expect(response.status()).toBe(401);
  });

  test("accepts a validly signed non-pull_request event and short-circuits", async ({ request }) => {
    const body = JSON.stringify({ zen: "design for failure" });
    const signature = sign(body);

    const response = await request.post("/api/github/webhook", {
      data: body,
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": signature,
      },
    });

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
