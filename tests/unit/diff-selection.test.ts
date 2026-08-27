import { describe, it, expect } from "vitest";

import { selectDiffForReview, formatCoverageNote } from "@/lib/review/diff-selection";
import { MAX_DIFF_CHARS, MAX_DIFF_FILES, type PullRequestFile } from "@/lib/github/diff";

function file(filename: string, patchLength = 100): PullRequestFile {
  return { filename, patch: "x".repeat(patchLength), status: "modified" };
}

describe("selectDiffForReview", () => {
  it("drops generated, vendored and binary files as noise", () => {
    const selection = selectDiffForReview([
      file("src/app.ts"),
      file("package-lock.json"),
      file("pnpm-lock.yaml"),
      file("dist/bundle.js"),
      file("node_modules/lib/index.js"),
      file("assets/logo.png"),
      file("styles/site.min.css"),
      file("src/__snapshots__/app.test.ts.snap"),
    ]);

    expect(selection.analyzableFiles.map((f) => f.filename)).toEqual(["src/app.ts"]);
    expect(selection.skippedAsNoise).toHaveLength(7);
    // Noise is never reported to the author as "unreviewed" — nobody wants it reviewed.
    expect(selection.skippedForBudget).toEqual([]);
  });

  it("skips files with no patch (binary blobs GitHub gives no diff for)", () => {
    const selection = selectDiffForReview([
      { filename: "src/app.ts", patch: "x".repeat(50), status: "modified" },
      { filename: "src/blob.bin", status: "modified" },
    ]);

    expect(selection.analyzableFiles.map((f) => f.filename)).toEqual(["src/app.ts"]);
  });

  it("ranks source files ahead of tests and docs", () => {
    const selection = selectDiffForReview([
      file("README.md"),
      file("tests/app.test.ts"),
      file("src/app.ts"),
    ]);

    expect(selection.chunks[0].files.map((f) => f.filename)).toEqual([
      "src/app.ts",
      "tests/app.test.ts",
      "README.md",
    ]);
  });

  it("keeps everything in one chunk when it fits", () => {
    const selection = selectDiffForReview([file("src/a.ts"), file("src/b.ts"), file("src/c.ts")]);

    expect(selection.chunks).toHaveLength(1);
    expect(selection.skippedForBudget).toEqual([]);
    expect(selection.truncatedFiles).toEqual([]);
  });

  it("splits into multiple chunks once the char budget is exceeded", () => {
    // Three files that individually fit but collectively exceed one chunk.
    const half = Math.floor(MAX_DIFF_CHARS * 0.5);
    const selection = selectDiffForReview([
      file("src/a.ts", half),
      file("src/b.ts", half),
      file("src/c.ts", half),
    ]);

    expect(selection.chunks.length).toBeGreaterThan(1);
    for (const chunk of selection.chunks) {
      const chars = chunk.files.reduce((sum, f) => sum + (f.patch?.length ?? 0), 0);
      expect(chars).toBeLessThanOrEqual(MAX_DIFF_CHARS);
    }
  });

  it("splits once the per-chunk file cap is exceeded", () => {
    const files = Array.from({ length: MAX_DIFF_FILES + 5 }, (_, i) => file(`src/f${i}.ts`, 10));
    const selection = selectDiffForReview(files);

    expect(selection.chunks.length).toBeGreaterThan(1);
    expect(selection.chunks[0].files.length).toBeLessThanOrEqual(MAX_DIFF_FILES);
  });

  it("truncates a single oversized file instead of dropping it", () => {
    const selection = selectDiffForReview([file("src/huge.ts", MAX_DIFF_CHARS * 2)]);

    expect(selection.truncatedFiles).toEqual(["src/huge.ts"]);
    expect(selection.chunks).toHaveLength(1);
    const patch = selection.chunks[0].files[0].patch ?? "";
    expect(patch.length).toBeLessThan(MAX_DIFF_CHARS);
    expect(patch).toContain("patch truncated");
  });

  it("never reviews zero chunks for a PR that has real changes", () => {
    const files = Array.from({ length: 500 }, (_, i) => file(`src/f${i}.ts`, 5_000));
    const selection = selectDiffForReview(files);

    expect(selection.chunks.length).toBeGreaterThan(0);
  });

  it("reports overflow files rather than dropping them silently", () => {
    const files = Array.from({ length: 500 }, (_, i) => file(`src/f${i}.ts`, 5_000));
    const selection = selectDiffForReview(files);

    const reviewed = selection.chunks.flatMap((chunk) => chunk.files.map((f) => f.filename));
    // Every analyzable file is either reviewed or explicitly reported.
    expect(reviewed.length + selection.skippedForBudget.length).toBe(selection.analyzableFiles.length);
    expect(selection.skippedForBudget.length).toBeGreaterThan(0);
  });

  it("returns no chunks when only noise changed", () => {
    const selection = selectDiffForReview([file("package-lock.json"), file("dist/out.js")]);

    expect(selection.chunks).toEqual([]);
    expect(selection.analyzableFiles).toEqual([]);
  });
});

describe("formatCoverageNote", () => {
  it("is empty when coverage was complete", () => {
    const selection = selectDiffForReview([file("src/a.ts")]);
    expect(formatCoverageNote(selection)).toBe("");
  });

  it("reports unreviewed files", () => {
    const files = Array.from({ length: 500 }, (_, i) => file(`src/f${i}.ts`, 5_000));
    const note = formatCoverageNote(selectDiffForReview(files));

    expect(note).toContain("were not reviewed");
    expect(note).toContain("smaller pull requests");
  });

  it("reports partially reviewed files", () => {
    const note = formatCoverageNote(selectDiffForReview([file("src/huge.ts", MAX_DIFF_CHARS * 2)]));

    expect(note).toContain("only partially reviewed");
    expect(note).toContain("src/huge.ts");
  });

  it("states how many files were skipped and why, without listing their names", () => {
    const note = formatCoverageNote(selectDiffForReview([file("src/a.ts"), file("package-lock.json")]));

    // Phase 2 requires the count and the reason to be stated...
    expect(note).toContain("1 file(s) were skipped");
    expect(note).toContain("generated, vendored, or binary");
    // ...but naming 30 lockfiles would bury the part that matters.
    expect(note).not.toContain("package-lock.json");
  });

  it("does not advise splitting the PR when nothing was skipped for size", () => {
    const note = formatCoverageNote(selectDiffForReview([file("src/a.ts"), file("package-lock.json")]));

    expect(note).not.toContain("smaller pull requests");
  });

  it("returns an empty note when nothing was skipped at all", () => {
    expect(formatCoverageNote(selectDiffForReview([file("src/a.ts")]))).toBe("");
  });
});
