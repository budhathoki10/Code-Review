import { describe, it, expect } from "vitest";
import {
  selectDiffForReview,
  coverageRatio,
  fileCoverage,
  charCoverage,
  formatCoverageNote,
  REVIEW_CAPACITY,
} from "@/lib/review/diff-selection";
import { evaluateSizeGate, estimateReviewCost } from "@/lib/review/gate";
import { DEFAULT_CONFIG } from "@/lib/review/config";
import type { PullRequestFile } from "@/lib/github/diff";

/**
 * End-to-end behaviour of the filter + gate stages on the PR shapes this
 * whole spec exists for. These are the numbers that answer "what actually
 * happens to a 100-file, 20,000-line pull request" — asserted here so a
 * later change to a regex or a budget can't quietly move them.
 *
 * Only the stages that need no network are exercised: selection and the
 * size gate. What happens after the gate (chunked review, bisecting retry,
 * inline cap) is covered by chunked-review.test.ts and inline-cap.test.ts.
 */

function real(name: string, changedLines: number): PullRequestFile {
  const body: string[] = [`@@ -1,${changedLines} +1,${changedLines} @@`];
  for (let i = 0; i < changedLines / 2; i++) body.push(`-const v${i} = ${i};`);
  for (let i = 0; i < changedLines / 2; i++) body.push(`+const v${i} = ${i + 1};`);
  return { filename: name, status: "modified", changes: changedLines, patch: body.join("\n") };
}

/** A prettier-style reindent: identical tokens, different leading whitespace. */
function reformatted(name: string, changedLines: number): PullRequestFile {
  const body: string[] = [`@@ -1,${changedLines} +1,${changedLines} @@`];
  for (let i = 0; i < changedLines / 2; i++) body.push(`-  call(a${i}, b${i});`);
  for (let i = 0; i < changedLines / 2; i++) body.push(`+    call(a${i}, b${i});`);
  return { filename: name, status: "modified", changes: changedLines, patch: body.join("\n") };
}

interface Outcome {
  filesSeen: number;
  totalLines: number;
  filtered: number;
  reviewableFiles: number;
  reviewableLines: number;
  chunks: number;
  bailed: boolean;
  reason?: string;
  typicalCalls: number;
  worstCalls: number;
  coveragePct: number;
  coveredFiles: number;
}

function analyze(files: PullRequestFile[]): Outcome {
  const selection = selectDiffForReview(files);
  const gate = evaluateSizeGate(selection, DEFAULT_CONFIG);
  const chunks = selection.chunks.length;

  // Chunk 1 costs 1 verdict + up to 4 findings rounds; each further chunk up
  // to 4. Typical is one findings round per chunk plus the single verdict.
  const worstCalls = gate.bail || chunks === 0 ? 0 : 5 + Math.max(0, chunks - 1) * 4;
  const typicalCalls = gate.bail || chunks === 0 ? 0 : 1 + chunks;

  return {
    filesSeen: files.length,
    totalLines: files.reduce((total, f) => total + (f.changes ?? 0), 0),
    filtered: selection.skippedAsNoise.length + selection.triaged.length,
    reviewableFiles: selection.reviewableCount,
    reviewableLines: selection.reviewableChangedLines,
    chunks,
    bailed: gate.bail,
    reason: gate.reason,
    typicalCalls,
    worstCalls,
    coveragePct: Math.round(coverageRatio(selection) * 100),
    coveredFiles: selection.coveredCount,
  };
}

