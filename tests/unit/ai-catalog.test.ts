import { describe, expect, it } from "vitest";
import { findModel, isSafeBaseUrl, parseCatalog } from "@/lib/ai/catalog";

const payload = {
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    api: "https://openrouter.ai/api/v1",
    doc: "https://openrouter.ai/models",
    models: {
      good: {
        id: "vendor/good",
        name: "Good Model",
        tool_call: true,
        reasoning: true,
        limit: { context: 262_144, output: 32_000 },
        cost: { input: 0.6, output: 2.4 },
      },
      noTools: { id: "vendor/no-tools", name: "No Tools", tool_call: false, limit: { context: 8_192 } },
    },
  },
  // No `api` field and no built-in endpoint: served only through a
  // vendor-specific SDK, so this app cannot reach it.
  vendorsdk: {
    id: "vendorsdk",
    name: "Vendor SDK Only",
    models: { m: { id: "m", name: "M", tool_call: true } },
  },
  toolless: {
    id: "toolless",
    name: "Toolless",
    api: "https://toolless.example.com/v1",
    models: { m: { id: "m", name: "M", tool_call: false } },
  },
};

describe("catalogue filtering", () => {
  it("keeps only providers this app can reach over the OpenAI protocol", () => {
    expect(parseCatalog(payload).map((p) => p.id)).toEqual(["openrouter"]);
  });

  it("drops models that cannot call tools, because every stage reads its result from one", () => {
    const provider = parseCatalog(payload).find((p) => p.id === "openrouter");
    expect(provider?.models.map((m) => m.id)).toEqual(["vendor/good"]);
  });

  it("drops a provider left with no usable models at all", () => {
    expect(parseCatalog(payload).find((p) => p.id === "toolless")).toBeUndefined();
  });

  it("carries the limits and prices a review needs to snapshot", () => {
    const provider = parseCatalog(payload).find((p) => p.id === "openrouter")!;
    expect(provider.models[0]).toEqual({
      id: "vendor/good",
      name: "Good Model",
      contextLimit: 262_144,
      maxOutput: 32_000,
      costPerMTokIn: 0.6,
      costPerMTokOut: 2.4,
      reasoning: true,
    });
  });

  it("survives a payload that is not shaped the way it expects", () => {
    expect(parseCatalog(null)).toEqual([]);
    expect(parseCatalog("nonsense")).toEqual([]);
    expect(parseCatalog({ broken: { api: "https://x.example.com", models: undefined } })).toEqual([]);
  });

  it("leaves a missing price undefined rather than defaulting it to zero", () => {
    const [provider] = parseCatalog({
      p: { id: "p", name: "P", api: "https://p.example.com/v1", models: { m: { id: "m", name: "M", tool_call: true } } },
    });
    expect(provider.models[0].costPerMTokIn).toBeUndefined();
  });
});

describe("base URL safety", () => {
  // The catalogue is third-party data and the save action makes a live
  // request to whatever it names, so this is where that data stops being
  // trusted.
  it.each([
    "https://openrouter.ai/api/v1",
    "https://integrate.api.nvidia.com/v1",
  ])("accepts the public HTTPS endpoint %s", (url) => {
    expect(isSafeBaseUrl(url)).toBe(true);
  });

  it.each([
    ["plain HTTP", "http://openrouter.ai/api/v1"],
    ["loopback", "https://127.0.0.1/v1"],
    ["localhost", "https://localhost:8080/v1"],
    ["a .internal name", "https://vault.internal/v1"],
    ["a .local name", "https://printer.local/v1"],
    ["private 10.x", "https://10.0.0.5/v1"],
    ["private 192.168.x", "https://192.168.1.1/v1"],
    ["private 172.16.x", "https://172.16.0.1/v1"],
    ["link-local metadata", "https://169.254.169.254/latest/meta-data"],
    ["IPv6 loopback", "https://[::1]/v1"],
    ["not a URL at all", "definitely not a url"],
  ])("rejects %s", (_label, url) => {
    expect(isSafeBaseUrl(url)).toBe(false);
  });

  it("does not list a provider whose endpoint would be refused", () => {
    const parsed = parseCatalog({
      evil: { id: "evil", name: "Evil", api: "http://169.254.169.254/", models: { m: { id: "m", name: "M", tool_call: true } } },
    });
    expect(parsed).toEqual([]);
  });
});

