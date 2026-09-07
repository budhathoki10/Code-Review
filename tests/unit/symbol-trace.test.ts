import { describe, expect, it } from "vitest";
import {
  buildTraceBlock,
  importCandidates,
  renderTraces,
  symbolsInRange,
  traceFinding,
  traceSymbol,
} from "@/lib/review/symbol-trace";
import type { CandidateFinding } from "@/lib/review/stage-types";

/**
 * The two cases here are the real ones.
 *
 * Both come from a single review this repository ran against its own code.
 * Both findings were wrong, both were stated confidently, and both were wrong
 * for the same reason: the reviewer did not follow a symbol to the place that
 * decides what it means. The first was forty lines below in the same file; the
 * second was one import away. Neither was missing from the prompt.
 *
 * So the bar for these tests is not "the tracer returns something". It is
 * that the specific line the reviewer needed and skipped is in the output.
 */

function finding(over: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    id: "f1",
    severity: "medium",
    category: "bug",
    title: "t",
    file: "src/lib/review/multi-stage.ts",
    startLine: 1,
    endLine: 1,
    problem: "p",
    whyItIsABug: "w",
    evidence: [],
    relatedFiles: [],
    confidence: 0.8,
    source: "ultra",
    ...over,
  };
}

// Reduced from the real file, keeping the distance that caused the miss.
const MULTI_STAGE = [
  'let settled = tracked.filter((t) => t.status !== "disputed");',        // 1
  'const disputed = tracked.filter((t) => t.status === "disputed");',      // 2
  "if (disputed.length > 0) {",                                            // 3
  "  try {",                                                               // 4
  "    const arbitration = await runArbitration(ctx, unresolved);",        // 5
  "    settled = [...settled, ...arbitration.resolved];",                  // 6
  "  } catch (error) {",                                                   // 7
  '    settled = [...settled, ...unresolved.map((t) => ({ ...t, status: "uncertain" }))];', // 8
  "  }",                                                                   // 9
  "}",                                                                     // 10
  "",                                                                      // 11
  "const validated = settled.map((t) => validateLocation(t));",            // 12
  'const confirmed = validated.filter((t) => t.status === "confirmed");',  // 13
  'const unresolvedOut = validated.filter((t) => t.status === "uncertain");', // 14
].join("\n");

describe("picking the symbols a finding is about", () => {
  it("takes them from the cited lines, not the whole file", () => {
    const symbols = symbolsInRange(MULTI_STAGE, 8, 8);
    expect(symbols).toContain("settled");
    expect(symbols).not.toContain("confirmed");
  });

  it("skips keywords and stdlib names that match every line", () => {
    const symbols = symbolsInRange(MULTI_STAGE, 1, 14);
    for (const noise of ["const", "filter", "map", "catch", "await"]) {
      expect(symbols).not.toContain(noise);
    }
  });

  it("keeps a domain field like `status`, which is what decides routing", () => {
    // Tempting to treat as noise because it is everywhere. It is also the
    // symbol whose comparisons decide which bucket a finding lands in, which
    // is the exact question the reviewer got wrong.
    expect(symbolsInRange(MULTI_STAGE, 8, 8)).toContain("status");
  });

  it("ranks by how often a symbol appears in the cited range", () => {
    // `settled` is written twice on line 8; nothing else there is.
    expect(symbolsInRange(MULTI_STAGE, 8, 8)[0]).toBe("settled");
  });

  it("survives a range that runs past the end of the file", () => {
    expect(() => symbolsInRange(MULTI_STAGE, 12, 9_999)).not.toThrow();
  });
});

