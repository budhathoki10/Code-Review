import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";

const auth = vi.hoisted(() => vi.fn());
const updateSettings = vi.hoisted(() => vi.fn());
const invalidate = vi.hoisted(() => vi.fn());
const probeCreate = vi.hoisted(() => vi.fn());
const catalog = vi.hoisted(() => vi.fn());
const rateLimit = vi.hoisted(() => vi.fn());
const resetClients = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ auth }));
vi.mock("next/cache", () => ({ revalidatePath: invalidate }));
vi.mock("@/lib/db/collections", () => ({ userSettings: async () => ({ updateOne: updateSettings }) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: rateLimit }));
vi.mock("@/lib/queue/connection", () => ({ getRedisConnection: () => ({}) }));
vi.mock("@/lib/ai/provider", () => ({ resetByoClients: resetClients }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: probeCreate } };
  },
}));
vi.mock("@/lib/ai/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/catalog")>()),
  getCatalog: catalog,
}));

import { clearAiSettings, saveAiSettings } from "@/app/dashboard/settings/actions";
import { decryptSecret } from "@/lib/crypto/secret-box";

const KEY = randomBytes(32).toString("base64");

const PROVIDERS = [{
  id: "openrouter",
  name: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  models: [{
    id: "vendor/good",
    name: "Good Model",
    contextLimit: 262_144,
    maxOutput: 32_000,
    costPerMTokIn: 0.6,
    costPerMTokOut: 2.4,
  }],
}];

const VALID = { providerId: "openrouter", model: "vendor/good", apiKey: "sk-user-key-1234" };

