import { describe, it, expect, vi, beforeEach } from "vitest";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock("@/lib/github/app", () => ({
  getInstallationOctokit: vi.fn().mockResolvedValue({ request: requestMock }),
}));

import { getIncrementalDiff } from "@/lib/github/diff";

describe("getIncrementalDiff", () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it("maps the compare API's files into the shared PullRequestDiff shape", async () => {
    requestMock.mockResolvedValue({
      data: {
        files: [
          { filename: "src/e.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" },
          { filename: "src/f.ts", status: "modified", patch: "@@ -2 +2 @@\n-a\n+b" },
        ],
      },
    });

    const diff = await getIncrementalDiff(1, "acme", "widgets", "abc123", "def456");

    expect(diff.fileCount).toBe(2);
    expect(diff.files).toEqual([
      { filename: "src/e.ts", patch: "@@ -1 +1 @@\n-old\n+new", status: "modified" },
      { filename: "src/f.ts", patch: "@@ -2 +2 @@\n-a\n+b", status: "modified" },
    ]);
    expect(diff.diffText).toContain("--- a/src/e.ts");
    expect(diff.diffText).toContain("--- a/src/f.ts");
  });

  it("requests the compare endpoint with base...head", async () => {
    requestMock.mockResolvedValue({ data: { files: [] } });

    await getIncrementalDiff(1, "acme", "widgets", "abc123", "def456");

    expect(requestMock).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/compare/{basehead}",
      expect.objectContaining({ owner: "acme", repo: "widgets", basehead: "abc123...def456" }),
    );
  });

  it("returns an empty diff (fileCount 0) when nothing changed between the two commits", async () => {
    requestMock.mockResolvedValue({ data: { files: [] } });

    const diff = await getIncrementalDiff(1, "acme", "widgets", "abc123", "abc123");

    expect(diff.fileCount).toBe(0);
    expect(diff.diffText).toBe("");
    expect(diff.files).toEqual([]);
  });

  it("skips binary files (no patch) when building diffText, but still counts them", async () => {
    requestMock.mockResolvedValue({
      data: {
        files: [
          { filename: "image.png", status: "modified" }, // no patch — binary
          { filename: "src/g.ts", status: "modified", patch: "@@ -1 +1 @@\n-x\n+y" },
        ],
      },
    });

    const diff = await getIncrementalDiff(1, "acme", "widgets", "abc123", "def456");

    expect(diff.fileCount).toBe(2);
    expect(diff.diffText).not.toContain("image.png");
    expect(diff.diffText).toContain("src/g.ts");
  });

  it("propagates a rejection if the compare call fails (caller decides fallback)", async () => {
    requestMock.mockRejectedValue(new Error("404 Not Found"));

    await expect(getIncrementalDiff(1, "acme", "widgets", "abc123", "def456")).rejects.toThrow("404 Not Found");
  });
});
