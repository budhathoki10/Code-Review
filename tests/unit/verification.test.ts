import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { FindingDoc } from "@/lib/db/collections";
import { findingId, canBlock, dedupeFindings } from "@/lib/review/finding-policy";
import { feedbackStats } from "@/lib/review/feedback";

const { create, fetchFile } = vi.hoisted(() => ({ create: vi.fn(), fetchFile: vi.fn() }));
vi.mock("@/lib/ai/review", () => ({ DEFAULT_MODEL: "test-model", getClient: () => ({ chat: { completions: { create } } }), thinkingKwargs: () => ({}) }));
vi.mock("@/lib/github/file-content", () => ({ getFileContent: fetchFile }));
import { verifyBlockingFindings } from "@/lib/review/verification";

const context = { installationId: 1, owner: "test", repo: "repo", ref: "head-sha" };
const finding: FindingDoc = { file: "src/math.ts", line: 2, title: "Division by zero", explanation: "Zero is not handled.", category: "bug", severity: "high" };
const file = { filename: finding.file, status: "modified", patch: "@@ -1,3 +1,3 @@\n export function divide(x) {\n-  return x ? 10 / x : 0;\n+  return 10 / x;\n }" };
const source = "export function divide(x) {\n  return 10 / x;\n}\n";
const evidence = [{ file: finding.file, line: 2, quote: "  return 10 / x;" }];
function response(decisions: unknown[]) {
  return { usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 }, choices: [{ message: { tool_calls: [{ type: "function", function: { name: "submit_verification", arguments: JSON.stringify({ decisions }) } }] } }] };
}
function decision(overrides = {}) { return { id: findingId(finding), decision: "accept", reason: "Zero reaches the division after the guard removal.", evidence, ...overrides }; }

beforeEach(() => { vi.clearAllMocks(); fetchFile.mockResolvedValue(source); create.mockResolvedValue(response([decision()])); });
afterEach(() => vi.unstubAllEnvs());

