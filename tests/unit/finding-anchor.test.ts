import { describe, it, expect } from "vitest";
import { patchLineIndex, anchorLine, anchorFindings } from "@/lib/review/finding-anchor";
import type { PullRequestFile } from "@/lib/github/diff";

function file(filename: string, patch: string): PullRequestFile {
  return { filename, status: "modified", patch } as PullRequestFile;
}

/** The real shape that misplaced findings on drizzle-orm#6247: constants near the top of a new file. */
const MYSQL_ERRORS = [
  "@@ -0,0 +1,16 @@",
  "+import { entityKind, is } from '~/entity.ts';",
  "+",
  "+export const MYSQL_ERROR = {",
  "+\tDUP_ENTRY: 1062,",
  "+\tBAD_NULL_ERROR: 1048,",
  "+\tNO_REFERENCED_ROW: 1452,",
  "+\tNO_REFERENCED_ROW_2: 1216,",
  "+\tROW_IS_REFERENCED: 1451,",
  "+\tROW_IS_REFERENCED_2: 1217,",
  "+} as const;",
].join("\n");

describe("patchLineIndex", () => {
  it("numbers lines from the hunk header, skipping removals", () => {
    const index = patchLineIndex(
      ["@@ -10,3 +20,4 @@", " kept", "-gone", "+added", " tail"].join("\n"),
    );

    // The removed line consumes no post-change number, so `added` lands on 21.
    expect(index.get(20)).toBe("kept");
    expect(index.get(21)).toBe("added");
    expect(index.get(22)).toBe("tail");
    expect([...index.values()]).not.toContain("gone");
  });

  it("keeps numbering across several hunks", () => {
    const index = patchLineIndex(
      ["@@ -1,1 +1,1 @@", "+first", "@@ -50,1 +90,1 @@", "+later"].join("\n"),
    );

    expect(index.get(1)).toBe("first");
    expect(index.get(90)).toBe("later");
  });

  it("returns nothing for a file with no patch", () => {
    expect(patchLineIndex(undefined).size).toBe(0);
  });
});

describe("anchorLine", () => {
  const index = patchLineIndex(MYSQL_ERRORS);

  it("finds the line a quoted snippet sits on", () => {
    expect(anchorLine("\tNO_REFERENCED_ROW: 1452,", index)).toBe(6);
    expect(anchorLine("\tROW_IS_REFERENCED_2: 1217,", index)).toBe(9);
  });

  it("ignores indentation and tab/space differences", () => {
    expect(anchorLine("    NO_REFERENCED_ROW: 1452,", index)).toBe(6);
  });

  it("refuses to guess when the snippet matches nothing", () => {
    expect(anchorLine("NOT_IN_THIS_FILE: 1,", index)).toBeUndefined();
  });

  it("refuses to guess when the snippet is ambiguous", () => {
    const dup = patchLineIndex(["@@ -0,0 +1,3 @@", "+return undefined;", "+other();", "+return undefined;"].join("\n"));
    expect(anchorLine("return undefined;", dup)).toBeUndefined();
  });

  it("ignores snippets too short to identify a line", () => {
    expect(anchorLine("}", index)).toBeUndefined();
  });
});

describe("anchorFindings", () => {
  const files = [file("drizzle-orm/src/mysql-core/errors.ts", MYSQL_ERRORS)];

  it("corrects the real misplacement: reported at 110, actually line 6", () => {
    const { findings, stats } = anchorFindings(
      [{
        file: "drizzle-orm/src/mysql-core/errors.ts",
        line: 110,
        codeSnippet: "\tNO_REFERENCED_ROW: 1452,",
      }],
      files,
    );

    expect(findings[0].line).toBe(6);
    expect(stats).toEqual({ corrected: 1, confirmed: 0, unanchored: 0, delined: 0, dropped: 0 });
  });

  it("leaves a already-correct line alone and counts it confirmed", () => {
    const { findings, stats } = anchorFindings(
      [{ file: "drizzle-orm/src/mysql-core/errors.ts", line: 6, codeSnippet: "\tNO_REFERENCED_ROW: 1452," }],
      files,
    );

    expect(findings[0].line).toBe(6);
    expect(stats.confirmed).toBe(1);
    expect(stats.corrected).toBe(0);
  });

  it("strips the model's line when there is no snippet to anchor to", () => {
    const { findings, stats } = anchorFindings(
      [{ file: "drizzle-orm/src/mysql-core/errors.ts", line: 110 }],
      files,
    );

    // Kept, but with no line: a finding whose location nothing corroborates
    // still reaches the author through the summary body, where it cannot
    // point at unrelated code the way an unverified inline comment does.
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBeUndefined();
    expect(stats.unanchored).toBe(1);
    expect(stats.delined).toBe(1);
  });

  it("strips the line when the snippet matches nothing in the patch", () => {
    const { findings, stats } = anchorFindings(
      [{
        file: "drizzle-orm/src/mysql-core/errors.ts",
        line: 236,
        codeSnippet: "password: element instanceof HTMLInputElement,",
      }],
      files,
    );

    expect(findings[0].line).toBeUndefined();
    expect(stats.delined).toBe(1);
  });

  it("leaves findings about a file that is not in the diff untouched", () => {
    const { findings, stats } = anchorFindings(
      [{ file: "src/elsewhere.ts", line: 42, codeSnippet: "\tNO_REFERENCED_ROW: 1452," }],
      files,
    );

    expect(findings[0].line).toBe(42);
    expect(stats.unanchored).toBe(1);
  });

  it("does not mutate the findings it was given", () => {
    const original = { file: "drizzle-orm/src/mysql-core/errors.ts", line: 110, codeSnippet: "\tNO_REFERENCED_ROW: 1452," };
    anchorFindings([original], files);
    expect(original.line).toBe(110);
  });
});

/**
 * The shape that produced a High-severity security finding on LingoBridge#5:
 * the model reported a password flag as hardcoded false and supplied, as the
 * fix, the line already sitting in the file — differing only in quote style.
 */
describe("self-refuting suggestions", () => {
  const CAPTURE = [
    "@@ -1,4 +300,4 @@",
    "     const eligibility = evaluateSelection({",
    '+      password: element instanceof HTMLInputElement && element.type === "password",',
    "       supportedPage,",
    "     });",
  ].join("\n");
  const files = [file("apps/extension/entrypoints/selection.content.ts", CAPTURE)];

  it("drops a finding whose suggestion is already the file's content", () => {
    const { findings, stats } = anchorFindings(
      [{
        file: "apps/extension/entrypoints/selection.content.ts",
        line: 236,
        suggestion: "  password: element instanceof HTMLInputElement && element.type === 'password',",
      }],
      files,
    );

    expect(findings).toHaveLength(0);
    expect(stats.dropped).toBe(1);
  });

  it("keeps a finding whose suggestion genuinely differs from the file", () => {
    const { findings, stats } = anchorFindings(
      [{
        file: "apps/extension/entrypoints/selection.content.ts",
        line: 301,
        suggestion: '      password: element instanceof HTMLInputElement && element.type === "secret",',
      }],
      files,
    );

    expect(findings).toHaveLength(1);
    expect(stats.dropped).toBe(0);
  });

  it("does not drop on a short line that happens to appear in the file", () => {
    const SHORT = ["@@ -1,2 +10,2 @@", "+    return null;", "     }"].join("\n");
    const { findings, stats } = anchorFindings(
      [{ file: "a.ts", line: 10, suggestion: "    return null;" }],
      [file("a.ts", SHORT)],
    );

    expect(findings).toHaveLength(1);
    expect(stats.dropped).toBe(0);
  });
});
