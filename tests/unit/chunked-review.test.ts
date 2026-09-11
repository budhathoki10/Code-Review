import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PullRequestFile } from "@/lib/github/diff";
import type { ChunkCheckpoint } from "@/lib/ai/review";

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
  chat_template_kwargs?: { thinking: boolean; enable_thinking: boolean };
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
  // Retry timing is real in production and pointless here: without this the
  // suite sleeps 13.5s for every simulated outage. The retry COUNT is
  // unchanged, so what these tests assert about call budgets still holds.
  process.env.REVIEW_CHUNK_RETRY_DELAYS_MS ??= "0,0,0";
  return import("@/lib/ai/review");
}

describe("generateChunkedReview failure isolation", () => {
  beforeEach(() => {
    createMock.mockReset();
    getFileContentMock.mockReset();
    delete process.env.REVIEW_MAX_BISECT_ATTEMPTS;
  });

  it("resumes saved chunks across work windows and invalidates changed input", async () => {
    const { generateChunkedReview } = await loadModule();
    createMock.mockResolvedValue(toolResponse("submit_findings", { findings: [] }));
    const saved: NonNullable<Parameters<typeof generateChunkedReview>[1]>["completedChunks"] = {};
    const onChunkComplete = vi.fn(async (key, result) => { saved[key] = result; });
    const chunks = [[file("src/a.ts")], [file("src/b.ts")], [file("src/d.ts")]];
    const options = { completedChunks: saved, onChunkComplete, maxChunksPerAttempt: 1 };
    const first = await generateChunkedReview(chunks, options);
    expect(first.unreviewedFiles).toEqual(["src/b.ts", "src/d.ts"]);
    const second = await generateChunkedReview(chunks, options);
    expect(second.unreviewedFiles).toEqual(["src/d.ts"]);
    const third = await generateChunkedReview(chunks, options);
    expect(third.unreviewedFiles).toEqual([]);
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(third.usage.calls).toBe(1);
    chunks[0][0].patch += "\n+changed again";
    await generateChunkedReview(chunks, options);
    expect(createMock).toHaveBeenCalledTimes(4);
    expect(onChunkComplete).toHaveBeenCalledTimes(4);
  });

  it("retries only failed chunks after a transient provider error", async () => {
    const { generateChunkedReview } = await loadModule();
    const saved: NonNullable<Parameters<typeof generateChunkedReview>[1]>["completedChunks"] = {};
    let broken = true;
    createMock.mockImplementation((params: CreateParams) => {
      if (broken && userContent(params).includes("src/b.ts")) throw Object.assign(new Error("outage"), { status: 503 });
      return Promise.resolve(toolResponse("submit_findings", { findings: [] }));
    });
    const options = { completedChunks: saved, onChunkComplete: async (key: string, result: ChunkCheckpoint) => { saved[key] = result; } };
    const chunks = [[file("src/a.ts")], [file("src/b.ts")]];
    const first = await generateChunkedReview(chunks, options);
    expect(first.unreviewedFiles).toEqual(["src/b.ts"]);
    const calls = createMock.mock.calls.length;
    broken = false;
    expect((await generateChunkedReview(chunks, options)).unreviewedFiles).toEqual([]);
    expect(createMock).toHaveBeenCalledTimes(calls + 1);
  });

  it("continues from retained reasoning after output exhaustion without rerunning the file", async () => {
    const { generateChunkedReview } = await loadModule();
    let findingsCalls = 0;
    createMock.mockImplementation((params: CreateParams) => {
      if (toolNames(params).includes("submit_verdict")) {
        return Promise.resolve(toolResponse("submit_verdict", { verdict: "comment", summary: "Reviewed." }));
      }
      findingsCalls++;
      if (findingsCalls === 1) {
        return Promise.resolve({ choices: [{ finish_reason: "length", message: { content: "analysis up to the cutoff" } }] });
      }
      expect(params.messages.some((message) => message.role === "assistant" && message.content === "analysis up to the cutoff")).toBe(true);
      expect(params.messages.some((message) => message.role === "user" && message.content.includes("Do not repeat"))).toBe(true);
      expect(params.chat_template_kwargs).toEqual({ thinking: false, enable_thinking: false });
      return Promise.resolve(toolResponse("submit_findings", { findings: [] }));
    });
    const result = await generateChunkedReview([[file("src/large.ts")]]);
    expect(result.unreviewedFiles).toEqual([]);
    expect(findingsCalls).toBe(2);
  });

  it("splits a single file when a truncated response has no reusable continuation", async () => {
    const { generateChunkedReview } = await loadModule();
    const patch = "@@ -0,0 +1,200 @@\n" + Array.from({ length: 200 }, (_, i) => `+const value${i} = ${i};`).join("\n");
    createMock.mockImplementation((params: CreateParams) => {
      const body = userContent(params);
      if (body.includes("value0 =") && body.includes("value199 =")) return Promise.resolve({ choices: [{ finish_reason: "length", message: { content: null } }] });
      return Promise.resolve(toolResponse("submit_findings", { findings: [] }));
    });
    const result = await generateChunkedReview([[{ filename: "src/large.ts", status: "added", patch }]]);
    expect(result.unreviewedFiles).toEqual([]);
    expect(createMock.mock.calls.length).toBeGreaterThan(1);
    expect(createMock.mock.calls.some(([params]) => userContent(params).includes("value199 =") && !userContent(params).includes("value0 ="))).toBe(true);
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
  beforeEach(() => {
    createMock.mockReset();
    getFileContentMock.mockReset();
    delete process.env.REVIEW_FINDINGS_TOOL_ROUNDS;
    delete process.env.REVIEW_PROVIDER_FAILURE_THRESHOLD;
    delete process.env.REVIEW_CHUNK_CONCURRENCY;
  });
  afterEach(() => { vi.useRealTimers(); });

  it.each([429, 500])("retries provider status %s, then stops without starting queued work", async (status) => {
    const { generateChunkedReview } = await loadModule();
    createMock.mockRejectedValue(Object.assign(new Error("provider unavailable"), { status }));
    const result = await generateChunkedReview([[file("src/a.ts"), file("src/b.ts")], [file("src/d.ts")], [file("src/poison.ts")]]);

    // A refusal is retried — that is the point — but the review-wide failure
    // budget still stops a dead endpoint being paid for once per chunk, and
    // the chunk is never split (splitting cannot repair a 500).
    expect(createMock.mock.calls.length).toBeLessThanOrEqual(12);
    expect(result.unreviewedFiles).toHaveLength(4);
    expect(result.verdict).toBe("comment");
  });

  it("switches to the backup model on the very next attempt after a 503, instead of retrying the overloaded model", async () => {
    // Measured live against NVIDIA 2026-09-09: an overloaded model answers
    // with a 503 after 100+ seconds, not instantly, so retrying it unchanged
    // pays that wait again for nothing. A 503 gets the same immediate-failover
    // treatment as a timeout, not the generic refusal retry.
    const { generateChunkedReview, BACKUP_MODEL } = await loadModule();
    createMock
      .mockRejectedValueOnce(Object.assign(new Error("overloaded"), { status: 503 }))
      .mockResolvedValue(toolResponse("submit_findings", { findings: [] }));

    const result = await generateChunkedReview([[file("src/a.ts")]]);

    expect(result.unreviewedFiles).toEqual([]);
    const modelsTried = createMock.mock.calls.map((call) => (call[0] as { model: string }).model);
    expect(modelsTried).toHaveLength(2);
    expect(modelsTried[1]).toBe(BACKUP_MODEL);
  });

  it("does not retry a 401 — the next identical request earns the same answer", async () => {
    const { generateChunkedReview } = await loadModule();
    createMock.mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));
    // More chunks than run concurrently, so the fatal latch has later chunks
    // left to stop — with only as many chunks as workers every one is already
    // in flight before the first 401 lands, and the test would pass on the
    // concurrency limit alone without the latch doing anything.
    const chunks = Array.from({ length: 10 }, (_, i) => [file(`src/f${i}.ts`)]);
    const result = await generateChunkedReview(chunks);

    // Our own credentials, not the provider's capacity: retrying each chunk
    // and falling back to another model proves the same thing many times
    // over. One call per chunk that started, and nothing started after.
    expect(createMock.mock.calls.length).toBeLessThanOrEqual(4);
    expect(result.unreviewedFiles).toHaveLength(10);
  });

  it("recovers a chunk that hit a single transient provider failure", async () => {
    // One 500 is not an outage. This chunk used to be abandoned outright and
    // its file reported unreviewed, so a blip silently cost a whole file's
    // review; it is now re-sent and lands.
    const { generateChunkedReview } = await loadModule();
    createMock
      .mockRejectedValueOnce(Object.assign(new Error("blip"), { status: 500 }))
      .mockResolvedValue(toolResponse("submit_findings", { findings: [] }));

    const result = await generateChunkedReview([[file("src/a.ts")], [file("src/b.ts")], [file("src/c.ts")]]);

    expect(result.unreviewedFiles).toEqual([]);
    expect(createMock.mock.calls.length).toBeGreaterThan(3);
  });

  it("does not let separated transient failures abandon later chunks", async () => {
    process.env.REVIEW_PROVIDER_FAILURE_THRESHOLD = "2";
    process.env.REVIEW_CHUNK_CONCURRENCY = "1";
    const { generateChunkedReview } = await loadModule();
    createMock.mockImplementation((params: CreateParams) => {
      const content = userContent(params);
      if (content.includes("src/a.ts") || content.includes("src/c.ts")) {
        throw Object.assign(new Error("intermittent refusal"), { status: 500 });
      }
      return Promise.resolve(toolResponse("submit_findings", { findings: [] }));
    });

    const result = await generateChunkedReview([
      [file("src/a.ts")], [file("src/b.ts")], [file("src/c.ts")], [file("src/d.ts")],
    ]);

    expect(result.unreviewedFiles).toEqual(["src/a.ts", "src/c.ts"]);
    expect(createMock.mock.calls.some(([params]) => userContent(params as CreateParams).includes("src/d.ts"))).toBe(true);
  });

  it("falls back to the backup model when the primary keeps refusing", async () => {
    const { generateChunkedReview, BACKUP_MODEL } = await loadModule();
    // Every attempt on the primary fails; the last attempt switches model and
    // is answered.
    createMock
      .mockRejectedValueOnce(Object.assign(new Error("down"), { status: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error("down"), { status: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error("down"), { status: 500 }))
      .mockResolvedValue(toolResponse("submit_findings", { findings: [] }));

    const result = await generateChunkedReview([[file("src/a.ts")]]);

    expect(result.unreviewedFiles).toEqual([]);
    const modelsTried = createMock.mock.calls.map((call) => (call[0] as { model: string }).model);
    expect(modelsTried.at(-1)).toBe(BACKUP_MODEL);
  });

  it("switches to the backup model on the very next attempt after a timeout", async () => {
    // The regression this pins cost PR #100 its entire review: the primary
    // model timed out, the retry re-sent the same request to the same model,
    // and between them they spent the whole deadline to report 0 of 23 files.
    // A model too slow for an input does not get faster on a second identical
    // request, so the failover has to happen immediately, not on attempt four.
    const { APIConnectionTimeoutError } = await import("openai/core/error");
    const { generateChunkedReview, BACKUP_MODEL } = await loadModule();
    createMock
      .mockRejectedValueOnce(new APIConnectionTimeoutError({}))
      .mockResolvedValue(toolResponse("submit_findings", { findings: [] }));

    const result = await generateChunkedReview([[file("src/a.ts")]]);

    expect(result.unreviewedFiles).toEqual([]);
    const modelsTried = createMock.mock.calls.map((call) => (call[0] as { model: string }).model);
    expect(modelsTried).toHaveLength(2);
    expect(modelsTried[1]).toBe(BACKUP_MODEL);
  });

  it("gives no single attempt most of the remaining review budget", async () => {
    // The other half of the same failure: a 300s per-request ceiling inside a
    // 420s review let one call hold 71% of it and the retry take the rest.
    const { generateChunkedReview } = await loadModule();
    createMock.mockResolvedValue(toolResponse("submit_findings", { findings: [] }));

    const budgetMs = 200_000;
    await generateChunkedReview([[file("src/a.ts")]], { deadlineAt: Date.now() + budgetMs });

    const requestOptions = (createMock.mock.calls[0] as unknown[])[1] as { timeout: number };
    expect(requestOptions.timeout).toBeLessThan(budgetMs * 0.5);
    expect(requestOptions.timeout).toBeGreaterThan(0);
  });

  it("abandons the review once provider failures repeat", async () => {
    const { generateChunkedReview } = await loadModule();
    createMock.mockRejectedValue(Object.assign(new Error("down"), { status: 503 }));

    const result = await generateChunkedReview([[file("src/a.ts")], [file("src/b.ts")], [file("src/c.ts")]]);

    // Retries are bounded per chunk, and once the shared failure budget is
    // reached no further chunk is attempted at all.
    expect(createMock.mock.calls.length).toBeLessThanOrEqual(12);
    expect(result.unreviewedFiles).toHaveLength(3);
  });

  it("runs unbounded when the caller passes no deadline", async () => {
    // The pipeline always supplies a deadline; a caller that omits one is
    // asking for no limit, and substituting a default made that inexpressible.
    const { generateChunkedReview } = await loadModule();
    createMock.mockResolvedValue(toolResponse("submit_findings", { findings: [] }));

    const result = await generateChunkedReview([[file("src/a.ts")]]);

    expect(result.unreviewedFiles).toHaveLength(0);
    // No deadline means no abort signal on the request — the call is allowed
    // to take as long as it takes.
    const requestOptions = (createMock.mock.calls[0] as unknown[])[1] as { signal?: AbortSignal } | undefined;
    expect(requestOptions?.signal).toBeUndefined();
  });

  it("retries real SDK connection and timeout errors without splitting the chunk", async () => {
    const { APIConnectionTimeoutError, APIConnectionError } = await import("openai/core/error");
    const { generateChunkedReview } = await loadModule();
    for (const error of [new APIConnectionTimeoutError({}), new APIConnectionError({})]) {
      createMock.mockReset().mockRejectedValue(error);
      const result = await generateChunkedReview([[file("src/a.ts"), file("src/b.ts")]]);
      // A timeout means this model is too slow for this input, on the primary
      // as much as the backup: one attempt on each, then give up rather than
      // retrying the backup against the same input it already proved too
      // slow for — that retry cannot succeed and only spends budget the
      // chunks still waiting need.
      expect(createMock.mock.calls.length).toBe(2);
      expect(result.unreviewedFiles).toHaveLength(2);
      expect(result.usage.calls).toBe(2);
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
