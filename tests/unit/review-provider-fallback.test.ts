import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestFile } from "@/lib/github/diff";

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

const file: PullRequestFile = {
  filename: "src/example.ts",
  status: "modified",
  patch: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;",
};

describe("code review provider failover", () => {
  beforeEach(() => {
    vi.resetModules();
    nvidiaCreate.mockReset();
    openRouterCreate.mockReset();
    getFileContentMock.mockReset();
    process.env.NVIDIA_API_KEY = "nvidia-test-key";
    process.env.NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
    process.env.OPENROUTER_API_KEY = "openrouter-test-key";
    process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.OPENROUTER_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
    process.env.REVIEW_FINDINGS_TOOL_ROUNDS = "0";
    process.env.REVIEW_CHUNK_RETRY_DELAYS_MS = "0,0,0";
  });

  it("completes the review through OpenRouter when NVIDIA returns 404", async () => {
    nvidiaCreate.mockRejectedValueOnce(Object.assign(new Error("not found"), { status: 404 }));
    openRouterCreate.mockResolvedValueOnce({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: [{
            id: "findings-1",
            type: "function",
            function: { name: "submit_findings", arguments: JSON.stringify({ findings: [] }) },
          }],
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    });

    const { generateChunkedReview } = await import("@/lib/ai/review");
    const result = await generateChunkedReview([[file]]);

    expect(result.unreviewedFiles).toEqual([]);
    expect(result.usage.calls).toBe(2);
    expect(nvidiaCreate).toHaveBeenCalledOnce();
    expect(openRouterCreate).toHaveBeenCalledOnce();
    expect(openRouterCreate.mock.calls[0][0].tools[0].function.name).toBe("submit_findings");
  });
});
