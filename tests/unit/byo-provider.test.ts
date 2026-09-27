import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

const nvidiaCreate = vi.hoisted(() => vi.fn());
const openRouterCreate = vi.hoisted(() => vi.fn());
const byoCreate = vi.hoisted(() => vi.fn());
const constructed = vi.hoisted(() => [] as { baseURL?: string; apiKey?: string }[]);

vi.mock("openai", () => ({
  default: class {
    chat: { completions: { create: typeof nvidiaCreate } };
    constructor(options: { baseURL?: string; apiKey?: string }) {
      constructed.push(options);
      const base = options.baseURL ?? "";
      const create = base.includes("openrouter.ai")
        ? openRouterCreate
        : base.includes("integrate.api.nvidia.com")
          ? nvidiaCreate
          : byoCreate;
      this.chat = { completions: { create } };
    }
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

type Provider = typeof import("@/lib/ai/provider");

async function loadProvider(): Promise<Provider> {
  vi.resetModules();
  constructed.length = 0;
  process.env.NVIDIA_API_KEY = "platform-key";
  process.env.NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
  process.env.OPENROUTER_API_KEY = "platform-openrouter-key";
  process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
  return import("@/lib/ai/provider");
}

const byo = {
  source: "byo" as const,
  baseUrl: "https://api.example-provider.com/v1",
  apiKey: "sk-user-key",
  model: "user/model",
  ownerUserId: "user-1",
};

const params = { model: "platform/model", messages: [] } as never;

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_BASE_URL;
});

describe("a user's own provider", () => {
  it("is called instead of the platform's, with their model substituted in", async () => {
    const { createChatCompletion } = await loadProvider();
    byoCreate.mockResolvedValue({ choices: [] });

    await createChatCompletion(params, undefined, { credentials: byo });

    expect(byoCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "user/model" }),
      expect.anything(),
    );
    expect(nvidiaCreate).not.toHaveBeenCalled();
    expect(constructed.at(-1)).toMatchObject({ baseURL: byo.baseUrl, apiKey: byo.apiKey });
  });

  it("reuses one client for the same key rather than rebuilding it per call", async () => {
    const { createChatCompletion } = await loadProvider();
    byoCreate.mockResolvedValue({ choices: [] });

    await createChatCompletion(params, undefined, { credentials: byo });
    const afterFirst = constructed.length;
    await createChatCompletion(params, undefined, { credentials: byo });

    expect(constructed.length).toBe(afterFirst);
  });

  it("builds a separate client for a different key", async () => {
    const { createChatCompletion } = await loadProvider();
    byoCreate.mockResolvedValue({ choices: [] });

    await createChatCompletion(params, undefined, { credentials: byo });
    const afterFirst = constructed.length;
    await createChatCompletion(params, undefined, { credentials: { ...byo, apiKey: "sk-other-key" } });

    expect(constructed.length).toBe(afterFirst + 1);
  });

  it("reports itself as its own provider in usage accounting", async () => {
    const { createChatCompletion } = await loadProvider();
    byoCreate.mockResolvedValue({ choices: [] });
    const attempts: string[] = [];

    await createChatCompletion(params, undefined, {
      credentials: byo,
      onProviderAttempt: (provider) => attempts.push(provider),
    });

    expect(attempts).toEqual(["byo"]);
  });
});

