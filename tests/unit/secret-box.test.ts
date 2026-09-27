import { describe, expect, it, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  assertSecretsConfigured,
  decryptSecret,
  encryptSecret,
  keyFingerprint,
  secretsConfigured,
  SecretBoxError,
} from "@/lib/crypto/secret-box";

const KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("secret envelope round trip", () => {
  it("returns the original secret", () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", KEY);
    const secret = "sk-or-v1-0123456789abcdef";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("produces a different envelope every time, so equal keys are not visibly equal", () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", KEY);
    expect(encryptSecret("same-secret")).not.toBe(encryptSecret("same-secret"));
  });

  it("handles non-ASCII secrets byte for byte", () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", KEY);
    const secret = "clé-très-sécurisée-🔐";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("refuses to encrypt an empty secret", () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", KEY);
    expect(() => encryptSecret("")).toThrow(SecretBoxError);
  });

  it("tags the envelope with a version, so the scheme can change later", () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", KEY);
    expect(encryptSecret("secret").startsWith("v1.")).toBe(true);
  });
});

describe("secret envelope rejects what it cannot trust", () => {
  it("refuses a ciphertext encrypted under a different master key", () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", KEY);
    const envelope = encryptSecret("secret");
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", OTHER_KEY);
    expect(() => decryptSecret(envelope)).toThrow(SecretBoxError);
  });

  it("refuses a tampered ciphertext rather than returning different bytes", () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", KEY);
    const [version, iv, tag, ciphertext] = encryptSecret("secret").split(".");
    const flipped = Buffer.from(ciphertext, "base64");
    flipped[0] ^= 0xff;
    expect(() => decryptSecret([version, iv, tag, flipped.toString("base64")].join("."))).toThrow(SecretBoxError);
  });

  it("refuses a tampered authentication tag", () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", KEY);
    const [version, iv, tag, ciphertext] = encryptSecret("secret").split(".");
    const flipped = Buffer.from(tag, "base64");
    flipped[0] ^= 0xff;
    expect(() => decryptSecret([version, iv, flipped.toString("base64"), ciphertext].join("."))).toThrow(SecretBoxError);
  });

  it("refuses a malformed envelope", () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", KEY);
    expect(() => decryptSecret("not-an-envelope")).toThrow(SecretBoxError);
    expect(() => decryptSecret("v1.only.three")).toThrow(SecretBoxError);
  });

  it("refuses an envelope written under a future version", () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", KEY);
    const rest = encryptSecret("secret").split(".").slice(1).join(".");
    expect(() => decryptSecret(`v2.${rest}`)).toThrow(/Unsupported secret envelope version/);
  });
});

describe("master key configuration", () => {
  it("reports unconfigured rather than throwing, so the UI can explain itself", () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", "");
    expect(secretsConfigured()).toBe(false);
    expect(() => assertSecretsConfigured()).toThrow(SecretBoxError);
  });

  it("rejects a key that does not decode to 32 bytes", () => {
    // Buffer.from truncates malformed base64 instead of throwing, so only the
    // length check catches a half-copied value.
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", randomBytes(16).toString("base64"));
    expect(secretsConfigured()).toBe(false);
    expect(() => encryptSecret("secret")).toThrow(/32 bytes/);
  });

  it("accepts a correctly sized key", () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", KEY);
    expect(secretsConfigured()).toBe(true);
    expect(() => assertSecretsConfigured()).not.toThrow();
  });

  it("is read per call, so rotating the env var takes effect without a reimport", () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", "");
    expect(secretsConfigured()).toBe(false);
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", KEY);
    expect(secretsConfigured()).toBe(true);
  });
});

describe("key fingerprint", () => {
  it("shows only the last four characters", () => {
    expect(keyFingerprint("sk-or-v1-secret-tail1234")).toBe("1234");
  });

  it("never returns more than the key itself", () => {
    expect(keyFingerprint("ab")).toBe("ab");
  });
});