describe("looking a choice back up", () => {
  const providers = parseCatalog(payload);

  it("finds a real provider and model pair", () => {
    expect(findModel(providers, "openrouter", "vendor/good")?.model.name).toBe("Good Model");
  });

  it("refuses a model the provider does not offer", () => {
    expect(findModel(providers, "openrouter", "vendor/no-tools")).toBeUndefined();
  });

  it("refuses an unknown provider", () => {
    expect(findModel(providers, "made-up", "vendor/good")).toBeUndefined();
  });
});

describe("first-party providers that models.dev gives no api field", () => {
  // models.dev only sets `api` for providers behind its generic
  // OpenAI-compatible adapter. Anthropic, OpenAI, Google and the rest each
  // have their own SDK entry, so filtering on `api` alone silently dropped
  // every name a user would look for first.
  const firstParty = {
    anthropic: { id: "anthropic", name: "Anthropic", models: { m: { id: "claude-opus-5", name: "Claude Opus 5", tool_call: true } } },
    openai: { id: "openai", name: "OpenAI", models: { m: { id: "gpt-5.4", name: "GPT-5.4", tool_call: true } } },
    google: { id: "google", name: "Google", models: { m: { id: "gemini-flash-latest", name: "Gemini Flash", tool_call: true } } },
    xai: { id: "xai", name: "xAI", models: { m: { id: "grok-4.7", name: "Grok 4.7", tool_call: true } } },
    groq: { id: "groq", name: "Groq", models: { m: { id: "llama-3.3-70b", name: "Llama 3.3 70B", tool_call: true } } },
    mistral: { id: "mistral", name: "Mistral", models: { m: { id: "mistral-large", name: "Mistral Large", tool_call: true } } },
    cerebras: { id: "cerebras", name: "Cerebras", models: { m: { id: "gpt-oss-120b", name: "GPT OSS 120B", tool_call: true } } },
    togetherai: { id: "togetherai", name: "Together AI", models: { m: { id: "llama", name: "Llama", tool_call: true } } },
    vercel: { id: "vercel", name: "Vercel AI Gateway", models: { m: { id: "alibaba/qwen-3-14b", name: "Qwen 3 14B", tool_call: true } } },
    deepinfra: { id: "deepinfra", name: "Deep Infra", models: { m: { id: "Qwen/Qwen3.8-Max", name: "Qwen3.8 Max", tool_call: true } } },
    venice: { id: "venice", name: "Venice AI", models: { m: { id: "gemini-3-6-flash", name: "Gemini 3.6 Flash", tool_call: true } } },
    aihubmix: { id: "aihubmix", name: "AIHubMix", models: { m: { id: "auto", name: "Auto", tool_call: true } } },
    cohere: { id: "cohere", name: "Cohere", models: { m: { id: "command-a", name: "Command A", tool_call: true } } },
  };

  it.each(Object.keys(firstParty))("lists %s despite the missing api field", (id) => {
    expect(parseCatalog(firstParty).find((p) => p.id === id)).toBeDefined();
  });

  it("gives Anthropic its OpenAI-compatibility endpoint", () => {
    const anthropic = parseCatalog(firstParty).find((p) => p.id === "anthropic");
    expect(anthropic?.baseUrl).toBe("https://api.anthropic.com/v1/");
  });

  it("every built-in base URL passes the safety check it will be validated against", () => {
    for (const provider of parseCatalog(firstParty)) {
      expect(isSafeBaseUrl(provider.baseUrl)).toBe(true);
    }
  });

  it("still prefers the catalogue's own api field when one is present", () => {
    const [provider] = parseCatalog({
      openai: { id: "openai", name: "OpenAI", api: "https://proxy.example.com/v1", models: { m: { id: "m", name: "M", tool_call: true } } },
    });
    expect(provider.baseUrl).toBe("https://proxy.example.com/v1");
  });

  // These need a per-provider credential form, not a base URL: SigV4,
  // per-resource URLs, or GCP application default credentials.
  it.each(["amazon-bedrock", "azure", "cloudflare-ai-gateway", "google-vertex", "watsonx"])(
    "still excludes %s, which cannot be reached with one URL and one bearer token",
    (id) => {
      const parsed = parseCatalog({
        [id]: { id, name: id, models: { m: { id: "m", name: "M", tool_call: true } } },
      });
      expect(parsed).toEqual([]);
    },
  );

  it("does not invent a provider that has no usable models", () => {
    const parsed = parseCatalog({
      anthropic: { id: "anthropic", name: "Anthropic", models: { m: { id: "m", name: "M", tool_call: false } } },
    });
    expect(parsed).toEqual([]);
  });
});