describe("large PR scenarios", () => {
  it("A. 100 files / 20,000 lines of real code — reviewed, not refused", () => {
    const outcome = analyze(Array.from({ length: 100 }, (_, i) => real(`src/f${i}.ts`, 200)));

    expect(outcome.reviewableFiles).toBe(100);
    expect(outcome.reviewableLines).toBe(20_000);
    // The PR most worth reviewing is not the one that gets skipped. Nothing
    // was filtered, so this costs more than scenario B — that's the honest
    // outcome, not a reason to refuse it.
    expect(outcome.bailed).toBe(false);
    expect(outcome.typicalCalls).toBeGreaterThan(0);
    // Whatever the chunk budget can't reach is reported, not silently dropped.
    expect(outcome.coveragePct).toBeGreaterThanOrEqual(50);
  });

  it("A'. the same PR is refused only if the repo explicitly asks for a stricter cutoff", () => {
    const files = Array.from({ length: 100 }, (_, i) => real(`src/f${i}.ts`, 200));
    const selection = selectDiffForReview(files);

    // No opinion configured: the pipeline's own capacity decides.
    expect(evaluateSizeGate(selection, DEFAULT_CONFIG).bail).toBe(false);
    // An explicit repo cutoff still wins.
    expect(evaluateSizeGate(selection, { pathFilters: [], maxChangedLines: 8_000 }).reason).toBe(
      "too-many-changed-lines",
    );
  });

  it("B. 100 files / ~20,000 lines of realistic churn — filters down and reviews", () => {
    const outcome = analyze([
      ...Array.from({ length: 5 }, (_, i) => real(`dist/bundle${i}.js`, 1000)),
      real("package-lock.json", 3000),
      ...Array.from({ length: 40 }, (_, i) => reformatted(`src/fmt${i}.ts`, 200)),
      ...Array.from({ length: 54 }, (_, i) => real(`src/real${i}.ts`, 74)),
    ]);

    expect(outcome.filesSeen).toBe(100);
    expect(outcome.totalLines).toBe(19_996);
    // Lockfile + build output + the formatting sweep all drop out.
    expect(outcome.filtered).toBe(46);
    expect(outcome.reviewableFiles).toBe(54);
    expect(outcome.bailed).toBe(false);
    // Two chunks, so a handful of calls — not 100.
    expect(outcome.chunks).toBeLessThanOrEqual(2);
    expect(outcome.worstCalls).toBeLessThanOrEqual(9);
  });

  it("C. a 400-file prettier run costs nothing", () => {
    const outcome = analyze(Array.from({ length: 400 }, (_, i) => reformatted(`src/f${i}.ts`, 50)));

    expect(outcome.reviewableFiles).toBe(0);
    expect(outcome.chunks).toBe(0);
    expect(outcome.typicalCalls).toBe(0);
  });

  it("D. a lockfile-only PR costs nothing", () => {
    const outcome = analyze([real("package-lock.json", 5000)]);

    expect(outcome.reviewableFiles).toBe(0);
    expect(outcome.typicalCalls).toBe(0);
  });

  it("E. a follow-up push of one 2-line change is a 2-call review", () => {
    // What the incremental path hands the model after the first review.
    const outcome = analyze([real("src/f3.ts", 2)]);

    expect(outcome.chunks).toBe(1);
    expect(outcome.typicalCalls).toBe(2);
    expect(outcome.worstCalls).toBe(5);
  });

  it("the gate reads filtered counts, so noise alone can never trip it", () => {
    // 900 files and 90,000 lines, all of it build output.
    const outcome = analyze(Array.from({ length: 900 }, (_, i) => real(`dist/chunk${i}.js`, 100)));

    expect(outcome.filesSeen).toBe(900);
    expect(outcome.bailed).toBe(false);
    expect(outcome.typicalCalls).toBe(0);
  });

  it("F. a PR far past the pipeline's capacity is still refused, on coverage", () => {
    // 1,200 real files: the chunk budget reaches a small fraction, so a
    // review would be a misleading account of the PR rather than a partial one.
    const outcome = analyze(Array.from({ length: 1_200 }, (_, i) => real(`src/f${i}.ts`, 100)));

    expect(outcome.bailed).toBe(true);
    expect(outcome.reason).toBe("coverage-too-low");
    expect(outcome.coveragePct).toBeLessThan(50);
  });

  it("prints the scenario table", () => {
    const rows: [string, PullRequestFile[]][] = [
      ["A. 100 files / 20k lines, all real", Array.from({ length: 100 }, (_, i) => real(`src/f${i}.ts`, 200))],
      [
        "B. 100 files / 20k lines, realistic",
        [
          ...Array.from({ length: 5 }, (_, i) => real(`dist/bundle${i}.js`, 1000)),
          real("package-lock.json", 3000),
          ...Array.from({ length: 40 }, (_, i) => reformatted(`src/fmt${i}.ts`, 200)),
          ...Array.from({ length: 54 }, (_, i) => real(`src/real${i}.ts`, 74)),
        ],
      ],
      ["C. 400-file prettier run", Array.from({ length: 400 }, (_, i) => reformatted(`src/f${i}.ts`, 50))],
      ["D. lockfile bump only", [real("package-lock.json", 5000)]],
      ["E. follow-up push, 2 lines", [real("src/f3.ts", 2)]],
      ["900 files of build output", Array.from({ length: 900 }, (_, i) => real(`dist/chunk${i}.js`, 100))],
      ["F. 1,200 real files", Array.from({ length: 1_200 }, (_, i) => real(`src/f${i}.ts`, 100))],
    ];

    const header = ["scenario", "seen", "filtered", "reviewable", "covered", "cov%", "chunks", "calls", "outcome"];
    const table = rows.map(([label, files]) => {
      const o = analyze(files);
      const cost = estimateReviewCost(selectDiffForReview(files));
      return [
        label,
        String(o.filesSeen),
        String(o.filtered),
        String(o.reviewableFiles),
        String(o.coveredFiles),
        `${o.coveragePct}%`,
        String(o.chunks),
        o.bailed ? "0" : `${o.typicalCalls}-${o.worstCalls}`,
        o.bailed ? `BAIL (${o.reason})` : o.reviewableFiles === 0 ? "nothing to review" : `review (~${cost.expectedTokens.toLocaleString()} tok)`,
      ];
    });

    const widths = header.map((h, i) => Math.max(h.length, ...table.map((r) => r[i].length)));
    const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
    console.log("\n" + line(header));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
    for (const row of table) console.log(line(row));
    console.log();

    expect(table).toHaveLength(rows.length);
  });
});

