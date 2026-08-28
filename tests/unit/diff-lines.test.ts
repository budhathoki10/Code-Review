import { describe, it, expect } from "vitest";
import {
  computeCommentableLines,
  mapFindingsToInlineComments,
  looksLikeCleanCodeSuggestion,
} from "@/lib/github/diff-lines";
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

/**
 * Gate for GitHub's one-click "commit suggestion" rendering.
 *
 * GitHub applies a ```suggestion block as the literal replacement for the
 * commented line, so a false positive here offers a developer a sentence to
 * click-apply as code. A false negative merely renders as a plain block,
 * which is always correct — hence the deliberately prose-biased checks.
 */
describe("looksLikeCleanCodeSuggestion", () => {
  it("accepts a clean single-line replacement", () => {
    expect(looksLikeCleanCodeSuggestion("await saveUser(user);")).toBe(true);
  });

  it("accepts a multi-line replacement body — only the ORIGINAL line must be single", () => {
    expect(
      looksLikeCleanCodeSuggestion("const user = await findUser(id);\nif (!user) return null;\nreturn user.name;"),
    ).toBe(true);
  });

  // Verbatim samples from the reviews collection — every real suggestion
  // produced so far is prose, and none may reach the suggestion fence.
  it.each([
    "Consider redirecting to the canonical URL for the applied filter (e.g., `?view=all`) when the requested PR filter is invalid, or at minimum document this behavior.",
    "Consider combining the countDocuments and distinct into a single aggregation pipeline, or accept the current approach as the data volumes are likely small enough that the simplicity is worth it.",
    "Add a comment explaining the fallback priority, or make the fallback consistent (always 'latest' unless explicitly requested 'all').",
    "Move the `needsFallback` check and `fillMissingPatches` call before the `oversized` check, or run it regardless of `oversized` since the bail-out comment needs accurate diff availability data.",
    "Confirm this is intentional. If the goal is to only auto-open the very first review across all pages, restore the `currentPage === 1 && i === 0` condition.",
  ])("rejects real prose advice: %s", (prose) => {
    expect(looksLikeCleanCodeSuggestion(prose)).toBe(false);
  });

  it("rejects a +/- patch — a suggestion block is a replacement, not a diff", () => {
    expect(looksLikeCleanCodeSuggestion("- const a = 1;\n+ const a = 2;")).toBe(false);
  });

  it("rejects a hunk header", () => {
    expect(looksLikeCleanCodeSuggestion("@@ -1,2 +1,2 @@\nconst a = 2;")).toBe(false);
  });

  it("rejects content that already carries its own code fence", () => {
    expect(looksLikeCleanCodeSuggestion("```ts\nconst a = 2;\n```")).toBe(false);
  });

  it("rejects empty or whitespace-only text", () => {
    expect(looksLikeCleanCodeSuggestion("")).toBe(false);
    expect(looksLikeCleanCodeSuggestion("   \n  ")).toBe(false);
  });

  it("does not reject an identifier that merely contains a marker word", () => {
    // Guards the word-boundary anchors: `orDefault` contains "or",
    // `shouldRetry` contains "should" — both are ordinary code.
    expect(looksLikeCleanCodeSuggestion("return orDefault(value);")).toBe(true);
    expect(looksLikeCleanCodeSuggestion("const shouldRetry = attempts < max;")).toBe(true);
  });
});

describe("inline comment fence selection", () => {
  function bodyFor(suggestion: string | undefined): string {
    const { mappable } = mapFindingsToInlineComments(
      [finding({ line: 11, suggestion })],
      computeCommentableLines([file()]),
    );
    return mappable[0].body;
  }

  it("uses a suggestion fence for clean code, so GitHub renders the commit button", () => {
    expect(bodyFor("await saveUser(user);")).toContain("```suggestion\nawait saveUser(user);\n```");
  });

  it("keeps the plain diff fence for prose, so a sentence is never offered as committable code", () => {
    const body = bodyFor("Consider combining these two queries into one aggregation.");

    expect(body).toContain("```diff");
    expect(body).not.toContain("```suggestion");
  });

  it("still renders the explanation alongside either fence", () => {
    expect(bodyFor("await saveUser(user);")).toContain("example explanation");
  });

  it("emits no fence at all when the finding has no suggestion", () => {
    const body = bodyFor(undefined);

    expect(body).not.toContain("```");
    expect(body).toContain("example explanation");
  });
});
