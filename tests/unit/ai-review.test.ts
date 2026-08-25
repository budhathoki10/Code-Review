import { describe, it, expect, beforeEach, vi } from "vitest";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

function toolResponse(args: unknown) {
  return {
    choices: [
      {
        message: {
          tool_calls: [{ type: "function", function: { arguments: JSON.stringify(args) } }],
        },
      },
    ],
  };
}

/** Routes the mocked `create` call to a findings or verdict response based on which tool was requested. */
function wireResponses(findingsArgs: unknown, verdictArgs: unknown) {
  createMock.mockImplementation((params: { tool_choice?: { function?: { name?: string } } }) => {
    const toolName = params.tool_choice?.function?.name;
    if (toolName === "submit_findings") return Promise.resolve(toolResponse(findingsArgs));
    if (toolName === "submit_verdict") return Promise.resolve(toolResponse(verdictArgs));
    throw new Error(`unexpected tool_choice: ${String(toolName)}`);
  });
}

async function loadGenerateReview() {
  vi.resetModules();
  process.env.NVIDIA_API_KEY = "test-key";
  process.env.NVIDIA_BASE_URL = "https://example.test/v1";
  const mod = await import("@/lib/ai/review");
  return mod.generateReview;
}

describe("generateReview", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("combines findings and verdict/summary from two concurrent calls", async () => {
    const generateReview = await loadGenerateReview();
    wireResponses(
      {
        findings: [
          {
            severity: "medium",
            category: "quality",
            file: "src/foo.ts",
            line: 3,
            title: "unused var",
            explanation: "x is never used",
          },
        ],
      },
      { verdict: "comment", summary: "Looks reasonable overall." },
    );

    const result = await generateReview("diff --git a/foo b/foo");

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe("unused var");
    expect(result.verdict).toBe("comment");
    expect(result.summary).toContain("Looks reasonable overall.");
    expect(result.summary).toContain("*Current review: COMMENT.*");
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("overrides an approve verdict to request_changes when a high/critical finding is present", async () => {
    const generateReview = await loadGenerateReview();
    wireResponses(
      {
        findings: [
          {
            severity: "critical",
            category: "security",
            file: "src/auth.ts",
            title: "hardcoded secret",
            explanation: "a secret is committed in plaintext",
          },
        ],
      },
      { verdict: "approve", summary: "Nothing concerning here." },
    );

    const result = await generateReview("diff --git a/auth b/auth");

    expect(result.verdict).toBe("request_changes");
    expect(result.summary).toContain("*Current review: REQUEST CHANGES.*");
  });

  it("does not downgrade an independent request_changes verdict when findings are empty", async () => {
    const generateReview = await loadGenerateReview();
    wireResponses({ findings: [] }, { verdict: "request_changes", summary: "The design here is unsafe." });

    const result = await generateReview("diff --git a/design b/design");

    expect(result.verdict).toBe("request_changes");
    expect(result.findings).toHaveLength(0);
  });

  it("propagates a rejection if the findings call fails", async () => {
    const generateReview = await loadGenerateReview();
    createMock.mockImplementation((params: { tool_choice?: { function?: { name?: string } } }) => {
      const toolName = params.tool_choice?.function?.name;
      if (toolName === "submit_findings") return Promise.reject(new Error("provider error"));
      return Promise.resolve(toolResponse({ verdict: "approve", summary: "ok" }));
    });

    await expect(generateReview("diff --git a/x b/x")).rejects.toThrow("provider error");
  });

  it("propagates a rejection if the verdict call fails", async () => {
    const generateReview = await loadGenerateReview();
    createMock.mockImplementation((params: { tool_choice?: { function?: { name?: string } } }) => {
      const toolName = params.tool_choice?.function?.name;
      if (toolName === "submit_verdict") return Promise.reject(new Error("provider timeout"));
      return Promise.resolve(toolResponse({ findings: [] }));
    });

    await expect(generateReview("diff --git a/x b/x")).rejects.toThrow("provider timeout");
  });

  it("includes customInstructions in both calls' user messages", async () => {
    const generateReview = await loadGenerateReview();
    wireResponses({ findings: [] }, { verdict: "approve", summary: "fine" });

    await generateReview("diff --git a/x b/x", { customInstructions: ["ignore generated files"] });

    expect(createMock).toHaveBeenCalledTimes(2);
    for (const call of createMock.mock.calls) {
      const params = call[0] as { messages: { role: string; content: string }[] };
      const userMessage = params.messages.find((m) => m.role === "user");
      expect(userMessage?.content).toContain("ignore generated files");
    }
  });

  it("includes static-analysis findings in both calls' context, framed as already-reported", async () => {
    const generateReview = await loadGenerateReview();
    wireResponses({ findings: [] }, { verdict: "approve", summary: "fine" });

    await generateReview("diff --git a/x b/x", {
      staticFindings: [
        {
          severity: "medium",
          category: "quality",
          file: "src/foo.ts",
          line: 12,
          title: "ESLint: eqeqeq",
          explanation: "Expected '===' and instead saw '=='.",
        },
      ],
    });

    for (const call of createMock.mock.calls) {
      const params = call[0] as { messages: { role: string; content: string }[] };
      const userMessage = params.messages.find((m) => m.role === "user");
      expect(userMessage?.content).toContain("AUTOMATED LINT/STATIC-ANALYSIS FINDINGS");
      expect(userMessage?.content).toContain("src/foo.ts:12 — ESLint: eqeqeq");
    }
  });

  it("includes PR title and description in both calls' context", async () => {
    const generateReview = await loadGenerateReview();
    wireResponses({ findings: [] }, { verdict: "approve", summary: "fine" });

    await generateReview("diff --git a/x b/x", {
      prTitle: "Fix login button on mobile",
      prBody: "The submit button was unreachable below the fold on small screens.",
    });

    for (const call of createMock.mock.calls) {
      const params = call[0] as { messages: { role: string; content: string }[] };
      const userMessage = params.messages.find((m) => m.role === "user");
      expect(userMessage?.content).toContain("PR TITLE: Fix login button on mobile");
      expect(userMessage?.content).toContain("unreachable below the fold");
    }
  });

  it("omits the static-findings and PR-metadata sections entirely when not provided", async () => {
    const generateReview = await loadGenerateReview();
    wireResponses({ findings: [] }, { verdict: "approve", summary: "fine" });

    await generateReview("diff --git a/x b/x");

    for (const call of createMock.mock.calls) {
      const params = call[0] as { messages: { role: string; content: string }[] };
      const userMessage = params.messages.find((m) => m.role === "user");
      expect(userMessage?.content).not.toContain("AUTOMATED LINT/STATIC-ANALYSIS FINDINGS");
      expect(userMessage?.content).not.toContain("PR TITLE:");
    }
  });
});
