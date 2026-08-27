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

  it("omits the details block entirely when nothing overflowed", () => {
    const body = formatSummaryComment({ summary: "Summary text.", findings: [finding()] });

    expect(body).not.toContain("<details>");
  });

  it("still lists non-overflow findings in the main section", () => {
    const body = formatSummaryComment({
      summary: "Summary text.",
      findings: [finding({ title: "main one" })],
      overflowFindings: [finding({ title: "overflowed one" })],
    });

    expect(body.indexOf("main one")).toBeLessThan(body.indexOf("<details>"));
    expect(body.indexOf("overflowed one")).toBeGreaterThan(body.indexOf("<details>"));
  });
});
