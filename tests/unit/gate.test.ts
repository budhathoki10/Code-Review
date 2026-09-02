import { describe, it, expect, vi } from "vitest";
import { parseRepoConfig, DEFAULT_CONFIG, formatConfigErrors, REVIEW_CATEGORIES } from "@/lib/review/config";
import { evaluateSizeGate, formatBailoutComment, isForceCommand, FORCE_COMMAND, estimateReviewCost } from "@/lib/review/gate";
import { selectDiffForReview, formatCoverageNote, coverageRatio, fileCoverage, charCoverage, REVIEW_CAPACITY, MAX_REVIEW_CHUNKS } from "@/lib/review/diff-selection";
import { MAX_DIFF_FILES, MAX_DIFF_CHARS } from "@/lib/github/diff";
import type { PullRequestFile } from "@/lib/github/diff";

function srcFile(name: string, changes = 10): PullRequestFile {
  return {
    filename: name,
    status: "modified",
    changes,
    patch: ["@@ -1,2 +1,2 @@", `-const x = 1; // ${name}`, `+const x = 2; // ${name}`].join("\n"),
  };
}

/**
 * A file whose PATCH really is `changedLines` long. srcFile above carries a
 * `changes` count as metadata but a fixed two-line patch, which is fine for
 * the line-count gates and useless for the cost estimate — that reads actual
 * characters.
 */
function bulkyFile(name: string, changedLines: number): PullRequestFile {
  const body = [`@@ -1,${changedLines} +1,${changedLines} @@`];
  for (let i = 0; i < changedLines / 2; i++) body.push(`-const value${i} = ${i};`);
  for (let i = 0; i < changedLines / 2; i++) body.push(`+const value${i} = ${i + 1};`);
  return { filename: name, status: "modified", changes: changedLines, patch: body.join("\n") };
}

/** A file whose only change is re-indentation — what a repo-wide prettier run produces. */
function reformattedFile(name: string): PullRequestFile {
  return {
    filename: name,
    status: "modified",
    changes: 4,
    patch: ["@@ -1,2 +1,2 @@", "-function a() {", "-  return 1;", "+function a() {", "+    return 1;"].join("\n"),
  };
}

