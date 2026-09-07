import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { CandidateFinding, TrackedFinding } from "@/lib/review/stage-types";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/ai/review", () => ({
  getClient: () => ({ chat: { completions: { create } } }),
  DEFAULT_MODEL: "test-model",
  thinkingKwargs: () => ({}),
}));

import { runDebate } from "@/lib/review/debate";
import { runArbitration } from "@/lib/review/arbitration";
import { needsFocusedConfirmation, runFocusedConfirmation } from "@/lib/review/focused-confirmation";
import { ReviewStageError } from "@/lib/review/stage-types";

/**
 * The debate and arbitration stages against a scripted provider.
 *
 * What is being pinned here is not the prompt wording but the state machine:
 * a round that reaches agreement must stop, a round that does not must carry
 * the dispute forward, and a stage that cannot run must fail loudly rather
 * than return an empty list — because an empty list at this point renders as
 * "no defects" on somebody's pull request.
 */

function toolResponse(name: string, args: unknown) {
  return {
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
  };
}

function turns(position: string, severity?: string) {
  return toolResponse("submit_debate_positions", {
    turns: [{ findingId: "F001", position, ...(severity ? { severity } : {}), reason: "Examined the surrounding guard.", evidence: [] }],
  });
}

function candidate(over: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    id: "F001", severity: "high", category: "bug",
    title: "Off-by-one loop condition", file: "src/app.ts", startLine: 10, endLine: 12,
    problem: "Uses <= against length.", whyItIsABug: "Dereferences one past the end.",
    evidence: [], relatedFiles: [], confidence: 0.9, source: "ultra", ...over,
  };
}

const disputed: TrackedFinding[] = [{
  candidate: candidate(),
  status: "disputed",
  ultra: { decision: "confirm", confidence: 0.9 },
  super: { decision: "reject", confidence: 0.8 },
}];

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
void log;

// Call history only. Every test below scripts the provider completely — a
// response for each call it will make — rather than relying on what a previous
// test left behind, which is how round two of a debate once answered itself
// and turned a genuine disagreement into a false consensus.
beforeEach(() => vi.clearAllMocks());

describe("debate engine", () => {
  it("stops at round one when both sides agree the defect is real", () => {
    create.mockResolvedValueOnce(turns("confirm")).mockResolvedValueOnce(turns("confirm"));
    return runDebate("context", disputed, Date.now() + 120_000).then((result) => {
      expect(create).toHaveBeenCalledTimes(2);
      expect(result.resolved).toHaveLength(1);
      expect(result.resolved[0].status).toBe("confirmed");
      expect(result.resolved[0].debate?.consensusReached).toBe(true);
      expect(result.resolved[0].debate?.rounds).toBe(1);
      expect(result.unresolved).toHaveLength(0);
    });
  });

  it("treats a withdrawal met with a maintained rejection as agreement that it is not a defect", async () => {
    create.mockResolvedValueOnce(turns("withdraw")).mockResolvedValueOnce(turns("maintain_rejection"));
    const result = await runDebate("context", disputed, Date.now() + 120_000);
    expect(result.resolved[0].status).toBe("rejected");
    expect(result.resolved[0].debate?.consensusReached).toBe(true);
  });

  it("TEST D: two rounds of genuine disagreement leave the finding unresolved for arbitration", async () => {
    create
      .mockResolvedValueOnce(turns("confirm")).mockResolvedValueOnce(turns("maintain_rejection"))
      .mockResolvedValueOnce(turns("confirm")).mockResolvedValueOnce(turns("maintain_rejection"));
    const result = await runDebate("context", disputed, Date.now() + 120_000);
    expect(create).toHaveBeenCalledTimes(4);
    expect(result.resolved).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].debate?.rounds).toBe(2);
    expect(result.unresolved[0].debate?.consensusReached).toBe(false);
  });

  it("never runs a third round", async () => {
    // The challenger keeps rejecting, so this would run forever without the bound.
    create
      .mockResolvedValueOnce(turns("confirm")).mockResolvedValueOnce(turns("maintain_rejection"))
      .mockResolvedValueOnce(turns("confirm")).mockResolvedValueOnce(turns("maintain_rejection"))
      .mockResolvedValueOnce(turns("confirm")).mockResolvedValueOnce(turns("maintain_rejection"));
    await runDebate("context", disputed, Date.now() + 120_000);
    expect(create).toHaveBeenCalledTimes(4);
  });

  it("a one-step severity difference after debate counts as consensus", async () => {
    create.mockResolvedValueOnce(turns("confirm", "high")).mockResolvedValueOnce(turns("modify", "medium"));
    const result = await runDebate("context", disputed, Date.now() + 120_000);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].status).toBe("confirmed");
  });

  it("a two-step severity difference is not consensus", async () => {
    // Both rounds scripted: the gap persists, so this must survive to arbitration.
    create
      .mockResolvedValueOnce(turns("confirm", "critical")).mockResolvedValueOnce(turns("modify", "low"))
      .mockResolvedValueOnce(turns("confirm", "critical")).mockResolvedValueOnce(turns("modify", "low"));
    const result = await runDebate("context", disputed, Date.now() + 120_000);
    expect(result.resolved).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
  });
});

