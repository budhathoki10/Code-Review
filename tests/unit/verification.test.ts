import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { FindingDoc } from "@/lib/db/collections";
import { findingId, canBlock, dedupeFindings } from "@/lib/review/finding-policy";
import { feedbackStats } from "@/lib/review/feedback";

const { create, fetchFile, resolveFetchFile, proofImage, reproduce } = vi.hoisted(() => ({
  create: vi.fn(), fetchFile: vi.fn(), resolveFetchFile: vi.fn(), proofImage: vi.fn(), reproduce: vi.fn(),
}));
vi.mock("@/lib/ai/review", () => ({
  DEFAULT_MODEL: "test-model",
  getClient: () => ({ chat: { completions: { create } } }),
  thinkingKwargs: () => ({}),
  FETCH_FILE_TOOL: { type: "function", function: { name: "fetch_file", description: "", parameters: {} } },
  resolveFetchFile,
}));
vi.mock("@/lib/github/file-content", () => ({ getFileContent: fetchFile }));
// Mocked so the proof step is controllable and never reaches a real container.
vi.mock("@/lib/review/test-proof", () => ({ proofImage, reproduceFinding: reproduce }));
import { verifyBlockingFindings } from "@/lib/review/verification";
import { FETCH_FILE_TOOL } from "@/lib/ai/review";

const context = { installationId: 1, owner: "test", repo: "repo", ref: "head-sha" };
const finding: FindingDoc = { file: "src/math.ts", line: 2, title: "Division by zero", explanation: "Zero is not handled.", category: "bug", severity: "high" };
const file = { filename: finding.file, status: "modified", patch: "@@ -1,3 +1,3 @@\n export function divide(x) {\n-  return x ? 10 / x : 0;\n+  return 10 / x;\n }" };
const source = "export function divide(x) {\n  return 10 / x;\n}\n";
const evidence = [{ file: finding.file, line: 2, quote: "  return 10 / x;" }];
function response(decisions: unknown[]) {
  return { usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 }, choices: [{ message: { tool_calls: [{ type: "function", function: { name: "submit_verification", arguments: JSON.stringify({ decisions }) } }] } }] };
}
function decision(overrides = {}) { return { id: findingId(finding), decision: "accept", reason: "Zero reaches the division after the guard removal.", evidence, ...overrides }; }

beforeEach(() => { vi.clearAllMocks(); fetchFile.mockResolvedValue(source); create.mockResolvedValue(response([decision()])); proofImage.mockReturnValue(undefined); });
afterEach(() => vi.unstubAllEnvs());