describe("a user's provider never falls back to the operator's account", () => {
  // The whole point of bring-your-own-key. Quietly absorbing someone else's
  // billing problem means paying for their reviews indefinitely while they
  // see nothing wrong.
  it.each([401, 403, 429, 500, 503])("does not reach OpenRouter after an HTTP %i", async (status) => {
    const { createChatCompletion, ByoProviderError } = await loadProvider();
    byoCreate.mockRejectedValue(httpError(status));

    await expect(createChatCompletion(params, undefined, { credentials: byo }))
      .rejects.toThrow(ByoProviderError);
    expect(openRouterCreate).not.toHaveBeenCalled();
    expect(nvidiaCreate).not.toHaveBeenCalled();
  });

  it("marks 401 as an authentication failure, so the key can be disabled", async () => {
    const { createChatCompletion } = await loadProvider();
    byoCreate.mockRejectedValue(httpError(401));

    await expect(createChatCompletion(params, undefined, { credentials: byo }))
      .rejects.toMatchObject({ authFailure: true, ownerUserId: "user-1", status: 401 });
  });

  it("does not mark a rate limit as an authentication failure", async () => {
    const { createChatCompletion } = await loadProvider();
    byoCreate.mockRejectedValue(httpError(429));

    await expect(createChatCompletion(params, undefined, { credentials: byo }))
      .rejects.toMatchObject({ authFailure: false });
  });

  it("does not leak the key in the error it raises", async () => {
    const { createChatCompletion } = await loadProvider();
    byoCreate.mockRejectedValue(httpError(401));

    await expect(createChatCompletion(params, undefined, { credentials: byo }))
      .rejects.toSatisfy((error: Error) => !JSON.stringify({ m: error.message }).includes("sk-user-key"));
  });
});

describe("the platform path is unchanged", () => {
  it("still fails over from NVIDIA to OpenRouter", async () => {
    const { createChatCompletion } = await loadProvider();
    nvidiaCreate.mockRejectedValue(httpError(503));
    openRouterCreate.mockResolvedValue({ choices: [] });

    await createChatCompletion(params, undefined, {});

    expect(nvidiaCreate).toHaveBeenCalled();
    expect(openRouterCreate).toHaveBeenCalled();
  });

  it("fails over for platform credentials passed explicitly", async () => {
    const { createChatCompletion } = await loadProvider();
    nvidiaCreate.mockRejectedValue(httpError(503));
    openRouterCreate.mockResolvedValue({ choices: [] });

    await createChatCompletion(params, undefined, {
      credentials: { source: "platform", model: "platform/model" },
    });

    expect(openRouterCreate).toHaveBeenCalled();
  });
});

describe("finding a credential failure through the wrappers that hide it", () => {
  // Nothing that raises these errors is what catches them: callStage wraps in
  // ReviewStageError, the single-model path in FindingsLoopError. Without the
  // unwrap, a rejected key stays enabled and re-fails on every push.
  it("finds one behind a ReviewStageError-style cause", async () => {
    const { ByoProviderError } = await loadProvider();
    const { findCredentialError } = await import("@/lib/ai/credential-errors");
    const inner = new ByoProviderError("rejected", "user-1", 401, true);
    const wrapped = Object.assign(new Error("phase1_running failed"), { cause: inner });

    expect(findCredentialError(wrapped)).toBe(inner);
  });

  it("finds one behind FindingsLoopError's differently named property", async () => {
    const { ByoProviderError } = await loadProvider();
    const { findCredentialError } = await import("@/lib/ai/credential-errors");
    const inner = new ByoProviderError("rejected", "user-1", 401, true);
    const wrapped = Object.assign(new Error("loop failed"), { originalError: inner });

    expect(findCredentialError(wrapped)).toBe(inner);
  });

  it("finds one nested several wrappers deep", async () => {
    const { ByoProviderError } = await loadProvider();
    const { findCredentialError } = await import("@/lib/ai/credential-errors");
    const inner = new ByoProviderError("rejected", "user-1", 401, true);
    const wrapped = Object.assign(new Error("outer"), {
      cause: Object.assign(new Error("middle"), { originalError: inner }),
    });

    expect(findCredentialError(wrapped)).toBe(inner);
  });

  it("returns nothing for an ordinary provider outage, so the review still retries", async () => {
    const { findCredentialError } = await import("@/lib/ai/credential-errors");
    const wrapped = Object.assign(new Error("phase1 failed"), { cause: httpError(503) });

    expect(findCredentialError(wrapped)).toBeUndefined();
  });

  it("terminates on a self-referential cause chain", async () => {
    const { findCredentialError } = await import("@/lib/ai/credential-errors");
    const loop: { cause?: unknown } = {};
    loop.cause = loop;

    expect(findCredentialError(loop)).toBeUndefined();
  });
});
