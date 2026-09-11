import { describe, it, expect, vi, beforeEach } from "vitest";

const { getFileContentMock } = vi.hoisted(() => ({ getFileContentMock: vi.fn() }));

vi.mock("@/lib/github/file-content", () => ({ getFileContent: getFileContentMock }));

import { buildFallbackPatch, buildReplacementPatch, diffUnavailableNote } from "@/lib/github/patch-fallback";
import { computeCommentableLines } from "@/lib/github/diff-lines";
import { applyPatch } from "diff";

describe("buildFallbackPatch", () => {
  beforeEach(() => {
    getFileContentMock.mockReset();
    delete process.env.MAX_GENERATED_PATCH_CHARS;
  });

  it("produces a unified diff from the file's content at both refs", async () => {
    getFileContentMock.mockImplementation((_i: number, _o: string, _r: string, _p: string, ref: string) =>
      Promise.resolve(ref === "base" ? "line one\nline two\nline three\n" : "line one\nCHANGED\nline three\n"),
    );

    const { patch } = await buildFallbackPatch(1, "acme", "widgets", "src/a.ts", "modified", "base", "head");

    expect(patch.startsWith("@@")).toBe(true);
    expect(patch).toContain("-line two");
    expect(patch).toContain("+CHANGED");
  });

  it("produces a patch the existing hunk parser can read line numbers out of", async () => {
    getFileContentMock.mockImplementation((_i: number, _o: string, _r: string, _p: string, ref: string) =>
      Promise.resolve(ref === "base" ? "a\nb\nc\n" : "a\nB\nc\n"),
    );

    const { patch } = await buildFallbackPatch(1, "acme", "widgets", "src/a.ts", "modified", "base", "head");
    const commentable = computeCommentableLines([{ filename: "src/a.ts", status: "modified", patch }]);

    // The changed line must be commentable, or inline comments can never
    // attach to a locally-reconstructed diff.
    expect(commentable.get("src/a.ts")?.has(2)).toBe(true);
  });

  it("does not ask for the base version of an added file", async () => {
    getFileContentMock.mockResolvedValue("brand new\n");

    await buildFallbackPatch(1, "acme", "widgets", "src/new.ts", "added", "base", "head");

    const refs = getFileContentMock.mock.calls.map((call: unknown[]) => call[4]);
    expect(refs).toEqual(["head"]);
  });

  it("reports diff unavailable when neither side can be read", async () => {
    getFileContentMock.mockResolvedValue(undefined);

    const { patch } = await buildFallbackPatch(1, "acme", "widgets", "src/a.ts", "modified", "base", "head");

    expect(patch).toContain("DIFF UNAVAILABLE");
    expect(patch).toContain("src/a.ts");
  });

  it("reports diff unavailable when only one side can be read", async () => {
    getFileContentMock.mockImplementation((_i: number, _o: string, _r: string, _p: string, ref: string) =>
      Promise.resolve(ref === "base" ? "content\n" : undefined),
    );

    const { patch } = await buildFallbackPatch(1, "acme", "widgets", "src/a.ts", "modified", "base", "head");

    expect(patch).toContain("DIFF UNAVAILABLE");
  });

  it("retains the tail of a reconstructed patch even with the legacy truncation setting", async () => {
    // The budget is read at module load, so the module is reloaded with it set.
    process.env.MAX_GENERATED_PATCH_CHARS = "500";
    vi.resetModules();
    const { buildFallbackPatch: build } = await import("@/lib/github/patch-fallback");

    const base = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const head = Array.from({ length: 2000 }, (_, i) => `CHANGED ${i}`).join("\n");
    getFileContentMock.mockImplementation((_i: number, _o: string, _r: string, _p: string, ref: string) =>
      Promise.resolve(ref === "base" ? base : head),
    );

    const { patch } = await build(1, "acme", "widgets", "src/big.ts", "modified", "base", "head");

    expect(patch).not.toContain("truncated");
    expect(patch).toContain("+CHANGED 1999");
    expect(patch).toContain("-line 1999");
  });

  it("marks successfully read identical content as metadata, not unavailable", async () => {
    getFileContentMock.mockResolvedValue("same\n");

    const { patch } = await buildFallbackPatch(1, "acme", "widgets", "src/a.ts", "modified", "base", "head");

    expect(patch.length).toBeGreaterThan(0);
    expect(patch).toContain("No text changes");
    expect(patch).not.toContain("DIFF UNAVAILABLE");
  });

  it("the timeout fallback preserves both complete versions", () => {
    const base = "old\nlast old";
    const head = "new\nlast new";
    const patch = buildReplacementPatch(base, head);
    expect(applyPatch(base, `--- a/rewrite.ts\n+++ b/rewrite.ts\n${patch}`)).toBe(head);
  });

  it("reads the previous path when reconstructing a rename", async () => {
    getFileContentMock.mockResolvedValue("same\n");
    const { patch } = await buildFallbackPatch(1, "acme", "widgets", "new.ts", "renamed", "base", "head", "old.ts");
    expect(getFileContentMock.mock.calls.map((call) => [call[3], call[4]])).toEqual([["old.ts", "base"], ["new.ts", "head"]]);
    expect(patch).toContain("previous path: old.ts");
  });
});

describe("diffUnavailableNote", () => {
  it("states the file was not reviewed, so a clean review can't be misread", () => {
    const note = diffUnavailableNote("src/a.ts", "too large");

    expect(note).toContain("src/a.ts");
    expect(note).toContain("NOT reviewed");
  });
});
