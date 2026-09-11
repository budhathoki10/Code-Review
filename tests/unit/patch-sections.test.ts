import { describe, expect, it } from "vitest";
import { applyPatch, createTwoFilesPatch } from "diff";
import { splitPatchSections } from "@/lib/review/patch-sections";
import { selectDiffForReview } from "@/lib/review/diff-selection";
import { computeCommentableLines } from "@/lib/github/diff-lines";

describe("complete large-patch sections", () => {
  it.each(["added", "removed", "modified"])("reassembles a %s file exactly, including the final changed line", (status) => {
    const base = status === "added" ? "" : Array.from({ length: 1500 }, (_, i) => `old ${i}\n`).join("");
    const head = status === "removed" ? "" : Array.from({ length: 1500 }, (_, i) => `new ${i}\n`).join("");
    const diff = createTwoFilesPatch("a/file.ts", "b/file.ts", base, head);
    const patch = diff.slice(diff.indexOf("@@"));
    const parts = splitPatchSections(patch, 1000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 1000)).toBe(true);
    expect(applyPatch(base, `--- a/file.ts\n+++ b/file.ts\n${parts.join("")}`)).toBe(head);
    const original = computeCommentableLines([{ filename: "file.ts", status, patch }]).get("file.ts");
    const collected = new Set(parts.flatMap((part) => [...(computeCommentableLines([{ filename: "file.ts", status, patch: part }]).get("file.ts") ?? [])]));
    expect(collected).toEqual(original ?? new Set());
  });

  it("retains both no-newline markers with the lines they describe", () => {
    const diff = createTwoFilesPatch("a/f", "b/f", "a\n".repeat(100) + "OLD END", "b\n".repeat(100) + "NEW END");
    const sections = splitPatchSections(diff.slice(diff.indexOf("@@")), 256);
    expect(sections.join("")).toContain("-OLD END\n\\ No newline at end of file");
    expect(sections.join("")).toContain("+NEW END\n\\ No newline at end of file");
  });

  it("preserves separated hunks and their original offsets", () => {
    const base = Array.from({ length: 1000 }, (_, i) => `line ${i}\n`).join("");
    const head = base.replace("line 10\n", "CHANGED\n").replace("line 990\n", "TAIL\n");
    const diff = createTwoFilesPatch("a/file.ts", "b/file.ts", base, head);
    const patch = diff.slice(diff.indexOf("@@"));
    expect(applyPatch(base, `--- a/file.ts\n+++ b/file.ts\n${splitPatchSections(patch, 150).join("")}`)).toBe(head);
  });

  it("schedules 458 text files, including docs, deletions, SVG and whitespace-sensitive changes", () => {
    const files = Array.from({ length: 454 }, (_, i) => ({ filename: `src/${i}.ts`, status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }));
    files.push(
      { filename: "README.md", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" },
      { filename: "src/gone.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-deleted" },
      { filename: "icon.svg", status: "added", patch: "@@ -0,0 +1 @@\n+<svg/>" },
      { filename: "src/string.ts", status: "modified", patch: '@@ -1 +1 @@\n-const a="a b";\n+const a="ab";' },
    );
    const selection = selectDiffForReview(files);
    expect(selection.coveredCount).toBe(458);
    expect(selection.skippedForBudget).toEqual([]);
    expect(selection.triaged).toEqual([]);
  });

  it("includes generated text and lockfiles by default, while respecting path exclusions", () => {
    const files = ["package-lock.json", "dist/bundle.js", "types.generated.ts", "README.md", "data.db"].map((filename) => ({ filename, status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }));
    const selection = selectDiffForReview(files);
    expect(selection.coveredCount).toBe(4);
    expect(selection.skippedAsNoise).toEqual(["data.db"]);
    expect(selectDiffForReview(files, { pathFilters: ["!dist/**"] }).coveredCount).toBe(3);
  });
});
