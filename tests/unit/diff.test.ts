import { describe, it, expect, vi, beforeEach } from "vitest";

const { requestMock, paginateMock, buildFallbackPatchMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  paginateMock: vi.fn(),
  buildFallbackPatchMock: vi.fn(),
}));

vi.mock("@/lib/github/app", () => ({
  getInstallationOctokit: vi.fn().mockResolvedValue({ request: requestMock, paginate: paginateMock }),
}));

vi.mock("@/lib/github/patch-fallback", () => ({
  buildFallbackPatch: buildFallbackPatchMock,
  diffUnavailableNote: (name: string, reason: string) => `@@ -0,0 +0,0 @@\n# DIFF UNAVAILABLE for ${name}: ${reason}.`,
}));

import { getIncrementalDiff, getPullRequestDiff, GITHUB_MAX_PR_FILES } from "@/lib/github/diff";

/** The compare endpoint is paginated as pages, each carrying its own `files` slice. */
function comparePages(...pages: unknown[][]) {
  return pages.map((files) => ({ files }));
}

describe("getIncrementalDiff", () => {
  beforeEach(() => {
    requestMock.mockReset();
    paginateMock.mockReset();
    buildFallbackPatchMock.mockReset();
  });

  it("maps the compare API's files into the shared PullRequestDiff shape", async () => {
    paginateMock.mockResolvedValue(
      comparePages([
        { filename: "src/e.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new", changes: 2 },
        { filename: "src/f.ts", status: "modified", patch: "@@ -2 +2 @@\n-a\n+b", changes: 2 },
      ]),
    );

    const diff = await getIncrementalDiff(1, "acme", "widgets", "abc123", "def456");

    expect(diff.fileCount).toBe(2);
    expect(diff.files.map((f) => f.filename)).toEqual(["src/e.ts", "src/f.ts"]);
    expect(diff.files.every((f) => f.patchSource === "github")).toBe(true);
    expect(diff.totalChangedLines).toBe(4);
    expect(diff.diffText).toContain("--- a/src/e.ts");
    expect(diff.diffText).toContain("--- a/src/f.ts");
  });

  it("requests the compare endpoint with base...head", async () => {
    paginateMock.mockResolvedValue(comparePages([]));

    await getIncrementalDiff(1, "acme", "widgets", "abc123", "def456");

    expect(paginateMock).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/compare/{basehead}",
      expect.objectContaining({ owner: "acme", repo: "widgets", basehead: "abc123...def456" }),
    );
  });

  it("deduplicates a file that appears on more than one compare page", async () => {
    // compare pages over commits, not files, so the same file can come back
    // on several pages. Reviewing it twice would double its cost and produce
    // duplicate findings.
    const entry = { filename: "src/same.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b", changes: 2 };
    paginateMock.mockResolvedValue(comparePages([entry], [entry]));

    const diff = await getIncrementalDiff(1, "acme", "widgets", "abc123", "def456");

    expect(diff.fileCount).toBe(1);
    expect(diff.totalChangedLines).toBe(2);
  });

  it("prefers the copy that has a patch when a file repeats across pages", async () => {
    paginateMock.mockResolvedValue(
      comparePages(
        [{ filename: "src/same.ts", status: "modified", changes: 2 }],
        [{ filename: "src/same.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b", changes: 2 }],
      ),
    );

    const diff = await getIncrementalDiff(1, "acme", "widgets", "abc123", "def456");

    expect(diff.files).toHaveLength(1);
    expect(diff.files[0].patch).toContain("+b");
  });

  it("concatenates files across every compare page instead of stopping at the first", async () => {
    paginateMock.mockResolvedValue(
      comparePages(
        [{ filename: "src/page1.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b", changes: 2 }],
        [{ filename: "src/page2.ts", status: "modified", patch: "@@ -1 +1 @@\n-c\n+d", changes: 2 }],
      ),
    );

    const diff = await getIncrementalDiff(1, "acme", "widgets", "abc123", "def456");

    expect(diff.files.map((f) => f.filename)).toEqual(["src/page1.ts", "src/page2.ts"]);
  });

  it("returns an empty diff (fileCount 0) when nothing changed between the two commits", async () => {
    paginateMock.mockResolvedValue(comparePages([]));

    const diff = await getIncrementalDiff(1, "acme", "widgets", "abc123", "abc123");

    expect(diff.fileCount).toBe(0);
    expect(diff.diffText).toBe("");
    expect(diff.files).toEqual([]);
  });

  it("propagates a rejection if the compare call fails (caller decides fallback)", async () => {
    paginateMock.mockRejectedValue(new Error("404 Not Found"));

    await expect(getIncrementalDiff(1, "acme", "widgets", "abc123", "def456")).rejects.toThrow("404 Not Found");
  });
});

