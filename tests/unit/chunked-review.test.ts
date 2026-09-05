import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

vi.mock("@/lib/github/file-content", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFileContent: getFileContentMock,
}));

function toolResponse(name: string, args: unknown) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: "call_0", type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  };
}

interface CreateParams {
  tools?: { function: { name: string } }[];
  messages: { role: string; content: string }[];
}

function toolNames(params: CreateParams): string[] {
  return params.tools?.map((t) => t.function.name) ?? [];
}

/** The diff text a chunk was rendered into — used to see which files a findings call actually received. */
function userContent(params: CreateParams): string {
  return params.messages.find((m) => m.role === "user")?.content ?? "";
}

function file(name: string): PullRequestFile {
  return {
    filename: name,
    status: "modified",
    patch: ["@@ -1,2 +1,3 @@", " context", `+// change in ${name}`].join("\n"),
  };
}

function finding(file: string) {
  return {
    severity: "medium" as const,
    category: "quality" as const,
    file,
    line: 2,
    title: `issue in ${file}`,
    explanation: "example explanation",
  };
}

/**
 * Routes findings-branch calls through `onFindings`, which receives the file
 * names present in that call's rendered diff and either throws (simulating a
 * chunk the model derails on) or returns the findings to submit.
 */
function wireChunked(onFindings: (files: string[]) => unknown[], verdictArgs: unknown) {
  createMock.mockImplementation((params: CreateParams) => {
    const names = toolNames(params);
    if (names.includes("submit_verdict")) {
      return Promise.resolve(toolResponse("submit_verdict", verdictArgs));
    }
    if (names.includes("submit_findings")) {
      const content = userContent(params);
      const present = ALL_FILES.filter((name) => content.includes(name));
      // Throwing synchronously inside mockImplementation surfaces as a
      // rejected promise from the awaited call, same as a provider error.
      return Promise.resolve(toolResponse("submit_findings", { findings: onFindings(present) }));
    }
    throw new Error(`unexpected tools: ${names.join(",")}`);
  });
}

const ALL_FILES = ["src/a.ts", "src/b.ts", "src/poison.ts", "src/d.ts"];

const SAMPLE_REPO_CONTEXT = { installationId: 1, owner: "acme", repo: "widgets", ref: "deadbeef" };

async function loadModule() {
  vi.resetModules();
  process.env.NVIDIA_API_KEY = "test-key";
  process.env.NVIDIA_BASE_URL = "https://example.test/v1";
  return import("@/lib/ai/review");
}