function toolCallResponse() {
  return { choices: [{ message: { tool_calls: [{ type: "function", function: { name: "report_ready", arguments: "{}" } }] } }] };
}

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SECRETS_ENCRYPTION_KEY", KEY);
  auth.mockResolvedValue({ user: { id: "user-1" } });
  catalog.mockResolvedValue({ providers: PROVIDERS, stale: false });
  rateLimit.mockResolvedValue(true);
  probeCreate.mockResolvedValue(toolCallResponse());
  updateSettings.mockResolvedValue({ acknowledged: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("saving AI settings is refused without authorization or configuration", () => {
  it("refuses an unauthenticated caller", async () => {
    auth.mockResolvedValue(null);
    expect(await saveAiSettings(VALID)).toHaveProperty("error");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("refuses to accept a key it has no way to encrypt", async () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", "");
    expect(await saveAiSettings(VALID)).toMatchObject({ error: expect.stringContaining("SECRETS_ENCRYPTION_KEY") });
    expect(updateSettings).not.toHaveBeenCalled();
    expect(probeCreate).not.toHaveBeenCalled();
  });

  it("refuses an empty key without calling any provider", async () => {
    expect(await saveAiSettings({ ...VALID, apiKey: "   " })).toHaveProperty("error");
    expect(probeCreate).not.toHaveBeenCalled();
  });

  it("refuses an absurdly long key", async () => {
    expect(await saveAiSettings({ ...VALID, apiKey: "x".repeat(501) })).toHaveProperty("error");
    expect(probeCreate).not.toHaveBeenCalled();
  });

  it("refuses when the user is rate limited", async () => {
    rateLimit.mockResolvedValue(false);
    expect(await saveAiSettings(VALID)).toHaveProperty("error");
    expect(probeCreate).not.toHaveBeenCalled();
  });

  it("still works when the rate limiter throws outright", async () => {
    rateLimit.mockRejectedValue(new Error("redis unavailable"));
    expect(await saveAiSettings(VALID)).toEqual({ success: true });
  });

  // The failure that actually happened. The shared Redis connection uses
  // `maxRetriesPerRequest: null` for BullMQ, so a command issued while Redis
  // is unreachable is queued and retried forever — it never resolves and
  // never rejects. A try/catch cannot see that; only a timeout can. Before
  // the bound existed, this left the form on "Checking your key…" forever.
  it("does not hang when the rate limiter never settles", async () => {
    rateLimit.mockReturnValue(new Promise(() => {}));
    await expect(saveAiSettings(VALID)).resolves.toEqual({ success: true });
  }, 10_000);

  it("still probes and stores the key after a hung rate limiter", async () => {
    rateLimit.mockReturnValue(new Promise(() => {}));
    await saveAiSettings(VALID);
    expect(probeCreate).toHaveBeenCalled();
    expect(updateSettings).toHaveBeenCalled();
  }, 10_000);
});

describe("saving AI settings validates against the real catalogue", () => {
  it("refuses a provider that is not in the catalogue", async () => {
    expect(await saveAiSettings({ ...VALID, providerId: "made-up" })).toHaveProperty("error");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("refuses a model the chosen provider does not offer", async () => {
    expect(await saveAiSettings({ ...VALID, model: "vendor/not-offered" })).toHaveProperty("error");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("probes the catalogue's base URL, never one supplied by the caller", async () => {
    await saveAiSettings({ ...VALID, providerId: "openrouter" } as never);
    expect(probeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "vendor/good" }),
      expect.anything(),
    );
  });
});

describe("the live probe decides whether a key is stored", () => {
  it("stores nothing when the provider rejects the key", async () => {
    probeCreate.mockRejectedValue(httpError(401));
    expect(await saveAiSettings(VALID)).toMatchObject({ error: expect.stringContaining("rejected") });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  // A working key on an unfunded account. Telling the reader to "check the
  // key" here sends them to verify something that is already correct.
  it("says the account is out of credit on a 402, not that the key is wrong", async () => {
    probeCreate.mockRejectedValue(httpError(402));
    const result = await saveAiSettings(VALID);
    expect(result).toMatchObject({ error: expect.stringContaining("no credit") });
    expect((result as { error: string }).error).not.toMatch(/rejected|incorrect/i);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("points at tool-call support when the provider refuses the request shape", async () => {
    probeCreate.mockRejectedValue(httpError(400));
    expect(await saveAiSettings(VALID)).toMatchObject({ error: expect.stringContaining("tool calls") });
  });

  it.each([
    [401, /rejected/i],
    [402, /credit/i],
    [404, /model/i],
    [429, /rate-limited/i],
    [500, /did not answer/i],
  ])("gives a distinct explanation for HTTP %i", async (status, pattern) => {
    probeCreate.mockRejectedValue(httpError(status));
    const result = await saveAiSettings(VALID);
    expect((result as { error: string }).error).toMatch(pattern);
  });

  it("stores nothing when the provider does not know the model", async () => {
    probeCreate.mockRejectedValue(httpError(404));
    expect(await saveAiSettings(VALID)).toMatchObject({ error: expect.stringContaining("model") });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  // Catalogue metadata claims tool support; only a real call proves it. A
  // model that answers in prose produces no findings, which reads to the
  // author as "your code is clean".
  it("stores nothing when the model ignores the forced tool call", async () => {
    probeCreate.mockResolvedValue({ choices: [{ message: { content: "Sure, I am ready!" } }] });
    expect(await saveAiSettings(VALID)).toMatchObject({ error: expect.stringContaining("tool calling") });
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

describe("a verified key is stored encrypted, with its model's metadata", () => {
  it("writes ciphertext, never the key itself", async () => {
    await saveAiSettings(VALID);

    const [, update] = updateSettings.mock.calls[0];
    const stored = update.$set.ai;
    expect(stored.keyCiphertext).not.toContain("sk-user-key-1234");
    expect(decryptSecret(stored.keyCiphertext)).toBe("sk-user-key-1234");
    expect(JSON.stringify(update)).not.toContain("sk-user-key-1234");
  });

  it("keeps only the last four characters for display", async () => {
    await saveAiSettings(VALID);
    expect(updateSettings.mock.calls[0][1].$set.ai.keyLast4).toBe("1234");
  });

  it("snapshots the limits and prices, so a review never has to fetch them", async () => {
    await saveAiSettings(VALID);
    expect(updateSettings.mock.calls[0][1].$set.ai).toMatchObject({
      providerId: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "vendor/good",
      contextLimit: 262_144,
      maxOutput: 32_000,
      costPerMTokIn: 0.6,
      costPerMTokOut: 2.4,
      verifiedAt: expect.any(Date),
    });
  });

  it("upserts against the user, so one person cannot end up with two rows", async () => {
    await saveAiSettings(VALID);
    expect(updateSettings).toHaveBeenCalledWith(
      { userId: "user-1" },
      expect.anything(),
      { upsert: true },
    );
  });

  it("drops cached clients so a replaced key takes effect immediately", async () => {
    await saveAiSettings(VALID);
    expect(resetClients).toHaveBeenCalled();
  });

  it("revalidates the settings page", async () => {
    await saveAiSettings(VALID);
    expect(invalidate).toHaveBeenCalledWith("/dashboard/settings");
  });
});

describe("clearing AI settings", () => {
  it("refuses an unauthenticated caller", async () => {
    auth.mockResolvedValue(null);
    expect(await clearAiSettings()).toHaveProperty("error");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("removes the stored provider entirely rather than blanking it", async () => {
    expect(await clearAiSettings()).toEqual({ success: true });
    expect(updateSettings).toHaveBeenCalledWith(
      { userId: "user-1" },
      expect.objectContaining({ $unset: { ai: "" } }),
    );
    expect(resetClients).toHaveBeenCalled();
  });
});