describe("bounded blocking verification", () => {
  it("skips all paid work after the review deadline", async () => {
    const result = await verifyBlockingFindings([finding], [file], context, undefined, Date.now() - 1);
    expect(create).not.toHaveBeenCalled();
    expect(fetchFile).not.toHaveBeenCalled();
    expect(canBlock(result.findings[0])).toBe(false);
  });
  it("shrinks source context to fit instead of dropping a verifiable candidate", async () => {
    vi.stubEnv("REVIEW_VERIFICATION_TOKEN_BUDGET", "8000");
    fetchFile.mockResolvedValue(source + ("x".repeat(400) + "\n").repeat(20));
    const result = await verifyBlockingFindings([finding], [file], context);
    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0][0];
    expect(JSON.parse(params.messages[1].content)[0].headContext.length).toBeLessThan(4500);
    expect(Buffer.byteLength(JSON.stringify(params), "utf8") + params.max_tokens + 512).toBeLessThanOrEqual(8000);
    expect(canBlock(result.findings[0])).toBe(true);
  });
  it("spends no calls or file reads without high/critical findings", async () => {
    const result = await verifyBlockingFindings([{ ...finding, severity: "medium" }], [file], context);
    expect(result.usage.calls).toBe(0);
    expect(create).not.toHaveBeenCalled(); expect(fetchFile).not.toHaveBeenCalled();
  });
  it("deduplicates before fetching or paying; preserves the higher severity", async () => {
    const result = await verifyBlockingFindings([finding, { ...finding, severity: "critical" }], [file], context);
    expect(create).toHaveBeenCalledTimes(1); expect(fetchFile).toHaveBeenCalledTimes(1);
    expect(result.findings).toHaveLength(1); expect(result.findings[0].severity).toBe("critical");
    expect(canBlock(result.findings[0])).toBe(true);
    expect(result.usage.totalTokens).toBe(600);
  });
  it("sends focused source, pins the SHA and disables SDK retries", async () => {
    fetchFile.mockResolvedValue(source + "\n".repeat(100) + "UNRELATED_PRIVATE_CONTEXT");
    await verifyBlockingFindings([finding], [file, { filename: "unrelated.ts", status: "modified", patch: "UNRELATED_DIFF" }], context);
    const [params, options] = create.mock.calls[0];
    expect(JSON.stringify(params)).not.toContain("UNRELATED_PRIVATE_CONTEXT");
    expect(JSON.stringify(params)).not.toContain("UNRELATED_DIFF");
    expect(options).toMatchObject({ maxRetries: 0, timeout: 30000, signal: expect.any(AbortSignal) });
    expect(fetchFile).toHaveBeenCalledWith(1, "test", "repo", finding.file, "head-sha", { signal: expect.any(AbortSignal) });
  });
  it("does not accept invented evidence or a quote on the wrong line", async () => {
    create.mockResolvedValue(response([decision({ evidence: [{ ...evidence[0], line: 1 }] })]));
    const result = await verifyBlockingFindings([finding], [file], context);
    expect(result.findings[0].verification?.status).toBe("downgraded");
    expect(canBlock(result.findings[0])).toBe(false);
  });
  it("accepts an indentation-normalized quote while still checking its file and line", async () => {
    create.mockResolvedValue(response([decision({ evidence: [{ ...evidence[0], quote: evidence[0].quote.trim() }] })]));
    expect((await verifyBlockingFindings([finding], [file], context)).findings[0].verification?.status).toBe("accepted");
  });
  it("does not treat a different code expression as matching evidence", async () => {
    create.mockResolvedValue(response([decision({ evidence: [{ ...evidence[0], quote: "return 100 / x;" }] })]));
    expect((await verifyBlockingFindings([finding], [file], context)).findings[0].verification?.status).toBe("downgraded");
  });
  it("does not pay for an unanchored finding", async () => {
    const result = await verifyBlockingFindings([{ ...finding, line: undefined }], [file], context);
    expect(result.usage.calls).toBe(0); expect(create).not.toHaveBeenCalled(); expect(fetchFile).not.toHaveBeenCalled();
  });
  it("removes rejected findings but retains the assessment for audit", async () => {
    create.mockResolvedValue(response([decision({ decision: "reject", reason: "Caller excludes zero.", evidence: [] })]));
    const result = await verifyBlockingFindings([finding], [file], context);
    expect(result.findings).toEqual([]); expect(result.rejected).toHaveLength(1);
  });
  it("keeps missing decisions advisory", async () => {
    create.mockResolvedValue(response([]));
    const result = await verifyBlockingFindings([finding], [file], context);
    expect(result.findings[0].verification?.status).toBe("skipped");
    expect(canBlock(result.findings[0])).toBe(false);
  });
  it("rejects extra IDs and duplicate decisions without accepting any", async () => {
    for (const decisions of [[decision(), decision()], [decision(), decision({ id: "invented" })]]) {
      create.mockResolvedValue(response(decisions));
      const result = await verifyBlockingFindings([finding], [file], context);
      expect(result.findings[0].verification?.status).toBe("skipped");
      expect(result.usage.totalTokens).toBe(600);
    }
  });
  it("fails open to advisory on provider failure, with one accounted attempt", async () => {
    create.mockRejectedValue(new Error("429"));
    const result = await verifyBlockingFindings([finding], [file], context);
    expect(result.usage.calls).toBe(1); expect(canBlock(result.findings[0])).toBe(false);
  });
  it("a zero or tiny budget spends nothing", async () => {
    for (const budget of ["0", "100", "1000"]) {
      vi.stubEnv("REVIEW_VERIFICATION_TOKEN_BUDGET", budget);
      const result = await verifyBlockingFindings([finding], [file], context);
      expect(result.usage.calls).toBe(0);
    }
    expect(create).not.toHaveBeenCalled();
  });
  it("enforces both candidate and serialized request budgets", async () => {
    vi.stubEnv("REVIEW_VERIFICATION_MAX_FINDINGS", "1");
    const result = await verifyBlockingFindings([finding, { ...finding, title: "Second issue" }], [file], context);
    const params = create.mock.calls[0][0];
    expect(JSON.parse(params.messages[1].content)).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(params)) + params.max_tokens + 512).toBeLessThanOrEqual(12000);
    expect(result.findings.filter(canBlock)).toHaveLength(1);
  });
  it("never trusts a high severity or confidence without assessment", () => {
    expect(canBlock({ ...finding, confidence: "100%" })).toBe(false);
  });
  it("identifies duplicate wording across line moves without merging categories", () => {
    expect(dedupeFindings([finding, { ...finding, title: " division BY zero ", line: 10 }])).toHaveLength(1);
    expect(dedupeFindings([finding, { ...finding, category: "security" }])).toHaveLength(2);
  });
  it("does not fabricate false-positive rates from unlabelled findings", () => {
    expect(feedbackStats([{}]).falsePositiveRate).toBeNull();
    const feedback = { userId: "user", at: new Date() };
    expect(feedbackStats([
      { feedback: { ...feedback, label: "correct" } },
      { feedback: { ...feedback, label: "false-positive" } },
      { feedback: { ...feedback, label: "duplicate" } }, {},
    ])).toEqual({ correct: 1, falsePositive: 1, duplicate: 1, assessed: 2, falsePositiveRate: 0.5 });
  });
});