describe("parseRepoConfig", () => {
  it("reads the documented shape", () => {
    const { config, errors } = parseRepoConfig(
      ["version: 1", "reviews:", "  path_filters:", '    - "!**/generated/**"', "  max_files: 150", "  max_changed_lines: 8000"].join("\n"),
    );

    expect(errors).toEqual([]);
    expect(config.pathFilters).toEqual(["!**/generated/**"]);
    expect(config.maxFiles).toBe(150);
    expect(config.maxChangedLines).toBe(8000);
  });

  it("falls back to defaults for an empty file", () => {
    expect(parseRepoConfig("").config).toEqual(DEFAULT_CONFIG);
  });

  it("names the bad key instead of crashing on a wrong type", () => {
    const { config, errors } = parseRepoConfig(["reviews:", "  max_files: lots"].join("\n"));

    expect(errors.join(" ")).toContain("max_files");
    // Left unset rather than coerced, so the pipeline's capacity ceiling decides.
    expect(config.maxFiles).toBeUndefined();
  });

  it("leaves the numeric cutoffs unset when the repo doesn't configure them", () => {
    // These must never carry a default. A default here is what made an
    // arbitrary line count the primary gate and refused large PRs of real
    // code that the pipeline could review perfectly well.
    expect(DEFAULT_CONFIG.maxFiles).toBeUndefined();
    expect(DEFAULT_CONFIG.maxChangedLines).toBeUndefined();
    expect(parseRepoConfig("reviews:\n  path_filters: []").config.maxChangedLines).toBeUndefined();
  });

  it("names an unrecognized key rather than silently ignoring a typo", () => {
    const { errors } = parseRepoConfig(["reviews:", "  max_fyles: 10"].join("\n"));

    expect(errors.join(" ")).toContain("max_fyles");
  });

  it("reports invalid YAML without throwing", () => {
    const { config, errors } = parseRepoConfig("reviews:\n  - [unclosed\n");

    expect(errors.length).toBeGreaterThan(0);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("reports a wrong version but still reads the rest", () => {
    const { config, errors } = parseRepoConfig(["version: 99", "reviews:", "  max_files: 12"].join("\n"));

    expect(errors.join(" ")).toContain("version");
    expect(config.maxFiles).toBe(12);
  });

  it("rejects path_filters that aren't a list of strings", () => {
    const { config, errors } = parseRepoConfig(["reviews:", "  path_filters: nope"].join("\n"));

    expect(errors.join(" ")).toContain("path_filters");
    expect(config.pathFilters).toEqual([]);
  });

  it("reads disabled_categories", () => {
    const { config, errors } = parseRepoConfig(["reviews:", "  disabled_categories:", "    - testing", "    - performance"].join("\n"));

    expect(errors).toEqual([]);
    expect(config.disabledCategories).toEqual(["testing", "performance"]);
  });

  it("defaults disabled_categories to empty — a repo that says nothing gets every category", () => {
    expect(DEFAULT_CONFIG.disabledCategories).toEqual([]);
    expect(parseRepoConfig("reviews:\n  max_files: 10").config.disabledCategories).toEqual([]);
  });

  it("names an unknown category and keeps the valid ones beside it", () => {
    const { config, errors } = parseRepoConfig(["reviews:", "  disabled_categories:", "    - testng", "    - performance"].join("\n"));

    expect(errors.join(" ")).toContain("testng");
    // The typo is reported, not fatal — the correctly spelled entry still applies.
    expect(config.disabledCategories).toEqual(["performance"]);
  });

  it("rejects disabled_categories that aren't a list", () => {
    const { config, errors } = parseRepoConfig(["reviews:", "  disabled_categories: testing"].join("\n"));

    expect(errors.join(" ")).toContain("disabled_categories");
    expect(config.disabledCategories).toEqual([]);
  });

  it("refuses to disable every category, which would leave nothing to report", () => {
    const { config, errors } = parseRepoConfig(
      ["reviews:", "  disabled_categories:", ...REVIEW_CATEGORIES.map((c) => `    - ${c}`)].join("\n"),
    );

    expect(errors.join(" ")).toContain("every category");
    expect(config.disabledCategories).toEqual([]);
  });

  it("renders config errors into a comment block naming the file", () => {
    expect(formatConfigErrors(["`reviews.max_files` is wrong."])).toContain(".prsentry.yaml");
    expect(formatConfigErrors([])).toBe("");
  });
});

describe("user path filters", () => {
  it("excludes paths matching a ! pattern", () => {
    const selection = selectDiffForReview([srcFile("src/a.ts"), srcFile("src/generated/api.ts")], {
      pathFilters: ["!**/generated/**"],
    });

    expect(selection.analyzableFiles.map((f) => f.filename)).toEqual(["src/a.ts"]);
  });

  it("merges with the built-in noise list rather than replacing it", () => {
    // Asking to skip one directory must not opt the lockfile back in.
    const selection = selectDiffForReview([srcFile("src/a.ts"), srcFile("package-lock.json")], {
      pathFilters: ["!**/generated/**"],
    });

    expect(selection.analyzableFiles.map((f) => f.filename)).toEqual(["src/a.ts"]);
  });
});

describe("evaluateSizeGate", () => {
  const config = { pathFilters: [], disabledCategories: [], maxFiles: 150, maxChangedLines: 8000 };

  it("does not bail on a normal PR", () => {
    const selection = selectDiffForReview([srcFile("src/a.ts"), srcFile("src/b.ts")]);

    expect(evaluateSizeGate(selection, config).bail).toBe(false);
  });

  it("bails when reviewable files exceed max_files", () => {
    const files = Array.from({ length: 200 }, (_, i) => srcFile(`src/f${i}.ts`, 2));
    const decision = evaluateSizeGate(selectDiffForReview(files), config);

    expect(decision.bail).toBe(true);
    expect(decision.reason).toBe("too-many-files");
    expect(decision.detail).toContain("200");
  });

  it("bails when changed lines exceed max_changed_lines", () => {
    const files = Array.from({ length: 10 }, (_, i) => srcFile(`src/f${i}.ts`, 1000));
    const decision = evaluateSizeGate(selectDiffForReview(files), config);

    expect(decision.bail).toBe(true);
    expect(decision.reason).toBe("too-many-changed-lines");
  });

  it("bails when the PR cannot be enumerated at all", () => {
    const decision = evaluateSizeGate(selectDiffForReview([srcFile("src/a.ts")]), config, { oversized: true });

    expect(decision.reason).toBe("un-enumerable");
  });

  it("a forced review overrides every limit", () => {
    const files = Array.from({ length: 500 }, (_, i) => srcFile(`src/f${i}.ts`, 1000));

    expect(evaluateSizeGate(selectDiffForReview(files), config, { forced: true }).bail).toBe(false);
    expect(evaluateSizeGate(selectDiffForReview(files), config, { oversized: true, forced: true }).bail).toBe(false);
  });

  it("measures reviewable files, not GitHub's raw count", () => {
    // 400 files, all lockfile/vendor noise plus 5 real ones: the raw count is
    // over the limit but there is nothing expensive to review.
    const noise = Array.from({ length: 400 }, (_, i) => srcFile(`dist/bundle${i}.js`, 100));
    const real = Array.from({ length: 5 }, (_, i) => srcFile(`src/real${i}.ts`, 10));
    const selection = selectDiffForReview([...noise, ...real]);

    expect(selection.reviewableCount).toBe(5);
    expect(evaluateSizeGate(selection, config).bail).toBe(false);
  });
});

describe("capacity and cost gates", () => {
  it("does not gate on raw changed-line count when the repo configured nothing", () => {
    // 100 files / 20,000 real changed lines: the case the old fixed 8,000-line
    // cutoff refused even though the pipeline can cover all of it.
    const files = Array.from({ length: 100 }, (_, i) => srcFile(`src/f${i}.ts`, 200));
    const selection = selectDiffForReview(files);

    expect(selection.reviewableChangedLines).toBe(20_000);
    expect(evaluateSizeGate(selection, DEFAULT_CONFIG).bail).toBe(false);
  });

  it("bails on coverage once the chunk budget reaches too little of the PR", () => {
    const files = Array.from({ length: 1_200 }, (_, i) => srcFile(`src/f${i}.ts`, 100));
    const decision = evaluateSizeGate(selectDiffForReview(files), DEFAULT_CONFIG);

    expect(decision.bail).toBe(true);
    expect(decision.reason).toBe("coverage-too-low");
    // The message has to carry actual numbers and name the dimension that
    // ran out, not just say "too large".
    expect(decision.detail).toMatch(/characters of diff|reviewable files/);
    expect(decision.detail).toMatch(/d/);
  });

  it("coverage is measured against reviewable files, so noise can't drag it down", () => {
    const noise = Array.from({ length: 2_000 }, (_, i) => srcFile(`dist/b${i}.js`, 50));
    const real = Array.from({ length: 10 }, (_, i) => srcFile(`src/r${i}.ts`, 20));
    const selection = selectDiffForReview([...noise, ...real]);

    expect(coverageRatio(selection)).toBe(1);
    expect(evaluateSizeGate(selection, DEFAULT_CONFIG).bail).toBe(false);
  });

  it("the capacity ceiling is derived from the chunk budget, not hardcoded", () => {
    expect(REVIEW_CAPACITY.files).toBe(MAX_REVIEW_CHUNKS * MAX_DIFF_FILES);
    expect(REVIEW_CAPACITY.chars).toBe(MAX_REVIEW_CHUNKS * MAX_DIFF_CHARS);
  });
});

describe("estimateReviewCost", () => {
  it("is zero when there is nothing to review", () => {
    expect(estimateReviewCost(selectDiffForReview([srcFile("package-lock.json", 500)])).expectedTokens).toBe(0);
  });

  it("scales with the diff actually being sent", () => {
    const small = estimateReviewCost(selectDiffForReview([bulkyFile("src/a.ts", 10)]));
    const large = estimateReviewCost(
      selectDiffForReview(Array.from({ length: 80 }, (_, i) => bulkyFile(`src/f${i}.ts`, 200))),
    );

    expect(large.expectedTokens).toBeGreaterThan(small.expectedTokens * 5);
  });

  it("reports a worst case above the expected case", () => {
    const cost = estimateReviewCost(selectDiffForReview(Array.from({ length: 40 }, (_, i) => srcFile(`src/f${i}.ts`, 100))));

    expect(cost.worstCaseTokens).toBeGreaterThan(cost.expectedTokens);
  });

  it("refuses a review projected past the cost ceiling, separately from the file/line ceilings", async () => {
    process.env.REVIEW_MAX_ESTIMATED_TOKENS = "1000";
    vi.resetModules();
    const { evaluateSizeGate: gateWithLowCeiling } = await import("@/lib/review/gate");
    const { selectDiffForReview: select } = await import("@/lib/review/diff-selection");

    const selection = select([srcFile("src/a.ts", 200), srcFile("src/b.ts", 200)]);
    const decision = gateWithLowCeiling(selection, { pathFilters: [], disabledCategories: [] });

    expect(decision.bail).toBe(true);
    expect(decision.reason).toBe("cost-ceiling");
    // Coverage was fine — this is purely a spend decision.
    expect(selection.coveredCount).toBe(selection.reviewableCount);

    delete process.env.REVIEW_MAX_ESTIMATED_TOKENS;
    vi.resetModules();
  });

  it("warns without bailing when a review is expensive but under the ceiling", async () => {
    process.env.REVIEW_MAX_ESTIMATED_TOKENS = "20000";
    vi.resetModules();
    const { evaluateSizeGate: gateWithCeiling } = await import("@/lib/review/gate");
    const { selectDiffForReview: select } = await import("@/lib/review/diff-selection");

    // Sized to land between the 60% warn line (12,000) and the 20,000 ceiling.
    const selection = select([bulkyFile("src/a.ts", 1_280)]);
    const decision = gateWithCeiling(selection, { pathFilters: [], disabledCategories: [] });
    const cost = estimateReviewCost(selection);

    expect(cost.expectedTokens).toBeGreaterThan(12_000);
    expect(cost.expectedTokens).toBeLessThan(20_000);
    expect(decision.bail).toBe(false);
    expect(decision.warnings.length).toBeGreaterThan(0);
    expect(decision.warnings.join(" ")).toContain("tokens");

    delete process.env.REVIEW_MAX_ESTIMATED_TOKENS;
    vi.resetModules();
  });

  it("a forced review overrides the cost ceiling too", async () => {
    process.env.REVIEW_MAX_ESTIMATED_TOKENS = "1";
    vi.resetModules();
    const { evaluateSizeGate: gateWithLowCeiling } = await import("@/lib/review/gate");
    const { selectDiffForReview: select } = await import("@/lib/review/diff-selection");

    const decision = gateWithLowCeiling(select([srcFile("src/a.ts", 200)]), { pathFilters: [], disabledCategories: [] }, { forced: true });
    expect(decision.bail).toBe(false);

    delete process.env.REVIEW_MAX_ESTIMATED_TOKENS;
    vi.resetModules();
  });
});

describe("Phase 2 acceptance", () => {
  it("a lockfile-only PR produces no chunks at all, so zero LLM calls", () => {
    const selection = selectDiffForReview([srcFile("package-lock.json", 5000)]);

    expect(selection.chunks).toHaveLength(0);
    expect(selection.reviewableCount).toBe(0);
    expect(formatCoverageNote(selection)).toContain("were skipped");
  });

  it("a 400-file prettier run filters down to fewer than 20 real files", () => {
    const reformatted = Array.from({ length: 395 }, (_, i) => reformattedFile(`src/f${i}.ts`));
    const real = Array.from({ length: 5 }, (_, i) => srcFile(`src/real${i}.ts`));

    const selection = selectDiffForReview([...reformatted, ...real]);

    expect(selection.reviewableCount).toBeLessThan(20);
    expect(selection.triaged.filter((t) => t.reason === "whitespace-only")).toHaveLength(395);
    expect(evaluateSizeGate(selection, { pathFilters: [], disabledCategories: [], maxFiles: 150, maxChangedLines: 8000 }).bail).toBe(false);
  });

  it("the bail-out comment shows the actual counts and offers the override", () => {
    const files = Array.from({ length: 200 }, (_, i) => srcFile(`src/f${i}.ts`, 2));
    const config = { pathFilters: [], disabledCategories: [], maxFiles: 150, maxChangedLines: 8000 };
    const selection = selectDiffForReview(files);
    const decision = evaluateSizeGate(selection, config);

    const comment = formatBailoutComment(selection, config, decision, { filesSeen: 200, totalChangedLines: 400 });

    expect(comment).toContain("200");
    expect(comment).toContain("150");
    expect(comment).toContain(FORCE_COMMAND);
    expect(comment).toContain("max_files");
  });
});

describe("isForceCommand", () => {
  it("recognizes the command on its own line", () => {
    expect(isForceCommand("@prsentry review --force")).toBe(true);
  });

  it("recognizes it inside a longer comment", () => {
    expect(isForceCommand("I know it's big, but please: @prsentry review --force thanks")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isForceCommand("@PRSentry Review --Force")).toBe(true);
  });

  it("ignores ordinary comments", () => {
    expect(isForceCommand("looks good to me")).toBe(false);
    expect(isForceCommand("@prsentry review")).toBe(false);
    expect(isForceCommand(null)).toBe(false);
  });
});

describe("breadth vs depth coverage", () => {
  /** One file whose diff is far larger than the per-file truncation limit. */
  function giant(name: string, patchChars: number, originalChars: number): PullRequestFile {
    return {
      filename: name,
      status: "modified",
      changes: 8000,
      patch: "@@ -1,2 +1,2 @@\n-a\n+b".padEnd(patchChars, "x"),
      patchSource: "local",
      originalPatchChars: originalChars,
    };
  }

  it("reviews a single enormous file rather than refusing it", () => {
    // Every file was opened; one was truncated. That is a disclosable
    // limitation, not grounds to post nothing — the review covers the first
    // 60k characters and says so.
    const selection = selectDiffForReview([giant("src/huge.ts", 60_000, 392_712)]);
    const decision = evaluateSizeGate(selection, DEFAULT_CONFIG);

    expect(fileCoverage(selection)).toBe(1);
    expect(charCoverage(selection)).toBeLessThan(0.2);
    expect(decision.bail).toBe(false);
    expect(decision.warnings.join(" ")).toContain("truncated");
  });

  it("still refuses when almost none of the content was readable", () => {
    const selection = selectDiffForReview([giant("src/huge.ts", 60_000, 5_000_000)]);
    const decision = evaluateSizeGate(selection, DEFAULT_CONFIG);

    expect(decision.bail).toBe(true);
    expect(decision.reason).toBe("coverage-too-low");
    expect(decision.detail).toContain("characters of diff");
  });

  it("still refuses when most files were never opened at all", () => {
    // Breadth gap: this is the misleading case the 50% floor exists for.
    const files = Array.from({ length: 1_200 }, (_, i) => srcFile(`src/f${i}.ts`, 100));
    const decision = evaluateSizeGate(selectDiffForReview(files), DEFAULT_CONFIG);

    expect(decision.bail).toBe(true);
    expect(decision.detail).toContain("reviewable files");
  });

  it("does not warn when everything fit", () => {
    const decision = evaluateSizeGate(selectDiffForReview([srcFile("src/a.ts")]), DEFAULT_CONFIG);

    expect(decision.bail).toBe(false);
    expect(decision.warnings).toEqual([]);
  });
});
