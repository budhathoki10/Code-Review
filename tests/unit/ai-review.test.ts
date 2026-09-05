import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PullRequestFile } from "@/lib/github/diff";

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
  // The chunked path distinguishes a GitHub rate limit from a provider
  // failure, so the mock has to carry the real class.
  GitHubRateLimitError: class GitHubRateLimitError extends Error {},
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
function wireResponses(findingsResponses: unknown) {
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
    throw new Error(`unexpected tools in params: ${names.join(",")}`);
  });
}

/** Minimal file whose patch renders to the diff text these tests assert on. */
function file(name = "src/foo.ts"): PullRequestFile {
  return { filename: name, status: "modified", patch: `@@ -1,2 +1,3 @@
 context
+// change in ${name}` };
}

/**
 * `toolRounds` is explicit because REVIEW_FINDINGS_TOOL_ROUNDS defaults to 0
 * — every findings call is then a single forced submit_findings and
 * fetch_file is never offered. The investigation tests below are about that
 * loop, so they have to turn it on rather than inherit a default that
 * switches off the very behaviour under test.
 */
async function loadGenerateReview(toolRounds?: number) {
  vi.resetModules();
  process.env.NVIDIA_API_KEY = "test-key";
  process.env.NVIDIA_BASE_URL = "https://example.test/v1";
  if (toolRounds === undefined) delete process.env.REVIEW_FINDINGS_TOOL_ROUNDS;
  else process.env.REVIEW_FINDINGS_TOOL_ROUNDS = String(toolRounds);
  const mod = await import("@/lib/ai/review");
  return mod;
}

const SAMPLE_REPO_CONTEXT = { installationId: 1, owner: "acme", repo: "widgets", ref: "deadbeef" };

function findingsBranchCalls(): CreateParams[] {
  return createMock.mock.calls.map((call: unknown[]) => call[0] as CreateParams).filter((params) => toolNames(params).includes("submit_findings"));
}

