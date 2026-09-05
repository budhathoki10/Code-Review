import { describe, it, expect } from "vitest";
import { filterCarriedForwardFindings, categoryFilter, severityFilter, computeConclusion } from "@/lib/review/pipeline";
import { normalizeDisabledSeverities, REVIEW_SEVERITIES } from "@/lib/review/severity";
import type { FindingDoc } from "@/lib/db/collections";

function finding(overrides: Partial<FindingDoc> = {}): FindingDoc {
  return {
    severity: "medium",
    category: "quality",
    file: "src/untouched.ts",
    title: "example finding",
    explanation: "example explanation",
    ...overrides,
  };
}

describe("evidence-based merge checks", () => {
  it("a model verdict or high confidence alone cannot fail a check", () => {
    expect(computeConclusion("request_changes", [finding({ severity: "critical", confidence: "high" })], "high")).toBe("neutral");
  });
  it("requires accepted evidence and the repository threshold", () => {
    const assessed = finding({ severity: "high", verification: { status: "accepted", reason: "Guard removed", evidence: [{ file: "a.ts", line: 1, quote: "return 10/x" }] } });
    expect(computeConclusion("approve", [assessed], "high")).toBe("failure");
    expect(computeConclusion("request_changes", [assessed], "critical")).toBe("neutral");
  });
  it("lowering the threshold never makes medium advice block", () => {
    expect(computeConclusion("comment", [finding({ severity: "medium" })], "info")).toBe("neutral");
  });
});

describe("filterCarriedForwardFindings", () => {
  it("keeps findings on files the new delta did not touch", () => {
    const previous = [finding({ file: "src/a.ts" }), finding({ file: "src/b.ts" })];
    const touched = new Set(["src/e.ts", "src/f.ts"]);

    const result = filterCarriedForwardFindings(previous, touched);

    expect(result).toEqual(previous);
  });

  it("drops findings on files the new delta touched", () => {
    const previous = [finding({ file: "src/a.ts" }), finding({ file: "src/e.ts" })];
    const touched = new Set(["src/e.ts", "src/f.ts"]);

    const result = filterCarriedForwardFindings(previous, touched);

    expect(result).toEqual([finding({ file: "src/a.ts" })]);
  });

  it("returns an empty array when every previous finding's file was touched", () => {
    const previous = [finding({ file: "src/e.ts" }), finding({ file: "src/f.ts" })];
    const touched = new Set(["src/e.ts", "src/f.ts"]);

    expect(filterCarriedForwardFindings(previous, touched)).toEqual([]);
  });

  it("returns everything unchanged when the touched set is empty (e.g. an empty incremental delta)", () => {
    const previous = [finding({ file: "src/a.ts" }), finding({ file: "src/b.ts" })];

    expect(filterCarriedForwardFindings(previous, new Set())).toEqual(previous);
  });

  it("returns an empty array when there were no previous findings", () => {
    expect(filterCarriedForwardFindings([], new Set(["src/e.ts"]))).toEqual([]);
  });
});

describe("categoryFilter", () => {
  it("keeps everything when the repo disabled nothing", () => {
    const findings = [finding({ category: "testing" }), finding({ category: "security" })];

    expect(findings.filter(categoryFilter([]))).toEqual(findings);
    expect(findings.filter(categoryFilter(undefined))).toEqual(findings);
  });

  it("drops only the disabled category, leaving the other axes alone", () => {
    const findings = [
      finding({ category: "testing", severity: "critical" }),
      finding({ category: "security", severity: "info" }),
      finding({ category: "quality" }),
    ];

    const kept = findings.filter(categoryFilter(["testing"]));

    // A critical finding is still dropped: category is not a severity filter.
    // An info-level one survives: disabling a category says nothing about how
    // bad the remaining findings have to be.
    expect(kept.map((f) => f.category)).toEqual(["security", "quality"]);
  });

  it("drops several categories at once", () => {
    const findings = [
      finding({ category: "testing" }),
      finding({ category: "performance" }),
      finding({ category: "bug" }),
    ];

    expect(findings.filter(categoryFilter(["testing", "performance"])).map((f) => f.category)).toEqual(["bug"]);
  });

  it("unions the dashboard and .prsentry.yaml lists rather than letting one win", () => {
    const findings = [
      finding({ category: "testing" }),
      finding({ category: "performance" }),
      finding({ category: "bug" }),
    ];

    // Dashboard disables testing, the repo file disables performance. Neither
    // config can re-enable what the other switched off, so both are dropped.
    const kept = findings.filter(categoryFilter(["testing"], ["performance"]));

    expect(kept.map((f) => f.category)).toEqual(["bug"]);
  });

  it("tolerates either config source being absent", () => {
    const findings = [finding({ category: "testing" }), finding({ category: "bug" })];

    expect(findings.filter(categoryFilter(undefined, ["testing"])).map((f) => f.category)).toEqual(["bug"]);
    expect(findings.filter(categoryFilter(["testing"], undefined)).map((f) => f.category)).toEqual(["bug"]);
    expect(findings.filter(categoryFilter(undefined, undefined))).toEqual(findings);
  });

  it("applies to static-analysis findings the same as to AI ones", () => {
    // Static findings are only ever "security" or "quality" — a repo that
    // turns off quality must stop receiving the linter's quality output too,
    // not just the model's.
    const findings = [
      finding({ category: "quality", source: "static-analysis" }),
      finding({ category: "security", source: "static-analysis" }),
    ];

    expect(findings.filter(categoryFilter(["quality"])).map((f) => f.source)).toEqual(["static-analysis"]);
    expect(findings.filter(categoryFilter(["quality"])).map((f) => f.category)).toEqual(["security"]);
  });
});

