import { createHmac, timingSafeEqual } from "crypto";

/**
 * Verifies a GitHub webhook payload against its `X-Hub-Signature-256` header.
 * Must be called against the raw request body — HMAC breaks if the JSON is
 * re-serialized first, since that can change byte-for-byte formatting.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;

  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");

  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signatureHeader);

  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}