describe("bounded blocking verification", () => {
  it("skips all paid work after the review deadline", async () => {
    const result = await verifyBlockingFindings([finding], [file], context, undefined, Date.now() - 1);
    expect(create).not.toHaveBeenCalled();
    expect(fetchFile).not.toHaveBeenCalled();
    expect(result.findings[0].verification?.status).toBe("skipped");
  });
  it("discards its own rejections when the pass fails partway", async () => {
    // The proof step runs after decisions are applied. A failure there used
    // to leave a rejection standing while the checkpoint reported that
    // verification never happened — a finding dropped by an assessment the
    // review then disowned. Either the pass counts or none of it does.
    const other: FindingDoc = { ...finding, title: "Unchecked index", line: 3 };
    create.mockResolvedValue(response([
      // Accepted, and carrying the proposed test that makes the proof step run.
      { id: findingId(finding), decision: "accept", reason: "Reachable.", evidence, test: { exportName: "divide", args: [0], expected: 0 } },
      { id: findingId(other), decision: "reject", reason: "Guarded upstream.", evidence: [] },
    ]));
    // Force a throw after the decisions have already been written.
    proofImage.mockReturnValue("node@sha256:" + "a".repeat(64));
    reproduce.mockRejectedValue(new Error("container unavailable"));

    const result = await verifyBlockingFindings([finding, other], [file], context, "basesha", Date.now() + 120_000);

    expect(result.rejected).toHaveLength(0);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((f) => f.verification?.status === "skipped")).toBe(true);
    expect(result.findings.some((f) => f.verification?.status === "accepted")).toBe(false);
  });

  it("shrinks source context to fit instead of dropping a verifiable candidate", async () => {
    // The budget is in TOKENS and the request is measured in BYTES, so the
    // ceiling is the converted one. Comparing the two units directly is the
    // defect this assertion used to pin: it passed only because the code under
    // test made the same mistake, and holding it there spent about a quarter of
    // the configured budget — enough that a candidate with a real hunk was
    // shrunk to its floor and every candidate after the first was dropped
    // before the call, permanently unable to block.
    //
    // 4500, not 3000: packing and shrinking are sized against the
    // forced-submit request shape (tools: [TOOL] only) so fetch_file's fixed
    // schema cost can never squeeze out a candidate's own content -- see the
    // comment at the shrink loop. But the actual first request DOES carry
    // both tools, so it can legitimately run over the packed size by that
    // fixed, known amount. 3000 left no room for that; a real budget does.
    vi.stubEnv("REVIEW_VERIFICATION_TOKEN_BUDGET", "4500");
    fetchFile.mockResolvedValue(source + ("x".repeat(400) + "\n").repeat(20));
    const result = await verifyBlockingFindings([finding], [file], context);
    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0][0];
    const byteBudget = (4500 - params.max_tokens - 512) * 3.5;
    const fetchToolOverhead = Buffer.byteLength(JSON.stringify(FETCH_FILE_TOOL), "utf8");
    // Genuinely shrunk: the untrimmed window for this source is far larger.
    expect(JSON.parse(params.messages[1].content)[0].headContext.length).toBeLessThan(3000);
    expect(Buffer.byteLength(JSON.stringify(params), "utf8")).toBeLessThanOrEqual(byteBudget + fetchToolOverhead);
    expect(canBlock(result.findings[0])).toBe(true);
  });

  it("fits every candidate in one batch at the default budget", async () => {
    // The regression the unit fix exists for: three high-severity findings on a
    // realistic hunk used to overflow the request after the first, and the two
    // that never reached the model kept the "skipped" status skippedVerification
    // set — so they could not block whatever the verifier would have said.
    const many = [finding, { ...finding, title: "Unchecked index" }, { ...finding, title: "Missing guard" }];
    const wide = [{ ...file, patch: file.patch + "\n" + "+  const padding = compute(input);\n".repeat(60) }];
    fetchFile.mockResolvedValue(source + "const value = compute(input);\n".repeat(60));
    create.mockResolvedValue(response(many.map((item) => decision({ id: findingId(item) }))));
    await verifyBlockingFindings(many, wide, context);
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.parse(create.mock.calls[0][0].messages[1].content)).toHaveLength(3);
  });
  it("assesses findings below the blocking threshold too", async () => {
    // Assessment used to consider only high/critical, so everything else
    // reached the author unexamined — on a diff with no defects at all, three
    // of five findings skipped the evidence gate entirely. Blocking was never
    // the only thing worth being right about; being posted is the lower bar.
    create.mockResolvedValue(response([decision({ id: findingId({ ...finding, severity: "medium" }), decision: "downgrade", reason: "Real but minor." })]));
    const result = await verifyBlockingFindings([{ ...finding, severity: "medium" }], [file], context);
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.findings[0].verification?.status).toBe("downgraded");
  });

  it("spends nothing assessing deterministic linter output", async () => {
    // Static analysis already points at an exact line. Letting a language
    // model overrule ESLint on whether ESLint fired is not an improvement.
    const result = await verifyBlockingFindings([{ ...finding, source: "static-analysis" }], [file], context);
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
  it("fetches a second file before deciding when the finding's evidence depends on it", async () => {
    // The verifier's own blind spot: it only ever sees the ONE file a finding
    // is anchored to. A claim whose disproof lives in a different file --
    // a type definition, a function it calls -- could never be checked, only
    // accepted or downgraded on the finding's own say-so. This is the fix:
    // one round to investigate, one to decide.
    const fetchCallArgs = { name: "fetch_file", arguments: JSON.stringify({ path: "src/types.ts" }) };
    const investigateMessage = { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: fetchCallArgs }] };
    create.mockResolvedValueOnce({ usage: { prompt_tokens: 400, completion_tokens: 50, total_tokens: 450 }, choices: [{ message: investigateMessage }] });
    create.mockResolvedValueOnce(response([decision({ decision: "reject", reason: "The referenced type already forbids this at compile time." })]));
    resolveFetchFile.mockResolvedValue("File: src/types.ts\n\nexport type Foo = never;");

    const result = await verifyBlockingFindings([finding], [file], context);

    expect(create).toHaveBeenCalledTimes(2);
    expect(resolveFetchFile).toHaveBeenCalledWith(fetchCallArgs.arguments, context, expect.any(Map), expect.any(Number));
    // Investigation round offers both tools; the decision round withdraws
    // fetch_file -- nothing left to investigate with, so the model must
    // decide on whatever it now has, same as every other batch.
    expect(create.mock.calls[0][0].tools).toHaveLength(2);
    expect(create.mock.calls[1][0].tools).toEqual([expect.objectContaining({ function: expect.objectContaining({ name: "submit_verification" }) })]);
    expect(create.mock.calls[1][0].tool_choice).toEqual({ type: "function", function: { name: "submit_verification" } });
    // The tool result reaches the model as a real reply to its own call, not
    // a fresh unrelated message -- the assistant turn is threaded back in.
    const secondMessages = create.mock.calls[1][0].messages;
    expect(secondMessages.at(-2)).toBe(investigateMessage);
    expect(secondMessages.at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: "File: src/types.ts\n\nexport type Foo = never;" });
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].verification?.reason).toBe("The referenced type already forbids this at compile time.");
  });
  it("will not let an accept block on evidence quoted at the wrong line", async () => {
    // An accept is what fails someone's build, so it keeps the strict bar: the
    // quote must be the real code at the reported line. Failing that bar makes
    // the finding advisory, NOT deleted — dropping it here was tried and threw
    // away true positives, because the verifier fails at transcribing a line
    // long before it fails at judging one.
    create.mockResolvedValue(response([decision({ evidence: [{ ...evidence[0], line: 1 }] })]));
    const result = await verifyBlockingFindings([finding], [file], context);
    expect(result.findings[0].verification?.status).toBe("downgraded");
    expect(canBlock(result.findings[0])).toBe(false);
    expect(result.rejected).toEqual([]);
  });
  it("accepts an indentation-normalized quote while still checking its file and line", async () => {
    create.mockResolvedValue(response([decision({ evidence: [{ ...evidence[0], quote: evidence[0].quote.trim() }] })]));
    expect((await verifyBlockingFindings([finding], [file], context)).findings[0].verification?.status).toBe("accepted");
  });
  it("will not let an accept block on a quote that is not the code at that line", async () => {
    create.mockResolvedValue(response([decision({ evidence: [{ ...evidence[0], quote: "return 100 / x;" }] })]));
    const result = await verifyBlockingFindings([finding], [file], context);
    expect(result.findings[0].verification?.status).toBe("downgraded");
    expect(canBlock(result.findings[0])).toBe(false);
  });

  it("only the verifier's own rejection removes a finding", async () => {
    // Rejection follows the verifier's decision, not our ability to make it
    // transcribe a line. An earlier attempt dropped everything unquotable and
    // measured worse: it deleted a genuine defect twice in one run while the
    // verifier's own text agreed the defect was real.
    create.mockResolvedValue(response([decision({ decision: "downgrade", reason: "Advisory.", evidence: [] })]));
    const kept = await verifyBlockingFindings([finding], [file], context);
    expect(kept.findings).toHaveLength(1);
    expect(kept.findings[0].verification?.status).toBe("downgraded");
    expect(kept.rejected).toEqual([]);

    create.mockResolvedValue(response([decision({ decision: "reject", reason: "Caller excludes zero.", evidence: [] })]));
    expect((await verifyBlockingFindings([finding], [file], context)).findings).toEqual([]);
  });

  it("supplies the evidence line itself when the verifier does not quote one", async () => {
    // The finding already names file and line and we already hold the source,
    // so the anchor is exact by construction. Asking the model to type it back
    // added a failure mode and bought no safety.
    create.mockResolvedValue(response([decision({ decision: "downgrade", reason: "Advisory.", evidence: [] })]));
    const result = await verifyBlockingFindings([finding], [file], context);
    expect(result.findings[0].verification?.evidence).toEqual([{ file: finding.file, line: 2, quote: "  return 10 / x;" }]);
  });
  it("never submits more findings in one request than the schema accepts", async () => {
    // Found by CodeRabbit on PR #84. decisionSchema caps decisions at 8 while
    // the batch packer bounded a batch only by BYTES, so once
    // REVIEW_VERIFICATION_MAX_FINDINGS went past 3 a batch could carry more
    // than 8 findings. A compliant answer to that request then fails parsing on
    // cardinality alone and the WHOLE batch goes unassessed — every finding in
    // it keeps the "skipped" status, which canBlock() can never promote and
    // which still posts to the author.
    const many = Array.from({ length: 11 }, (_, index) => ({ ...finding, title: `Concern ${index}` }));
    create.mockImplementation((params: { messages: { content: string }[] }) => {
      const items = JSON.parse(params.messages[1].content) as { id: string }[];
      expect(items.length).toBeLessThanOrEqual(8);
      return Promise.resolve(response(items.map((item) => decision({ id: item.id, decision: "downgrade", reason: "Advisory." }))));
    });

    const result = await verifyBlockingFindings(many, [file], context, undefined, Date.now() + 120_000);

    expect(create.mock.calls.length).toBeGreaterThan(1);
    // Every finding assessed, none left on the up-front "skipped" status.
    expect(result.findings).toHaveLength(11);
    expect(result.findings.every((f) => f.verification?.status === "downgraded")).toBe(true);
  });

  it("assesses a finding whose line falls outside the diff hunks", async () => {
    // Previously skipped outright, which meant the LEAST trustworthy findings
    // we produce — the ones whose anchor drifted, or that describe code this
    // PR never touched — reached the author with no assessment at all. The
    // verifier can see them now and say so; its prompt already rejects
    // pre-existing issues and anything it cannot tie to a supplied line.
    const outside: FindingDoc = { ...finding, line: 99, title: "Unrelated concern" };
    create.mockResolvedValue(response([
      { id: findingId(outside), decision: "reject", reason: "Line 99 is not part of this change.", evidence: [] },
    ]));
    const result = await verifyBlockingFindings([outside], [file], context);
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.findings).toEqual([]);
    expect(result.rejected[0].verification?.status).toBe("rejected");
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
    expect(result.usage.calls).toBe(1); expect(result.findings[0].verification?.status).toBe("skipped");
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
    expect(result.findings.filter((f) => f.verification?.status === "accepted")).toHaveLength(1);
  });
  it("an explicit non-blocking verdict still keeps a finding out of the gate", () => {
    // Blocking follows severity now that no assessment pass runs by default,
    // but a verdict something actually reached — a rejection, a downgrade —
    // is still honoured, so a finding an assessment threw out cannot start
    // failing builds just because the stage that threw it out is off.
    expect(canBlock({ ...finding, confidence: "100%" })).toBe(true);
    expect(canBlock({ ...finding, verification: { status: "rejected", reason: "r", evidence: [] } })).toBe(false);
    expect(canBlock({ ...finding, verification: { status: "downgraded", reason: "r", evidence: [] } })).toBe(false);
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