describe("generateChunkedReview findings pass", () => {
  beforeEach(() => {
    createMock.mockReset();
    getFileContentMock.mockReset();
  });




  it("reports the file as unreviewed rather than failing the whole review", async () => {
    // A failed findings pass must not throw: the review still publishes, and
    // the file it could not read is named instead of silently omitted.
    const { generateChunkedReview } = await loadGenerateReview();
    createMock.mockRejectedValue(new Error("provider error"));

    const result = await generateChunkedReview([[file()]]);

    expect(result.unreviewedFiles).toEqual(["src/foo.ts"]);
    expect(result.findings).toHaveLength(0);
  });


  it("includes customInstructions in the findings request", async () => {
    const { generateChunkedReview } = await loadGenerateReview();
    wireResponses({ findings: [] });

    await generateChunkedReview([[file()]], { customInstructions: ["ignore generated files"] });

    expect(createMock).toHaveBeenCalledTimes(1);
    for (const call of createMock.mock.calls) {
      const params = call[0] as { messages: { role: string; content: string }[] };
      const userMessage = params.messages.find((m) => m.role === "user");
      expect(userMessage?.content).toContain("ignore generated files");
    }
  });

  it("includes static-analysis findings in the findings context, framed as already-reported", async () => {
    const { generateChunkedReview } = await loadGenerateReview();
    wireResponses({ findings: [] });

    await generateChunkedReview([[file()]], {
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

  it("includes PR title and description in the findings context", async () => {
    const { generateChunkedReview } = await loadGenerateReview();
    wireResponses({ findings: [] });

    await generateChunkedReview([[file()]], {
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
    const { generateChunkedReview } = await loadGenerateReview();
    wireResponses({ findings: [] });

    await generateChunkedReview([[file()]]);

    for (const call of createMock.mock.calls) {
      const params = call[0] as { messages: { role: string; content: string }[] };
      const userMessage = params.messages.find((m) => m.role === "user");
      expect(userMessage?.content).not.toContain("AUTOMATED LINT/STATIC-ANALYSIS FINDINGS");
      expect(userMessage?.content).not.toContain("PR TITLE:");
    }
  });

  it("does not offer fetch_file when no repoContext is provided (unchanged single-call behavior)", async () => {
    const { generateChunkedReview } = await loadGenerateReview();
    wireResponses({ findings: [] });

    await generateChunkedReview([[file()]]);

    expect(findingsBranchCalls()).toHaveLength(1);
    const params = findingsBranchCalls()[0];
    expect(toolNames(params)).toEqual(["submit_findings"]);
  });

  it("calls fetch_file to investigate before finalizing findings", async () => {
    const { generateChunkedReview } = await loadGenerateReview(3);
    getFileContentMock.mockResolvedValue("export function foo() { return 1; }");
    wireResponses([
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
    );

    const result = await generateChunkedReview([[file()]], { repoContext: SAMPLE_REPO_CONTEXT });

    expect(result.findings).toHaveLength(1);
    expect(getFileContentMock).toHaveBeenCalledWith(1, "acme", "widgets", "src/lib/foo.ts", "deadbeef", { signal: expect.any(AbortSignal) });

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
    const { generateChunkedReview, MAX_FINDINGS_TOOL_ROUNDS } = await loadGenerateReview(3);
    getFileContentMock.mockResolvedValue("some content");
    const fetchFileRound = toolCallResponse([{ name: "fetch_file", args: { path: "src/f.ts" } }]);
    wireResponses([fetchFileRound, fetchFileRound, fetchFileRound, toolResponse("submit_findings", { findings: [] })],
    );

    const result = await generateChunkedReview([[file()]], { repoContext: SAMPLE_REPO_CONTEXT });

    expect(result.findings).toHaveLength(0);
    const calls = findingsBranchCalls();
    expect(calls).toHaveLength(MAX_FINDINGS_TOOL_ROUNDS + 1);
    const finalParams = calls[MAX_FINDINGS_TOOL_ROUNDS] as { tool_choice: unknown; tools: unknown[] } & CreateParams;
    expect(finalParams.tool_choice).toEqual({ type: "function", function: { name: "submit_findings" } });
    expect(finalParams.tools).toHaveLength(1); // fetch_file no longer offered
  });

  it("accepts a findings array the model double-encoded as a JSON string", async () => {
    const { generateChunkedReview } = await loadGenerateReview();
    // Observed against the NVIDIA endpoint: `{"findings": "[{...}]"}` instead
    // of `{"findings": [{...}]}`. Deterministic per response, so BullMQ's
    // retries couldn't clear it and the review dead-lettered.
    wireResponses({
        findings: JSON.stringify([
          {
            severity: "low",
            category: "quality",
            file: "src/foo.ts",
            title: "nit",
            explanation: "minor style issue",
          },
        ]),
      },
    );

    const result = await generateChunkedReview([[file()]]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe("nit");
  });

  it("accepts an empty findings array double-encoded as a JSON string", async () => {
    const { generateChunkedReview } = await loadGenerateReview();
    wireResponses({ findings: "[]" });

    const result = await generateChunkedReview([[file()]]);

    expect(result.findings).toHaveLength(0);
    expect(result.verdict).toBe("approve");
  });

  it("does not accept a findings string that isn't valid JSON", async () => {
    // The double-encoding tolerance above must not become "accept anything":
    // an unparseable payload is a failed pass, reported as unreviewed.
    const { generateChunkedReview } = await loadGenerateReview();
    wireResponses({ findings: "no issues found" });

    const result = await generateChunkedReview([[file()]]);

    expect(result.findings).toHaveLength(0);
    expect(result.unreviewedFiles).toEqual(["src/foo.ts"]);
  });

  it("reaches submit_findings after fetch_file fails on a nonexistent path", async () => {
    const { generateChunkedReview } = await loadGenerateReview(3);
    getFileContentMock.mockResolvedValue(undefined);
    wireResponses([
        toolCallResponse([{ name: "fetch_file", args: { path: "src/does/not/exist.ts" } }]),
        toolResponse("submit_findings", { findings: [] }),
      ],
    );

    const result = await generateChunkedReview([[file()]], { repoContext: SAMPLE_REPO_CONTEXT });

    expect(result.findings).toHaveLength(0);
    const calls = findingsBranchCalls();
    const secondParams = calls[1];
    const toolMsg = secondParams.messages.find((m) => m.role === "tool") as unknown as { content: string };
    expect(toolMsg?.content).toContain("could not read");
  });
});