describe("generateChunkedReview failure isolation", () => {
  beforeEach(() => {
    createMock.mockReset();
    getFileContentMock.mockReset();
    delete process.env.REVIEW_MAX_BISECT_ATTEMPTS;
  });

  it("salvages the other files when one file in a chunk fails the findings pass", async () => {
    const { generateChunkedReview } = await loadModule();
    wireChunked(
      (files) => {
        if (files.includes("src/poison.ts")) throw new Error("model derailed on poison.ts");
        return files.map(finding);
      },
      { verdict: "comment", summary: "Reviewed." },
    );

    const result = await generateChunkedReview([ALL_FILES.map(file)]);

    // The three healthy files are still reviewed...
    expect(result.findings.map((f) => f.file).sort()).toEqual(["src/a.ts", "src/b.ts", "src/d.ts"]);
    // ...and the one that could not be reviewed is named, never silently dropped.
    expect(result.unreviewedFiles).toEqual(["src/poison.ts"]);
  });

  it("does not fail the review when an entire chunk fails at every split", async () => {
    const { generateChunkedReview } = await loadModule();
    wireChunked(
      () => {
        throw new Error("provider is down");
      },
      { verdict: "comment", summary: "Reviewed." },
    );

    const result = await generateChunkedReview([ALL_FILES.map(file)]);

    expect(result.findings).toEqual([]);
    expect(result.unreviewedFiles.sort()).toEqual([...ALL_FILES].sort());
    expect(result.summary).toContain("Review incomplete");
    expect(result.verdict).toBe("comment");
  });

  it("stops splitting once the shared bisect budget is exhausted", async () => {
    process.env.REVIEW_MAX_BISECT_ATTEMPTS = "2";
    const { generateChunkedReview } = await loadModule();
    wireChunked(
      () => {
        throw new Error("provider is down");
      },
      { verdict: "comment", summary: "Reviewed." },
    );

    await generateChunkedReview([ALL_FILES.map(file)]);

    // Budget 2 allows exactly one split: the initial attempt plus the two
    // halves it produced. Without the budget this would walk the whole tree.
    const findingsCalls = createMock.mock.calls
      .map((call: unknown[]) => call[0] as CreateParams)
      .filter((params) => toolNames(params).includes("submit_findings"));
    expect(findingsCalls).toHaveLength(3);
  });

  it("never splits a chunk at a text offset — every retry re-renders whole files", async () => {
    const { generateChunkedReview } = await loadModule();
    const seen: string[][] = [];
    wireChunked(
      (files) => {
        seen.push(files);
        if (files.includes("src/poison.ts")) throw new Error("model derailed");
        return [];
      },
      { verdict: "approve", summary: "Fine." },
    );

    await generateChunkedReview([ALL_FILES.map(file)]);

    // Every call's rendered diff contains only complete file patches, so no
    // retry ever saw a hunk cut in half.
    const findingsCalls = createMock.mock.calls
      .map((call: unknown[]) => call[0] as CreateParams)
      .filter((params) => toolNames(params).includes("submit_findings"));
    for (const params of findingsCalls) {
      const content = userContent(params);
      const headers = content.match(/^--- a\//gm) ?? [];
      const hunks = content.match(/^@@ /gm) ?? [];
      expect(headers.length).toBe(hunks.length);
    }
    expect(seen.length).toBeGreaterThan(1);
  });

  it("counts tokens spent on failed attempts, not just successful ones", async () => {
    const { generateChunkedReview } = await loadModule();
    createMock.mockImplementation((params: CreateParams) => {
      const names = toolNames(params);
      if (names.includes("submit_verdict")) {
        return Promise.resolve({
          ...toolResponse("submit_verdict", { verdict: "comment", summary: "Reviewed." }),
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }
      // Every findings call reports usage and then fails validation.
      return Promise.resolve({
        choices: [{ message: { content: "no tool call", tool_calls: [] } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      });
    });

    const result = await generateChunkedReview([[file("src/a.ts"), file("src/b.ts")]]);

    expect(result.unreviewedFiles.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    // 15 from the verdict call plus every failed findings attempt's tokens.
    expect(result.usage.totalTokens).toBeGreaterThan(15);
  });

  it("keeps serious candidates advisory until pipeline verification", async () => {
    const { generateChunkedReview } = await loadModule();
    wireChunked(
      (files) =>
        files.includes("src/d.ts")
          ? [{ ...finding("src/d.ts"), severity: "critical" as const }]
          : [],
      { verdict: "approve", summary: "Looks fine to me." },
    );

    const result = await generateChunkedReview([[file("src/a.ts")], [file("src/d.ts")]]);

    expect(result.findings[0].severity).toBe("critical");
    expect(result.verdict).toBe("comment");
    expect(createMock.mock.calls.every(([params]) => !toolNames(params).includes("submit_verdict"))).toBe(true);
  });
});

describe("bisect budget is a hard cap, not an observed number", () => {
  beforeEach(() => {
    createMock.mockReset();
    getFileContentMock.mockReset();
    delete process.env.REVIEW_MAX_BISECT_ATTEMPTS;
  });

  /**
   * The pathological case: every chunk fails, and every findings attempt
   * burns its full tool-calling round budget before failing (the model
   * answers with prose instead of a tool call, so the loop uses all
   * MAX_FINDINGS_TOOL_ROUNDS + 1 rounds and then throws).
   *
   * This is what actually bounds a review's cost, and it is NOT the bisect
   * budget on its own: the budget counts ATTEMPTS, and each attempt is up to
   * 4 provider calls.
   */
  it("bounds total provider calls even when every attempt burns every round", async () => {
    const { generateChunkedReview, MAX_FINDINGS_TOOL_ROUNDS } = await loadModule();

    createMock.mockImplementation((params: CreateParams) => {
      const names = toolNames(params);
      if (names.includes("submit_verdict")) {
        return Promise.resolve(toolResponse("submit_verdict", { verdict: "comment", summary: "S" }));
      }
      // Never a tool call: forces the findings loop to use every round.
      return Promise.resolve({ choices: [{ message: { content: "prose, not a tool call", tool_calls: [] } }] });
    });

    // 4 chunks of 8 files each — the shape MAX_REVIEW_CHUNKS allows.
    const chunks = Array.from({ length: 4 }, (_, c) =>
      Array.from({ length: 8 }, (_, i) => file(`src/c${c}f${i}.ts`)),
    );

    const result = await generateChunkedReview(chunks, { repoContext: SAMPLE_REPO_CONTEXT });

    const all = createMock.mock.calls.map((call: unknown[]) => call[0] as CreateParams);
    const findingsCalls = all.filter((p) => toolNames(p).includes("submit_findings")).length;
    const verdictCalls = all.filter((p) => toolNames(p).includes("submit_verdict")).length;

    const roundsPerAttempt = MAX_FINDINGS_TOOL_ROUNDS + 1;
    const budget = 12;
    const rootAttempts = 4;
    const ceiling = (rootAttempts + budget) * roundsPerAttempt + 1;

     
    console.log(
      `\n  PATHOLOGICAL WORST CASE\n` +
        `    rounds per attempt : ${roundsPerAttempt}\n` +
        `    root attempts      : ${rootAttempts} (one per chunk)\n` +
        `    bisect attempts    : ${budget} (REVIEW_MAX_BISECT_ATTEMPTS)\n` +
        `    findings calls     : ${findingsCalls}\n` +
        `    verdict calls      : ${verdictCalls}\n` +
        `    TOTAL PROVIDER CALLS: ${findingsCalls + verdictCalls}  (arithmetic ceiling ${ceiling})\n`,
    );

    expect(findingsCalls + verdictCalls).toBeLessThanOrEqual(ceiling);
    // Every file is accounted for despite total failure.
    expect(result.unreviewedFiles).toHaveLength(32);
  });
});

describe("bisect budget scoping", () => {
  beforeEach(() => {
    createMock.mockReset();
    getFileContentMock.mockReset();
    process.env.REVIEW_MAX_BISECT_ATTEMPTS = "2";
  });

  afterEach(() => {
    delete process.env.REVIEW_MAX_BISECT_ATTEMPTS;
  });

  /**
   * The budget is a local created inside generateChunkedReview, so two
   * reviews running at once on the same worker (concurrency is 5) cannot
   * consume each other's retries. If it were module state, the second review
   * would find it already drained and give up without splitting at all.
   */
  it("gives each concurrent review its own budget", async () => {
    const { generateChunkedReview } = await loadModule();
    wireChunked(
      () => {
        throw new Error("provider is down");
      },
      { verdict: "comment", summary: "S" },
    );

    const files = () => [file("src/a.ts"), file("src/b.ts"), file("src/c.ts"), file("src/d.ts")];
    await Promise.all([generateChunkedReview([files()]), generateChunkedReview([files()])]);

    const findingsCalls = createMock.mock.calls
      .map((call: unknown[]) => call[0] as CreateParams)
      .filter((params) => toolNames(params).includes("submit_findings")).length;

    // Budget 2 buys one split per review: 1 root attempt + 2 halves = 3 each,
    // 6 across both. A shared budget would give 3 + 1 = 4.
    expect(findingsCalls).toBe(6);
  });

  /**
   * Each attempt calls generateChunkedReview afresh, so the budget starts
   * full again on a BullMQ retry. That is correct for isolation and is
   * exactly why a retry that re-runs generation is expensive — which is what
   * ReviewDoc.aiCheckpoint exists to prevent.
   */
  it("starts a fresh budget on each invocation, as a retry would", async () => {
    const { generateChunkedReview } = await loadModule();
    wireChunked(
      () => {
        throw new Error("provider is down");
      },
      { verdict: "comment", summary: "S" },
    );

    const files = () => [file("src/a.ts"), file("src/b.ts"), file("src/c.ts"), file("src/d.ts")];

    await generateChunkedReview([files()]);
    const afterFirst = createMock.mock.calls.length;
    await generateChunkedReview([files()]);
    const afterSecond = createMock.mock.calls.length;

    expect(afterSecond - afterFirst).toBe(afterFirst);
  });
});


describe("predictable discovery budget", () => {
  beforeEach(() => { createMock.mockReset(); getFileContentMock.mockReset(); delete process.env.REVIEW_FINDINGS_TOOL_ROUNDS; });
  afterEach(() => { vi.useRealTimers(); });

  it.each([429, 500, 503, 401])("does not split provider status %s or start queued work", async (status) => {
    const { generateChunkedReview } = await loadModule();
    createMock.mockRejectedValue(Object.assign(new Error("provider unavailable"), { status }));
    const result = await generateChunkedReview([[file("src/a.ts"), file("src/b.ts")], [file("src/d.ts")], [file("src/poison.ts")]]);
    expect(createMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(result.unreviewedFiles).toHaveLength(4);
    expect(result.verdict).toBe("comment");
  });

  it("does not split real SDK connection and timeout errors", async () => {
    const { APIConnectionTimeoutError, APIConnectionError } = await import("openai/core/error");
    const { generateChunkedReview } = await loadModule();
    for (const error of [new APIConnectionTimeoutError({}), new APIConnectionError({})]) {
      createMock.mockReset().mockRejectedValue(error);
      const result = await generateChunkedReview([[file("src/a.ts"), file("src/b.ts")]]);
      expect(createMock).toHaveBeenCalledTimes(1);
      expect(result.unreviewedFiles).toHaveLength(2);
      expect(result.usage.calls).toBe(1);
    }
  });

  it("makes no calls after the shared deadline", async () => {
    const { generateChunkedReview } = await loadModule();
    const result = await generateChunkedReview([[file("src/a.ts")]], { deadlineAt: Date.now() - 1 });
    expect(createMock).not.toHaveBeenCalled();
    expect(result.unreviewedFiles).toEqual(["src/a.ts"]);
    expect(result.verdict).toBe("comment");
  });

  it("limits each request to remaining time and disables hidden SDK retries", async () => {
    const { generateChunkedReview } = await loadModule();
    wireChunked(() => [], {});
    await generateChunkedReview([[file("src/a.ts")]], { deadlineAt: Date.now() + 2000 });
    const options = createMock.mock.calls[0][1];
    expect(options.maxRetries).toBe(0);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(2000);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("starts the second chunk while the first is still running", async () => {
    const { generateChunkedReview } = await loadModule();
    let release!: (value: unknown) => void;
    createMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValue(toolResponse("submit_findings", { findings: [] }));
    const review = generateChunkedReview([[file("src/a.ts")], [file("src/b.ts")]]);
    expect(createMock).toHaveBeenCalledTimes(2);
    release(toolResponse("submit_findings", { findings: [] }));
    await review;
  });
});
