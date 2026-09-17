import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FindingDoc } from "@/lib/db/collections";

const { nvidiaCreate, openRouterCreate, getFileContentMock } = vi.hoisted(() => ({
  nvidiaCreate: vi.fn(),
  openRouterCreate: vi.fn(),
  getFileContentMock: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class OpenAI {
    chat: { completions: { create: typeof nvidiaCreate } };

    constructor(options: { baseURL?: string }) {
      this.chat = {
        completions: {
          create: options.baseURL?.includes("openrouter.ai") ? openRouterCreate : nvidiaCreate,
        },
      };
    }
  },
}));

vi.mock("@/lib/github/file-content", () => ({
  getFileContent: getFileContentMock,
  GitHubRateLimitError: class GitHubRateLimitError extends Error {},
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const finding: FindingDoc = {
  severity: "high",
  category: "bug",
  file: "src/example.ts",
  line: 4,
  title: "Example issue",
  explanation: "Example explanation",
};

describe("review reply provider failover", () => {
  beforeEach(() => {
    vi.resetModules();
    nvidiaCreate.mockReset();
    openRouterCreate.mockReset();
    getFileContentMock.mockReset();
    process.env.NVIDIA_API_KEY = "nvidia-test-key";
    process.env.NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
    process.env.OPENROUTER_API_KEY = "openrouter-test-key";
    process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
  });

  it("answers a finding thread through OpenRouter when NVIDIA returns 404", async () => {
    nvidiaCreate.mockRejectedValueOnce(Object.assign(new Error("not found"), { status: 404 }));
    openRouterCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          tool_calls: [{
            id: "answer-1",
            type: "function",
            function: { name: "submit_answer", arguments: JSON.stringify({ answer: "The guard handles this case." }) },
          }],
        },
      }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    });

    const { generateReplyAnswer } = await import("@/lib/ai/reply");
    const result = await generateReplyAnswer({
      finding,
      botLogin: "prsentry[bot]",
      thread: [
        { id: 1, author: "prsentry[bot]", authorType: "Bot", body: "Example issue", createdAt: "2026-09-17T00:00:00Z" },
        { id: 2, author: "alice", authorType: "User", body: "Why?", createdAt: "2026-09-17T00:01:00Z" },
      ],
    });

    expect(result.answer).toBe("The guard handles this case.");
    expect(result.usage.calls).toBe(2);
    expect(nvidiaCreate).toHaveBeenCalledOnce();
    expect(openRouterCreate).toHaveBeenCalledOnce();
    expect(openRouterCreate.mock.calls[0][0].tools[0].function.name).toBe("submit_answer");
  });
});
