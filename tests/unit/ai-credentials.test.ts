import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";

const installation = vi.hoisted(() => vi.fn());
const settings = vi.hoisted(() => vi.fn());
const updateSettings = vi.hoisted(() => vi.fn());
const userIdForAccount = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/collections", () => ({
  installations: async () => ({ findOne: installation }),
  userSettings: async () => ({ findOne: settings, updateOne: updateSettings }),
}));
vi.mock("@/lib/github/account", () => ({ getUserIdForGithubAccount: userIdForAccount }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { disableCredentials, resolveAiCredentials } from "@/lib/ai/credentials";
import { AiCredentialsError } from "@/lib/ai/credential-errors";
import { encryptSecret } from "@/lib/crypto/secret-box";

const KEY = randomBytes(32).toString("base64");
const INSTALLATION_ID = "507f1f77bcf86cd799439011";
const repo = { installationId: INSTALLATION_ID };

function storedAi(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "some/model",
    keyCiphertext: encryptSecret("sk-user-key"),
    keyLast4: "-key",
    costPerMTokIn: 0.6,
    costPerMTokOut: 2.4,
    maxOutput: 32_000,
    verifiedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SECRETS_ENCRYPTION_KEY", KEY);
  vi.stubEnv("NVIDIA_MODEL", "platform/model");
  installation.mockResolvedValue({ _id: INSTALLATION_ID, githubUserId: "github-123" });
  userIdForAccount.mockResolvedValue("user-1");
  settings.mockResolvedValue({ userId: "user-1", ai: storedAi() });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolving a repository owner's AI credentials", () => {
  it("returns the owner's own provider, model and decrypted key", async () => {
    const credentials = await resolveAiCredentials(repo);
    expect(credentials).toMatchObject({
      source: "byo",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "some/model",
      apiKey: "sk-user-key",
      ownerUserId: "user-1",
      costPerMTokIn: 0.6,
      costPerMTokOut: 2.4,
      maxOutput: 32_000,
    });
  });

  it("falls back to the platform model when the owner has set nothing", async () => {
    settings.mockResolvedValue({ userId: "user-1" });
    const credentials = await resolveAiCredentials(repo);
    expect(credentials).toEqual({ source: "platform", model: "platform/model" });
  });
});

describe("credential resolution never blocks a review for the wrong reason", () => {
  // A repo whose ownership chain is broken still deserves a review. Only a
  // key that IS configured and IS unusable is worth failing over.
  it.each([
    ["no repository document", () => undefined, () => {}],
    ["an invalid installation id", () => ({ installationId: "not-an-object-id" }), () => {}],
    ["a missing installation", () => repo, () => installation.mockResolvedValue(null)],
    ["an installation with no GitHub user", () => repo, () => installation.mockResolvedValue({ _id: INSTALLATION_ID })],
    ["no matching Auth.js user", () => repo, () => userIdForAccount.mockResolvedValue(undefined)],
    ["no settings document", () => repo, () => settings.mockResolvedValue(null)],
  ])("falls back to the platform model given %s", async (_label, buildRepo, arrange) => {
    arrange();
    const credentials = await resolveAiCredentials(buildRepo());
    expect(credentials.source).toBe("platform");
  });
});

describe("credential resolution fails loudly when a configured key is unusable", () => {
  it("refuses a key that was disabled after being rejected", async () => {
    settings.mockResolvedValue({ userId: "user-1", ai: storedAi({ disabledAt: new Date("2026-02-01") }) });
    await expect(resolveAiCredentials(repo)).rejects.toThrow(AiCredentialsError);
  });

  it("names the provider in the message the user will read", async () => {
    settings.mockResolvedValue({ userId: "user-1", ai: storedAi({ disabledAt: new Date("2026-02-01") }) });
    await expect(resolveAiCredentials(repo)).rejects.toMatchObject({
      userFacing: expect.stringContaining("openrouter"),
    });
  });

  it("refuses rather than silently billing the operator when the key cannot be decrypted", async () => {
    // The master key rotated out from under an already-stored envelope.
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    await expect(resolveAiCredentials(repo)).rejects.toThrow(AiCredentialsError);
  });
});

describe("disabling a rejected key", () => {
  it("records the time and the provider's own message", async () => {
    await disableCredentials("user-1", "401 Unauthorized");
    expect(updateSettings).toHaveBeenCalledWith(
      { userId: "user-1" },
      {
        $set: expect.objectContaining({
          "ai.disabledAt": expect.any(Date),
          "ai.lastError": { message: "401 Unauthorized", at: expect.any(Date) },
        }),
      },
    );
  });
});