describe("following a symbol to its consumers", () => {
  const sources = new Map([["src/lib/review/multi-stage.ts", MULTI_STAGE]]);

  it("finds the line four rows down that decides what the value means", () => {
    // The exact miss: the reviewer read line 8 and claimed the finding was
    // marked confirmed. Line 14 is where "uncertain" actually routes.
    const refs = traceSymbol("settled", sources, "src/lib/review/multi-stage.ts");
    expect(refs.map((r) => r.line)).toContain(12);
  });

  it("matches whole words only", () => {
    const map = new Map([["a.ts", "const settledCount = 1;\nsettled = 2;"]]);
    const refs = traceSymbol("settled", map, "a.ts");
    expect(refs).toHaveLength(1);
    expect(refs[0].line).toBe(2);
  });

  it("puts the finding's own file first", () => {
    const map = new Map([
      ["other.ts", "settled = 1;"],
      ["target.ts", "settled = 2;"],
    ]);
    expect(traceSymbol("settled", map, "target.ts")[0].file).toBe("target.ts");
  });

  it("returns nothing for a symbol that appears nowhere", () => {
    expect(traceSymbol("nonexistentThing", sources, "src/lib/review/multi-stage.ts")).toEqual([]);
  });

  it("spends its budget on code, not on comments that mention the symbol", () => {
    // Real cause of a truncated trace: this repository comments heavily, and
    // five of twelve reference slots went to sentences about staging before
    // the two lines that actually used the value were reached.
    const map = new Map([["a.ts", [
      "// settled is explained here",
      " * settled again, in a doc block",
      "/* settled once more */",
      "settled = compute();",
    ].join("\n")]]);
    const refs = traceSymbol("settled", map, "a.ts");
    expect(refs).toHaveLength(1);
    expect(refs[0].line).toBe(4);
  });

  it("does not blow up on a symbol containing regex metacharacters", () => {
    expect(() => traceSymbol("a.b*c", sources, "src/lib/review/multi-stage.ts")).not.toThrow();
  });
});

describe("the dossier for a finding", () => {
  const sources = new Map([["src/lib/review/multi-stage.ts", MULTI_STAGE]]);

  it("contains the contradicting line for the arbitration-failure claim", () => {
    const traces = traceFinding(
      finding({ startLine: 8, endLine: 8 }),
      sources,
    );
    const rendered = renderTraces(traces);
    expect(rendered).toContain("settled");
    expect(rendered).toContain("multi-stage.ts:12");
  });

  it("drops a symbol that only appears at the finding's own line", () => {
    const map = new Map([["a.ts", "const onlyHere = compute();\nother();"]]);
    const traces = traceFinding(finding({ file: "a.ts", startLine: 1, endLine: 1 }), map);
    expect(traces.map((t) => t.symbol)).not.toContain("onlyHere");
  });

  it("returns nothing when the finding's file was never fetched", () => {
    expect(traceFinding(finding({ file: "never/fetched.ts" }), sources)).toEqual([]);
  });

  it("renders nothing for no traces, so a caller can append it blindly", () => {
    expect(renderTraces([])).toBe("");
    expect(buildTraceBlock([], sources)).toBe("");
    expect(buildTraceBlock([finding({ file: "never/fetched.ts" })], sources)).toBe("");
  });

  it("labels each section with the finding it belongs to", () => {
    const block = buildTraceBlock([finding({ id: "abc", startLine: 8, endLine: 8 })], sources);
    expect(block).toContain("traces for abc");
    expect(block).toContain("SYMBOL TRACES");
  });
});

describe("reaching the file one import away", () => {
  // The second miss: a claim about `stage` in focused-confirmation.ts, which
  // only stage-call.ts could settle. The tracer has to be able to get there.
  const source = [
    'import { callStage } from "@/lib/ai/stage-call";',
    'import { arbiterStage } from "@/lib/ai/models";',
    'import { helper } from "./local-helper";',
    'import { up } from "../shared/thing";',
    'import { pkg } from "openai";',
  ].join("\n");

  it("resolves an alias import to a repository path", () => {
    expect(importCandidates(source, "src/lib/review/focused-confirmation.ts"))
      .toContain("src/lib/ai/stage-call.ts");
  });

  it("resolves a relative import against the importing file", () => {
    expect(importCandidates(source, "src/lib/review/focused-confirmation.ts"))
      .toContain("src/lib/review/local-helper.ts");
  });

  it("walks up for a parent-relative import", () => {
    expect(importCandidates(source, "src/lib/review/focused-confirmation.ts"))
      .toContain("src/lib/shared/thing.ts");
  });

  it("ignores third-party packages", () => {
    const candidates = importCandidates(source, "src/lib/review/focused-confirmation.ts");
    expect(candidates.some((c) => c.includes("openai"))).toBe(false);
  });

  it("offers an index file for a directory import", () => {
    expect(importCandidates('import { x } from "@/lib/thing";', "src/a.ts"))
      .toContain("src/lib/thing/index.ts");
  });

  it("keeps an explicit extension as written", () => {
    expect(importCandidates('import { x } from "./y.js";', "src/a.ts")).toEqual(["src/y.js"]);
  });

  it("returns nothing for a file with no imports", () => {
    expect(importCandidates("const x = 1;", "src/a.ts")).toEqual([]);
  });
});