describe("arbitration", () => {
  function verdicts(decision: string, over: Record<string, unknown> = {}) {
    return toolResponse("submit_arbitration", {
      verdicts: [{ findingId: "F001", decision, severity: "high", confidence: 0.8, reason: "The guard runs after the dereference.", ...over }],
    });
  }

  it("TEST E: a confirmed verdict produces a reportable defect", async () => {
    create.mockResolvedValueOnce(verdicts("confirmed"));
    const result = await runArbitration("context", disputed, Date.now() + 120_000);
    expect(result.resolved[0].status).toBe("confirmed");
    expect(result.resolved[0].arbitration?.used).toBe(true);
  });

  it("TEST F: a rejected verdict removes the finding from the confirmed set", async () => {
    create.mockResolvedValueOnce(verdicts("rejected"));
    const result = await runArbitration("context", disputed, Date.now() + 120_000);
    expect(result.resolved[0].status).toBe("rejected");
  });

  it("TEST G: an uncertain verdict is never promoted to confirmed", async () => {
    create.mockResolvedValueOnce(verdicts("uncertain"));
    const result = await runArbitration("context", disputed, Date.now() + 120_000);
    expect(result.resolved[0].status).toBe("uncertain");
    expect(result.resolved[0].status).not.toBe("confirmed");
  });

  it("applies a corrected title and severity from a modified verdict", async () => {
    create.mockResolvedValueOnce(verdicts("modified", { severity: "low", finalTitle: "Loop bound is inclusive", finalExplanation: "Smaller impact than claimed." }));
    const result = await runArbitration("context", disputed, Date.now() + 120_000);
    expect(result.resolved[0].status).toBe("modified");
    expect(result.resolved[0].candidate.severity).toBe("low");
    expect(result.resolved[0].candidate.title).toBe("Loop bound is inclusive");
  });

  it("a finding the adjudicator skipped stays uncertain rather than defaulting to confirmed", async () => {
    create.mockResolvedValueOnce(toolResponse("submit_arbitration", { verdicts: [] }));
    const result = await runArbitration("context", disputed, Date.now() + 120_000);
    expect(result.resolved[0].status).toBe("uncertain");
    expect(result.resolved[0].arbitration?.confidence).toBe(0);
  });

  it("costs nothing when there is nothing to arbitrate", async () => {
    const result = await runArbitration("context", [], Date.now() + 120_000);
    expect(create).not.toHaveBeenCalled();
    expect(result.usage.calls).toBe(0);
  });
});

