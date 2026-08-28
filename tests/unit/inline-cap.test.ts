import { describe, it, expect } from "vitest";
import { capInlineComments, mapFindingsToInlineComments, computeCommentableLines } from "@/lib/github/diff-lines";
import { formatSummaryComment } from "@/lib/github/comment";
import type { FindingDoc } from "@/lib/db/collections";
import type { PullRequestFile } from "@/lib/github/diff";

function finding(overrides: Partial<FindingDoc> = {}): FindingDoc {
  return {
    severity: "medium",
    category: "quality",
    file: "src/greet.ts",
    title: "example finding",
    explanation: "example explanation",
    ...overrides,
  };
}

/** A patch whose new-file lines 1..count are all commentable. */
function fileWithLines(count: number): PullRequestFile {
  const lines = [`@@ -1,${count} +1,${count} @@`];
  for (let i = 1; i <= count; i++) lines.push(`+line ${i}`);
  return { filename: "src/greet.ts", status: "modified", patch: lines.join("\n") };
}

function comments(count: number, severity: FindingDoc["severity"] = "medium") {
  const commentableLines = computeCommentableLines([fileWithLines(count)]);
  const findings = Array.from({ length: count }, (_, i) =>
    finding({ line: i + 1, title: `finding ${i + 1}`, severity }),
  );
  return mapFindingsToInlineComments(findings, commentableLines).mappable;
}

describe("capInlineComments", () => {
  it("posts everything when the review is under the cap", () => {
    const { posted, overflow } = capInlineComments(comments(10), 25);

    expect(posted).toHaveLength(10);
    expect(overflow).toHaveLength(0);
  });

  it("caps at the limit and returns the rest as overflow findings", () => {
    const { posted, overflow } = capInlineComments(comments(40), 25);

    expect(posted).toHaveLength(25);
    expect(overflow).toHaveLength(15);
  });

  it("loses nothing — posted plus overflow always accounts for every comment", () => {
    const all = comments(40);
    const { posted, overflow } = capInlineComments(all, 25);

    expect(posted.length + overflow.length).toBe(all.length);
    const titles = [...posted.map((c) => c.finding.title), ...overflow.map((f) => f.title)].sort();
    expect(titles).toEqual(all.map((c) => c.finding.title).sort());
  });

  it("spends its slots on the most severe findings first", () => {
    const commentableLines = computeCommentableLines([fileWithLines(30)]);
    // 25 info-level findings ahead of 5 critical ones in input order — the
    // critical ones must still make the cut.
    const findings = [
      ...Array.from({ length: 25 }, (_, i) => finding({ line: i + 1, severity: "info", title: `nit ${i}` })),
      ...Array.from({ length: 5 }, (_, i) => finding({ line: 26 + i, severity: "critical", title: `bug ${i}` })),
    ];
    const mappable = mapFindingsToInlineComments(findings, commentableLines).mappable;

    const { posted, overflow } = capInlineComments(mappable, 25);

    expect(posted.filter((c) => c.finding.severity === "critical")).toHaveLength(5);
    expect(overflow.every((f) => f.severity === "info")).toBe(true);
  });

  it("defaults to a cap of 25", () => {
    expect(capInlineComments(comments(40)).posted).toHaveLength(25);
  });
});

describe("formatSummaryComment overflow section", () => {
  it("renders overflow findings inside a collapsed details block", () => {
    const body = formatSummaryComment({
      summary: "Summary text.",
      findings: [finding({ title: "shown inline" })],
      overflowFindings: [finding({ title: "hidden overflow" })],
    });

    expect(body).toContain("<details>");
    expect(body).toContain("</details>");
    expect(body).toContain("1 more finding(s)");
    expect(body).toContain("hidden overflow");
  });

  it("keeps a blank line after </summary> so GitHub renders the Markdown inside", () => {
    const body = formatSummaryComment({
      summary: "Summary text.",
      findings: [],
      overflowFindings: [finding({ title: "hidden" })],
    });

    expect(body).toMatch(/<\/summary>\n\n/);
  });

  // The main findings list is itself made of <details> folders now (one per
  // severity), so the overflow block is identified by its own summary text
  // rather than by the tag, which is no longer unique in the body.
  it("omits the overflow block entirely when nothing overflowed", () => {
    const body = formatSummaryComment({ summary: "Summary text.", findings: [finding()] });

    expect(body).not.toContain("more finding(s)");
  });

  it("still lists non-overflow findings in the main section, above the overflow block", () => {
    const body = formatSummaryComment({
      summary: "Summary text.",
      findings: [finding({ title: "main one" })],
      overflowFindings: [finding({ title: "overflowed one" })],
    });

    const overflowStart = body.indexOf("more finding(s)");
    expect(body.indexOf("main one")).toBeLessThan(overflowStart);
    expect(body.indexOf("overflowed one")).toBeGreaterThan(overflowStart);
  });
});

describe("formatSummaryComment severity folders", () => {
  it("puts each severity in its own collapsed folder, worst first", () => {
    const body = formatSummaryComment({
      summary: "Summary text.",
      findings: [
        finding({ severity: "low", title: "a low one" }),
        finding({ severity: "critical", title: "a critical one" }),
        finding({ severity: "medium", title: "a medium one" }),
      ],
    });

    expect(body).toContain("<b>CRITICAL</b> · 1");
    expect(body).toContain("<b>MEDIUM</b> · 1");
    expect(body).toContain("<b>LOW</b> · 1");
    expect(body.indexOf("CRITICAL")).toBeLessThan(body.indexOf("MEDIUM"));
    expect(body.indexOf("MEDIUM")).toBeLessThan(body.indexOf("LOW"));
  });

  it("counts every finding of a severity in one folder", () => {
    const body = formatSummaryComment({
      summary: "Summary text.",
      findings: [
        finding({ severity: "low", title: "first low" }),
        finding({ severity: "low", title: "second low" }),
      ],
    });

    expect(body).toContain("<b>LOW</b> · 2");
    expect(body).toContain("first low");
    expect(body).toContain("second low");
  });

  it("omits severities with no findings rather than rendering empty folders", () => {
    const body = formatSummaryComment({ summary: "Summary text.", findings: [finding({ severity: "info" })] });

    expect(body).toContain("<b>INFO</b>");
    expect(body).not.toContain("CRITICAL");
    expect(body).not.toContain("HIGH");
  });

  it("leaves every folder closed — no severity is auto-expanded", () => {
    const body = formatSummaryComment({
      summary: "Summary text.",
      findings: [finding({ severity: "critical" }), finding({ severity: "info" })],
    });

    // An `open` attribute on any folder would expand it by default.
    expect(body).not.toContain("<details open>");
  });

  it("keeps the blank lines GitHub needs to render Markdown inside a folder", () => {
    const body = formatSummaryComment({ summary: "Summary text.", findings: [finding()] });

    expect(body).toMatch(/<\/summary>\n\n/);
    expect(body).toMatch(/\n\n<\/details>/);
  });

  it("still renders each finding's existing detail inside its folder", () => {
    const body = formatSummaryComment({
      summary: "Summary text.",
      findings: [
        finding({ severity: "medium", title: "the title", file: "src/a.ts", line: 12, suggestion: "- old\n+ new" }),
      ],
    });

    expect(body).toContain("`src/a.ts:12` — the title");
    expect(body).toContain("```diff");
    expect(body).toContain("+ new");
  });
});
