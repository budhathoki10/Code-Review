import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { nvidiaCreate, openRouterCreate, constructorMock, warnMock, errorMock } = vi.hoisted(() => ({
  nvidiaCreate: vi.fn(),
  openRouterCreate: vi.fn(),
  constructorMock: vi.fn(),
  warnMock: vi.fn(),
  errorMock: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class OpenAI {
    chat: { completions: { create: typeof nvidiaCreate } };

    constructor(options: { baseURL?: string }) {
      constructorMock(options);
      this.chat = {
        completions: {
          create: options.baseURL?.includes("openrouter.ai") ? openRouterCreate : nvidiaCreate,
        },
      };
    }
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: warnMock, error: errorMock },
}));

function completion(answer = "ok") {
  return {
    choices: [{ message: { content: answer, tool_calls: [] }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  };
}

async function loadProvider() {
  vi.resetModules();
  process.env.NVIDIA_API_KEY = "nvidia-test-key";
  process.env.NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
  process.env.OPENROUTER_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
  return import("@/lib/ai/provider");
}

describe("NVIDIA to OpenRouter provider failover", () => {
  beforeEach(() => {
    nvidiaCreate.mockReset();
    openRouterCreate.mockReset();
    constructorMock.mockReset();
    warnMock.mockReset();
    errorMock.mockReset();
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_BASE_URL;
    delete process.env.OPENROUTER_MODEL;
  });

  it("falls back on NVIDIA 404 and translates NVIDIA-only reasoning parameters", async () => {
    const { createChatCompletion } = await loadProvider();
    nvidiaCreate.mockRejectedValueOnce(Object.assign(new Error("not found"), { status: 404 }));
    openRouterCreate.mockResolvedValueOnce(completion());
    const attempts: string[] = [];

    const result = await createChatCompletion({
      model: "nvidia/primary",
      messages: [{ role: "user", content: "review this" }],
      tools: [{ type: "function", function: { name: "submit", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "submit" } },
      max_tokens: 1000,
      chat_template_kwargs: { thinking: true, enable_thinking: true },
    }, undefined, { onProviderAttempt: (provider) => attempts.push(provider) });

    expect(result).toEqual(completion());
    expect(attempts).toEqual(["nvidia", "openrouter"]);
    expect(openRouterCreate).toHaveBeenCalledTimes(1);
    const fallbackParams = openRouterCreate.mock.calls[0][0];
    expect(fallbackParams.model).toBe("nvidia/nemotron-3-ultra-550b-a55b");
    expect(fallbackParams.chat_template_kwargs).toBeUndefined();
    expect(fallbackParams.reasoning).toEqual({ enabled: true });
    expect(fallbackParams.tool_choice).toEqual({ type: "function", function: { name: "submit" } });
  });

  it("does not hide a bad request behind provider failover", async () => {
    const { createChatCompletion } = await loadProvider();
    const error = Object.assign(new Error("invalid request"), { status: 400 });
    nvidiaCreate.mockRejectedValueOnce(error);

    await expect(createChatCompletion({
      model: "nvidia/primary",
      messages: [{ role: "user", content: "review this" }],
    })).rejects.toBe(error);
    expect(openRouterCreate).not.toHaveBeenCalled();
  });

  it("falls back on transport failures as well as HTTP availability errors", async () => {
    const { createChatCompletion } = await loadProvider();
    nvidiaCreate.mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"));
    openRouterCreate.mockResolvedValueOnce(completion("recovered"));

    const result = await createChatCompletion({
      model: "nvidia/primary",
      messages: [{ role: "user", content: "review this" }],
    });

    expect(result.choices[0]?.message.content).toBe("recovered");
    expect(openRouterCreate).toHaveBeenCalledTimes(1);
  });

  it("rethrows the NVIDIA failure when no OpenRouter key is configured", async () => {
    const provider = await loadProvider();
    delete process.env.OPENROUTER_API_KEY;
    const error = Object.assign(new Error("not found"), { status: 404 });
    nvidiaCreate.mockRejectedValueOnce(error);

    await expect(provider.createChatCompletion({
      model: "nvidia/primary",
      messages: [{ role: "user", content: "review this" }],
    })).rejects.toBe(error);
    expect(openRouterCreate).not.toHaveBeenCalled();
    expect(errorMock).toHaveBeenCalledOnce();
  });
});
