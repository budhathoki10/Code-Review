import { describe, it, expect } from "vitest";
import { computeCommentableLines, mapFindingsToInlineComments } from "@/lib/github/diff-lines";
import type { PullRequestFile } from "@/lib/github/diff";
import type { FindingDoc } from "@/lib/db/collections";

const SAMPLE_PATCH = [
  "@@ -10,3 +10,4 @@ function greet() {",
  " function greet() {",
  "-  console.log('hi')",
  "+  console.log('hello')",
  "+  console.log('added line')",
  " }",
].join("\n");

function file(overrides: Partial<PullRequestFile> = {}): PullRequestFile {
  return { filename: "src/greet.ts", status: "modified", patch: SAMPLE_PATCH, ...overrides };
}

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

describe("computeCommentableLines", () => {
  it("marks added lines as commentable", () => {
    const result = computeCommentableLines([file()]);
    // hunk starts at new-file line 10; " function greet()" = 10,
    // "-  console.log('hi')" doesn't advance, "+  console.log('hello')" = 11,
    // "+  console.log('added line')" = 12, " }" = 13
    expect(result.get("src/greet.ts")).toEqual(new Set([10, 11, 12, 13]));
  });

  it("does not mark removed (old-file-only) lines as commentable", () => {
    const result = computeCommentableLines([file()]);
    const commentable = result.get("src/greet.ts")!;
    // line 10 (the removed console.log) never gets a new-file line number
    // assigned to it beyond what context/added lines already claim
    expect(commentable.size).toBe(4);
  });

  it("skips files with no patch (binary files)", () => {
    const result = computeCommentableLines([file({ patch: undefined })]);
    expect(result.has("src/greet.ts")).toBe(false);
  });

  it("handles multiple hunks in the same file independently", () => {
    const multiHunkPatch = [
      "@@ -1,2 +1,2 @@",
      "-old first line",
      "+new first line",
      " unchanged",
      "@@ -50,2 +50,3 @@",
      " context",
      "+another new line",
    ].join("\n");

    const result = computeCommentableLines([file({ patch: multiHunkPatch })]);
    expect(result.get("src/greet.ts")).toEqual(new Set([1, 2, 50, 51]));
  });

  it("ignores the 'no newline at end of file' marker line", () => {
    const patchWithMarker = ["@@ -1,1 +1,1 @@", "-old", "+new", "\\ No newline at end of file"].join("\n");

    const result = computeCommentableLines([file({ patch: patchWithMarker })]);
    expect(result.get("src/greet.ts")).toEqual(new Set([1]));
  });
});

describe("mapFindingsToInlineComments", () => {
  it("maps a finding to an inline comment when its line is commentable", () => {
    const commentableLines = computeCommentableLines([file()]);
    const { mappable, unmappable } = mapFindingsToInlineComments(
      [finding({ line: 11 })],
      commentableLines,
    );

    expect(mappable).toHaveLength(1);
    expect(mappable[0]).toMatchObject({ path: "src/greet.ts", line: 11 });
    expect(unmappable).toHaveLength(0);
  });

  it("treats a finding with no line number as unmappable", () => {
    const commentableLines = computeCommentableLines([file()]);
    const { mappable, unmappable } = mapFindingsToInlineComments([finding({ line: undefined })], commentableLines);

    expect(mappable).toHaveLength(0);
    expect(unmappable).toHaveLength(1);
  });

  it("treats a finding pointing at a non-diff line as unmappable", () => {
    const commentableLines = computeCommentableLines([file()]);
    // line 999 was never part of the diff
    const { mappable, unmappable } = mapFindingsToInlineComments([finding({ line: 999 })], commentableLines);

    expect(mappable).toHaveLength(0);
    expect(unmappable).toHaveLength(1);
  });

  it("treats a finding for a file outside the diff as unmappable", () => {
    const commentableLines = computeCommentableLines([file()]);
    const { mappable, unmappable } = mapFindingsToInlineComments(
      [finding({ file: "src/unrelated.ts", line: 11 })],
      commentableLines,
    );

    expect(mappable).toHaveLength(0);
    expect(unmappable).toHaveLength(1);
  });

  it("splits a mixed batch of findings into mappable and unmappable", () => {
    const commentableLines = computeCommentableLines([file()]);
    const { mappable, unmappable } = mapFindingsToInlineComments(
      [finding({ line: 11 }), finding({ line: undefined }), finding({ line: 999 })],
      commentableLines,
    );

    expect(mappable).toHaveLength(1);
    expect(unmappable).toHaveLength(2);
  });
});
