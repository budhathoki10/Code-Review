import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import { verifyWebhookSignature } from "@/lib/github/webhook";

const ORIGINAL_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

function sign(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyWebhookSignature", () => {
  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
  });

  afterEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = ORIGINAL_SECRET;
  });

  it("accepts a correctly signed payload", () => {
    const body = JSON.stringify({ action: "opened" });
    const signature = sign("test-secret", body);

    expect(verifyWebhookSignature(body, signature)).toBe(true);
  });

  it("rejects a payload signed with the wrong secret", () => {
    const body = JSON.stringify({ action: "opened" });
    const signature = sign("some-other-secret", body);

    expect(verifyWebhookSignature(body, signature)).toBe(false);
  });

  it("rejects a payload whose body was tampered with after signing", () => {
    const originalBody = JSON.stringify({ action: "opened" });
    const signature = sign("test-secret", originalBody);
    const tamperedBody = JSON.stringify({ action: "closed" });

    expect(verifyWebhookSignature(tamperedBody, signature)).toBe(false);
  });

  it("rejects when the signature header is missing", () => {
    const body = JSON.stringify({ action: "opened" });

    expect(verifyWebhookSignature(body, null)).toBe(false);
  });

  it("rejects when GITHUB_WEBHOOK_SECRET is not configured", () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const body = JSON.stringify({ action: "opened" });
    const signature = sign("test-secret", body);

    expect(verifyWebhookSignature(body, signature)).toBe(false);
  });

  it("rejects a malformed signature header without throwing", () => {
    const body = JSON.stringify({ action: "opened" });

    expect(() => verifyWebhookSignature(body, "not-a-real-signature")).not.toThrow();
    expect(verifyWebhookSignature(body, "not-a-real-signature")).toBe(false);
  });
});