describe("a stage failure is a failure, never an empty result", () => {
  it("TEST K: a provider error surfaces as ReviewStageError rather than zero findings", async () => {
    create.mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
    await expect(runArbitration("context", disputed, Date.now() + 8_000)).rejects.toBeInstanceOf(ReviewStageError);
  });

  it("a response truncated before the tool call is a failure, not a clean review", async () => {
    create.mockResolvedValue({ usage: {}, choices: [{ finish_reason: "length", message: {} }] });
    await expect(runArbitration("context", disputed, Date.now() + 8_000)).rejects.toBeInstanceOf(ReviewStageError);
  });

  it("malformed tool arguments are retried, then fail loudly", async () => {
    create.mockResolvedValue(toolResponse("submit_arbitration", "not-an-object"));
    await expect(runArbitration("context", disputed, Date.now() + 8_000)).rejects.toBeInstanceOf(ReviewStageError);
    expect(create.mock.calls.length).toBeGreaterThan(1);
  });

  it("a 4xx is our own request and is not retried", async () => {
    create.mockRejectedValue(Object.assign(new Error("bad request"), { status: 400 }));
    await expect(runArbitration("context", disputed, Date.now() + 30_000)).rejects.toBeInstanceOf(ReviewStageError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("recovers when a transient failure is followed by a good response", async () => {
    create
      .mockRejectedValueOnce(Object.assign(new Error("overloaded"), { status: 503 }))
      .mockResolvedValueOnce(verdictsConfirmed());
    const result = await runArbitration("context", disputed, Date.now() + 60_000);
    expect(result.resolved[0].status).toBe("confirmed");
    expect(create).toHaveBeenCalledTimes(2);
  });

  function verdictsConfirmed() {
    return toolResponse("submit_arbitration", {
      verdicts: [{ findingId: "F001", decision: "confirmed", severity: "high", confidence: 0.9, reason: "Reachable from the handler." }],
    });
  }
});

describe("focused confirmation for severe findings only the verifier saw", () => {
  const superFinding: TrackedFinding[] = [{
    candidate: candidate({ id: "S001", severity: "critical", source: "super" }),
    status: "candidate",
    super: { decision: "confirm", confidence: 0.9 },
  }];

  function confirmations(decision: string, severity = "critical") {
    return toolResponse("submit_focused_confirmation", {
      confirmations: [{ findingId: "S001", decision, severity, confidence: 0.8, reason: "Reachable from the exported handler." }],
    });
  }

  it("selects only severe findings the primary reviewer never reported", () => {
    const pool: TrackedFinding[] = [
      ...superFinding,
      { candidate: candidate({ id: "S002", severity: "low", source: "super" }), status: "candidate" },
      { candidate: candidate({ id: "F001", severity: "critical", source: "ultra" }), status: "agreed" },
    ];
    const selected = needsFocusedConfirmation(pool);
    expect(selected.map((t) => t.candidate.id)).toEqual(["S001"]);
  });

  it("confirms a severe discovery on its own evidence", async () => {
    create.mockResolvedValueOnce(confirmations("confirmed"));
    const result = await runFocusedConfirmation("context", superFinding, Date.now() + 120_000);
    expect(result.resolved[0].status).toBe("confirmed");
  });

  it("rejects one the code does not support", async () => {
    create.mockResolvedValueOnce(confirmations("rejected"));
    const result = await runFocusedConfirmation("context", superFinding, Date.now() + 120_000);
    expect(result.resolved[0].status).toBe("rejected");
  });

  it("does not promote a severe claim the confirmer skipped", async () => {
    // Silence must not read as confirmation here of all places: this is an
    // unreviewed CRITICAL that only one reviewer ever saw.
    create.mockResolvedValueOnce(toolResponse("submit_focused_confirmation", { confirmations: [] }));
    const result = await runFocusedConfirmation("context", superFinding, Date.now() + 120_000);
    expect(result.resolved[0].status).toBe("uncertain");
  });

  it("applies a corrected severity from a modified verdict", async () => {
    create.mockResolvedValueOnce(confirmations("modified", "medium"));
    const result = await runFocusedConfirmation("context", superFinding, Date.now() + 120_000);
    expect(result.resolved[0].status).toBe("modified");
    expect(result.resolved[0].candidate.severity).toBe("medium");
  });

  it("costs nothing when there is nothing severe to confirm", async () => {
    const result = await runFocusedConfirmation("context", [], Date.now() + 120_000);
    expect(create).not.toHaveBeenCalled();
    expect(result.usage.calls).toBe(0);
  });
});