describe("getPullRequestDiff", () => {
  beforeEach(() => {
    requestMock.mockReset();
    paginateMock.mockReset();
    buildFallbackPatchMock.mockReset();
  });

  it("returns every file the endpoint pages through, not just the first page", async () => {
    // 250 files is the acceptance case: the old 30-per-page default and the
    // old 3-page manual loop both truncated well before this.
    const files = Array.from({ length: 250 }, (_, i) => ({
      filename: `src/file${i}.ts`,
      status: "modified",
      patch: "@@ -1 +1 @@\n-a\n+b",
      changes: 2,
    }));
    paginateMock.mockResolvedValue(files);

    const diff = await getPullRequestDiff(1, "acme", "widgets", 7);

    expect(diff.fileCount).toBe(250);
    expect(diff.totalChangedLines).toBe(500);
    expect(diff.oversized).toBeUndefined();
  });

  it("asks for 100 per page rather than the 30-per-page default", async () => {
    paginateMock.mockResolvedValue([]);

    await getPullRequestDiff(1, "acme", "widgets", 7);

    expect(paginateMock).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      expect.objectContaining({ per_page: 100, pull_number: 7 }),
    );
  });

  it("flags a PR at the endpoint's hard ceiling as oversized instead of reviewing a truncated list", async () => {
    paginateMock.mockResolvedValue(
      Array.from({ length: GITHUB_MAX_PR_FILES }, (_, i) => ({
        filename: `src/file${i}.ts`,
        status: "modified",
        patch: "@@ -1 +1 @@\n-a\n+b",
        changes: 2,
      })),
    );

    const diff = await getPullRequestDiff(1, "acme", "widgets", 7);

    expect(diff.oversized).toBe(true);
  });

  it("reconstructs a diff locally when GitHub returns patch: null", async () => {
    paginateMock.mockResolvedValue([
      { filename: "src/huge.ts", status: "modified", patch: null, changes: 15000 },
    ]);
    requestMock.mockResolvedValue({ data: { base: { sha: "base1" }, head: { sha: "head1" } } });
    buildFallbackPatchMock.mockResolvedValue({ patch: "@@ -1,2 +1,2 @@\n-old\n+new", originalChars: 24 });

    const diff = await getPullRequestDiff(1, "acme", "widgets", 7);

    expect(buildFallbackPatchMock).toHaveBeenCalledWith(1, "acme", "widgets", "src/huge.ts", "modified", "base1", "head1");
    expect(diff.files[0].patch).toContain("+new");
    expect(diff.files[0].patchSource).toBe("local");
    expect(diff.diffText).toContain("src/huge.ts");
  });

  it("marks a file whose diff cannot be obtained as unavailable rather than dropping it", async () => {
    paginateMock.mockResolvedValue([
      { filename: "src/opaque.bin", status: "modified", patch: null, changes: 9000 },
    ]);
    requestMock.mockResolvedValue({ data: { base: { sha: "base1" }, head: { sha: "head1" } } });
    buildFallbackPatchMock.mockResolvedValue({
      patch: "@@ -0,0 +0,0 @@\n# DIFF UNAVAILABLE for src/opaque.bin: unreadable.",
      originalChars: 0,
    });

    const diff = await getPullRequestDiff(1, "acme", "widgets", 7);

    expect(diff.files).toHaveLength(1);
    expect(diff.files[0].patchSource).toBe("unavailable");
    // Still present in the text sent onward, so it can never read as "clean".
    expect(diff.diffText).toContain("DIFF UNAVAILABLE");
  });

  it("does not spend an API call fetching base/head SHAs when every file has a patch", async () => {
    paginateMock.mockResolvedValue([
      { filename: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b", changes: 2 },
    ]);

    await getPullRequestDiff(1, "acme", "widgets", 7);

    expect(requestMock).not.toHaveBeenCalled();
    expect(buildFallbackPatchMock).not.toHaveBeenCalled();
  });

  it("does not try to reconstruct a deleted file's diff", async () => {
    paginateMock.mockResolvedValue([{ filename: "src/gone.ts", status: "removed", patch: null, changes: 40 }]);

    await getPullRequestDiff(1, "acme", "widgets", 7);

    expect(buildFallbackPatchMock).not.toHaveBeenCalled();
  });
});