describe("coverage is measured on both dimensions", () => {
  it("scenario F: file coverage and character coverage, both reported", () => {
    const files = Array.from({ length: 1_200 }, (_, i) => real(`src/f${i}.ts`, 100));
    const selection = selectDiffForReview(files);

    const fileCov = fileCoverage(selection);
    const charCov = charCoverage(selection);

     
    console.log(
      `\n  SCENARIO F COVERAGE MATH\n` +
        `    reviewable files   : ${selection.reviewableCount}\n` +
        `    covered files      : ${selection.coveredCount}\n` +
        `    file coverage      : ${selection.coveredCount}/${selection.reviewableCount} = ${(fileCov * 100).toFixed(1)}%\n` +
        `    reviewable chars   : ${selection.reviewableChars.toLocaleString()}\n` +
        `    covered chars      : ${selection.coveredChars.toLocaleString()}\n` +
        `    char coverage      : ${selection.coveredChars.toLocaleString()}/${selection.reviewableChars.toLocaleString()} = ${(charCov * 100).toFixed(1)}%\n` +
        `    capacity           : ${REVIEW_CAPACITY.files} files / ${REVIEW_CAPACITY.chars.toLocaleString()} chars\n` +
        `    gate reads min()   : ${(coverageRatio(selection) * 100).toFixed(1)}%\n`,
    );

    expect(coverageRatio(selection)).toBe(Math.min(fileCov, charCov));
    expect(charCov).toBeLessThan(1);
  });

  it("a truncated giant file is not counted as fully covered", () => {
    // One file whose patch far exceeds the per-file truncation limit. By file
    // count this is 1/1 = 100% covered; by characters it plainly is not, and
    // the gate must see the smaller number.
    const giant = real("src/giant.ts", 40_000);
    const selection = selectDiffForReview([giant]);

    expect(selection.truncatedFiles).toContain("src/giant.ts");
    expect(fileCoverage(selection)).toBe(1);
    expect(charCoverage(selection)).toBeLessThan(0.5);
    expect(coverageRatio(selection)).toBe(charCoverage(selection));
  });

  it("a fully covered PR reports 100% on both dimensions", () => {
    const selection = selectDiffForReview([real("src/a.ts", 20), real("src/b.ts", 20)]);

    expect(fileCoverage(selection)).toBe(1);
    expect(charCoverage(selection)).toBe(1);
  });
});

describe("files with no obtainable diff are reported, not dropped", () => {
  it("routes patchSource 'unavailable' into the same coverage note as every other gap", () => {
    const selection = selectDiffForReview([
      real("src/ok.ts", 10),
      {
        filename: "src/opaque.ts",
        status: "modified",
        changes: 9_000,
        patch: "@@ -0,0 +0,0 @@\n# DIFF UNAVAILABLE for src/opaque.ts: unreadable.",
        patchSource: "unavailable",
      },
    ]);

    expect(selection.diffUnavailable).toEqual(["src/opaque.ts"]);
    // Not counted as reviewable — there is nothing in it to review...
    expect(selection.reviewableCount).toBe(1);
    // ...and it reaches the author through formatCoverageNote, the same
    // function that reports budget skips and model failures.
    const note = formatCoverageNote(selection);
    expect(note).toContain("no obtainable diff");
    expect(note).toContain("src/opaque.ts");
    expect(note).toContain("NOT reviewed");
  });

  it("does not let an unreadable file inflate coverage to 100%", () => {
    const selection = selectDiffForReview([
      {
        filename: "src/opaque.ts",
        status: "modified",
        changes: 9_000,
        patch: "@@ -0,0 +0,0 @@\n# DIFF UNAVAILABLE for src/opaque.ts: unreadable.",
        patchSource: "unavailable",
      },
    ]);

    // Zero reviewable files, so nothing is claimed as covered.
    expect(selection.reviewableCount).toBe(0);
    expect(selection.chunks).toHaveLength(0);
    expect(formatCoverageNote(selection)).toContain("no obtainable diff");
  });
});

describe("truncation upstream of selection stays visible to coverage", () => {
  it("a Phase-1-truncated file is not reported as fully covered", () => {
    // Reproduces a bug found by running the harness against a live PR:
    // GitHub returned patch:null for a 392,712-char diff, Phase 1 rebuilt and
    // truncated it to 60,073, and selection then measured coverage against
    // the SHORTENED patch — reporting 100% for a file we had read 15% of.
    const truncated: PullRequestFile = {
      filename: "src/huge.ts",
      status: "modified",
      changes: 8000,
      patch: "@@ -1,2 +1,2 @@\n-a\n+b".padEnd(60_000, "x"),
      patchSource: "local",
      originalPatchChars: 392_712,
    };

    const selection = selectDiffForReview([truncated]);

    expect(fileCoverage(selection)).toBe(1);
    expect(charCoverage(selection)).toBeLessThan(0.25);
    expect(coverageRatio(selection)).toBe(charCoverage(selection));
  });

  it("a file that fit whole is unaffected", () => {
    const whole: PullRequestFile = {
      filename: "src/small.ts",
      status: "modified",
      changes: 4,
      patch: "@@ -1,2 +1,2 @@\n-a\n+b",
      patchSource: "local",
    };

    expect(charCoverage(selectDiffForReview([whole]))).toBe(1);
  });
});
