import { describe, it, expect, beforeEach, vi } from "vitest";

const { createMock, getFileContentMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  getFileContentMock: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

vi.mock("@/lib/github/file-content", () => ({
  getFileContent: getFileContentMock,
}));

/** One raw chat-completion response carrying one or more tool calls. */
function toolCallResponse(calls: { name: string; args: unknown }[], content: string | null = null) {
  return {
    choices: [
      {
        message: {
          content,
          tool_calls: calls.map((c, i) => ({
            id: `call_${i}`,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
      },
    ],
  };
}

function toolResponse(name: string, args: unknown) {
  return toolCallResponse([{ name, args }]);
}

interface CreateParams {
  tools?: { function: { name: string } }[];
  messages: { role: string; content: string }[];
}

function toolNames(params: CreateParams): string[] {
  return params.tools?.map((t) => t.function.name) ?? [];
}

/**
 * Routes the mocked `create` call to the findings or verdict branch based on
 * which tools were advertised (not `tool_choice` — non-final findings rounds
 * use `tool_choice: "auto"`, which can't distinguish branches on its own).
 *
 * `findingsResponses` is either a single findings-args object (legacy shape —
 * auto-wrapped into a one-call queue, so every pre-Phase-2 test keeps working
 * unchanged) or an ORDERED ARRAY of raw responses, one per expected
 * findings-branch `create()` call (round 0, round 1, ..., final).
 */
function wireResponses(findingsResponses: unknown, verdictArgs: unknown) {
  const queue = Array.isArray(findingsResponses)
    ? [...(findingsResponses as unknown[])]
    : [toolResponse("submit_findings", findingsResponses)];

  createMock.mockImplementation((params: CreateParams) => {
    const names = toolNames(params);
    if (names.includes("submit_findings")) {
      const next = queue.shift();
      if (!next) throw new Error("findings-branch create() called more times than the test wired responses for");
      return Promise.resolve(next);
    }
    if (names.includes("submit_verdict")) {
      return Promise.resolve(toolResponse("submit_verdict", verdictArgs));
    }
    throw new Error(`unexpected tools in params: ${names.join(",")}`);
  });
}

async function loadGenerateReview() {
  vi.resetModules();
  process.env.NVIDIA_API_KEY = "test-key";
  process.env.NVIDIA_BASE_URL = "https://example.test/v1";
  const mod = await import("@/lib/ai/review");
  return mod;
}

const SAMPLE_REPO_CONTEXT = { installationId: 1, owner: "acme", repo: "widgets", ref: "deadbeef" };

function findingsBranchCalls(): CreateParams[] {
  return createMock.mock.calls.map((call: unknown[]) => call[0] as CreateParams).filter((params) => toolNames(params).includes("submit_findings"));
}

describe("generateReview", () => {
  beforeEach(() => {
    createMock.mockReset();
    getFileContentMock.mockReset();
  });

  it("combines findings and verdict/summary from two concurrent calls", async () => {
    const { generateReview } = await loadGenerateReview();
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
    const { generateReview } = await loadGenerateReview();
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
    const { generateReview } = await loadGenerateReview();
    wireResponses({ findings: [] }, { verdict: "request_changes", summary: "The design here is unsafe." });

    const result = await generateReview("diff --git a/design b/design");

    expect(result.verdict).toBe("request_changes");
    expect(result.findings).toHaveLength(0);
  });

  it("propagates a rejection if the findings call fails", async () => {
    const { generateReview } = await loadGenerateReview();
    createMock.mockImplementation((params: CreateParams) => {
      if (toolNames(params).includes("submit_findings")) return Promise.reject(new Error("provider error"));
      return Promise.resolve(toolResponse("submit_verdict", { verdict: "approve", summary: "ok" }));
    });

    await expect(generateReview("diff --git a/x b/x")).rejects.toThrow("provider error");
  });

  it("propagates a rejection if the verdict call fails", async () => {
    const { generateReview } = await loadGenerateReview();
    createMock.mockImplementation((params: CreateParams) => {
      if (toolNames(params).includes("submit_verdict")) return Promise.reject(new Error("provider timeout"));
      return Promise.resolve(toolResponse("submit_findings", { findings: [] }));
    });

    await expect(generateReview("diff --git a/x b/x")).rejects.toThrow("provider timeout");
  });

  it("includes customInstructions in both calls' user messages", async () => {
    const { generateReview } = await loadGenerateReview();
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
    const { generateReview } = await loadGenerateReview();
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
    const { generateReview } = await loadGenerateReview();
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
    const { generateReview } = await loadGenerateReview();
    wireResponses({ findings: [] }, { verdict: "approve", summary: "fine" });

    await generateReview("diff --git a/x b/x");

    for (const call of createMock.mock.calls) {
      const params = call[0] as { messages: { role: string; content: string }[] };
      const userMessage = params.messages.find((m) => m.role === "user");
      expect(userMessage?.content).not.toContain("AUTOMATED LINT/STATIC-ANALYSIS FINDINGS");
      expect(userMessage?.content).not.toContain("PR TITLE:");
    }
  });

  it("does not offer fetch_file when no repoContext is provided (unchanged single-call behavior)", async () => {
    const { generateReview } = await loadGenerateReview();
    wireResponses({ findings: [] }, { verdict: "approve", summary: "fine" });

    await generateReview("diff --git a/x b/x");

    expect(findingsBranchCalls()).toHaveLength(1);
    const params = findingsBranchCalls()[0];
    expect(toolNames(params)).toEqual(["submit_findings"]);
  });

  it("calls fetch_file to investigate before finalizing findings", async () => {
    const { generateReview } = await loadGenerateReview();
    getFileContentMock.mockResolvedValue("export function foo() { return 1; }");
    wireResponses(
      [
        toolCallResponse([{ name: "fetch_file", args: { path: "src/lib/foo.ts" } }]),
        toolResponse("submit_findings", {
          findings: [
            {
              severity: "high",
              category: "bug",
              file: "src/lib/foo.ts",
              title: "missing null check",
              explanation: "confirmed by reading the full function body via fetch_file",
            },
          ],
        }),
      ],
      { verdict: "comment", summary: "Needs a null check." },
    );

    const result = await generateReview("diff --git a/foo b/foo", { repoContext: SAMPLE_REPO_CONTEXT });

    expect(result.findings).toHaveLength(1);
    expect(getFileContentMock).toHaveBeenCalledWith(1, "acme", "widgets", "src/lib/foo.ts", "deadbeef");

    const calls = findingsBranchCalls();
    expect(calls).toHaveLength(2); // fetch_file round + final submit
    const secondParams = calls[1];
    const toolMsg = secondParams.messages.find((m) => m.role === "tool") as unknown as {
      tool_call_id: string;
      content: string;
    };
    expect(toolMsg?.tool_call_id).toBe("call_0");
    expect(toolMsg?.content).toContain("export function foo");
  });

  it("forces submit_findings once the tool-call round cap is reached", async () => {
    const { generateReview, MAX_FINDINGS_TOOL_ROUNDS } = await loadGenerateReview();
    getFileContentMock.mockResolvedValue("some content");
    const fetchFileRound = toolCallResponse([{ name: "fetch_file", args: { path: "src/f.ts" } }]);
    wireResponses(
      [fetchFileRound, fetchFileRound, fetchFileRound, toolResponse("submit_findings", { findings: [] })],
      { verdict: "approve", summary: "fine" },
    );

    const result = await generateReview("diff --git a/x b/x", { repoContext: SAMPLE_REPO_CONTEXT });

    expect(result.findings).toHaveLength(0);
    const calls = findingsBranchCalls();
    expect(calls).toHaveLength(MAX_FINDINGS_TOOL_ROUNDS + 1);
    const finalParams = calls[MAX_FINDINGS_TOOL_ROUNDS] as { tool_choice: unknown; tools: unknown[] } & CreateParams;
    expect(finalParams.tool_choice).toEqual({ type: "function", function: { name: "submit_findings" } });
    expect(finalParams.tools).toHaveLength(1); // fetch_file no longer offered
  });

  it("reaches submit_findings after fetch_file fails on a nonexistent path", async () => {
    const { generateReview } = await loadGenerateReview();
    getFileContentMock.mockResolvedValue(undefined);
    wireResponses(
      [
        toolCallResponse([{ name: "fetch_file", args: { path: "src/does/not/exist.ts" } }]),
        toolResponse("submit_findings", { findings: [] }),
      ],
      { verdict: "approve", summary: "fine" },
    );

    const result = await generateReview("diff --git a/x b/x", { repoContext: SAMPLE_REPO_CONTEXT });

    expect(result.findings).toHaveLength(0);
    const calls = findingsBranchCalls();
    const secondParams = calls[1];
    const toolMsg = secondParams.messages.find((m) => m.role === "tool") as unknown as { content: string };
    expect(toolMsg?.content).toContain("could not read");
  });
});