describe("severityFilter", () => {
  it("keeps everything when the repo disabled nothing", () => {
    const findings = [finding({ severity: "low" }), finding({ severity: "critical" })];

    expect(findings.filter(severityFilter([]))).toEqual(findings);
    expect(findings.filter(severityFilter(undefined))).toEqual(findings);
  });

  it("drops only the disabled severity, leaving the other axes alone", () => {
    const findings = [
      finding({ severity: "medium", category: "bug" }),
      finding({ severity: "critical", category: "bug" }),
      finding({ severity: "info", category: "bug" }),
    ];

    // The reported case: medium off must drop a medium *bug* while leaving
    // every other level of bug untouched — severity is not a category filter.
    const kept = findings.filter(severityFilter(["medium"]));

    expect(kept.map((f) => f.severity)).toEqual(["critical", "info"]);
  });

  it("is a set, not a floor — disabling the middle keeps both ends", () => {
    const findings = [
      finding({ severity: "critical" }),
      finding({ severity: "high" }),
      finding({ severity: "medium" }),
      finding({ severity: "low" }),
      finding({ severity: "info" }),
    ];

    // A threshold could not express this: "critical and info, nothing
    // between" is exactly what the switches buy over the old dropdown.
    const kept = findings.filter(severityFilter(["high", "medium", "low"]));

    expect(kept.map((f) => f.severity)).toEqual(["critical", "info"]);
  });

  it("ignores an all-off list rather than silencing the whole review", () => {
    const findings = [finding({ severity: "critical" }), finding({ severity: "info" })];

    // Every severity off would leave no findings at all while still paying
    // for the model call, which is never what someone means.
    expect(findings.filter(severityFilter(["critical", "high", "medium", "low", "info"]))).toEqual(findings);
  });

  it("applies to static-analysis findings the same as to AI ones", () => {
    const findings = [
      finding({ severity: "medium", source: "static-analysis" }),
      finding({ severity: "critical", source: "static-analysis" }),
    ];

    expect(findings.filter(severityFilter(["medium"])).map((f) => f.severity)).toEqual(["critical"]);
  });

  it("composes with categoryFilter — a finding must pass both", () => {
    const findings = [
      finding({ severity: "medium", category: "testing" }),
      finding({ severity: "medium", category: "bug" }),
      finding({ severity: "high", category: "testing" }),
      finding({ severity: "high", category: "bug" }),
    ];

    const keepsCategory = categoryFilter(["testing"]);
    const keepsSeverity = severityFilter(["medium"]);
    const kept = findings.filter((f) => keepsCategory(f) && keepsSeverity(f));

    expect(kept).toEqual([finding({ severity: "high", category: "bug" })]);
  });
});

describe("normalizeDisabledSeverities", () => {
  it("passes a partial list through unchanged", () => {
    expect(normalizeDisabledSeverities(["medium", "low"])).toEqual(["medium", "low"]);
  });

  it("treats an all-off list as no filtering at all", () => {
    // The bug this guards: the same list is ALSO rendered into the review
    // prompt. Applying the guard only inside severityFilter left the model
    // instructed to omit every severity — it returned nothing, and the
    // filter then had nothing left to preserve. The guard has to run before
    // the earliest consumer, so it lives here rather than in the filter.
    expect(normalizeDisabledSeverities(REVIEW_SEVERITIES)).toEqual([]);
  });

  it("collapses duplicates before deciding whether every severity is off", () => {
    // Four entries, but only two distinct — nowhere near all-off, so it must
    // survive rather than being miscounted toward the guard.
    expect(normalizeDisabledSeverities(["low", "low", "info", "info"])).toEqual(["low", "info"]);
  });

  it("returns an empty list for undefined or empty input", () => {
    expect(normalizeDisabledSeverities(undefined)).toEqual([]);
    expect(normalizeDisabledSeverities([])).toEqual([]);
  });

  it("keeps severityFilter and the prompt agreeing on an all-off list", () => {
    const findings = [finding({ severity: "critical" }), finding({ severity: "info" })];
    // Both consumers derive from the same normalized value, so neither can
    // act on a list the other has already discarded.
    const normalized = normalizeDisabledSeverities(REVIEW_SEVERITIES);
    expect(normalized).toEqual([]);
    expect(findings.filter(severityFilter(normalized))).toEqual(findings);
  });
});
