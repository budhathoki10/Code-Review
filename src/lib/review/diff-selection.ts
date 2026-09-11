import picomatch from "picomatch";
import { MAX_DIFF_CHARS, MAX_DIFF_FILES, buildDiffText, type PullRequestFile } from "@/lib/github/diff";
import { triageFile, describeSkipReason, type SkipReason } from "@/lib/review/triage";
import { riskReasons } from "@/lib/review/risk";
import { splitPatchSections } from "@/lib/review/patch-sections";
import { envNumber } from "@/lib/env";
import { isBinaryPath } from "@/lib/github/file-types";

/** New root chunks per worker window. The remainder resumes from checkpoints. */
export const MAX_REVIEW_CHUNKS = Math.max(1, Math.floor(envNumber("MAX_REVIEW_CHUNKS", 60)));

/** Nominal work-window capacity, not a cutoff on total PR coverage. */
export const REVIEW_CAPACITY = {
  files: MAX_REVIEW_CHUNKS * MAX_DIFF_FILES,
  chars: MAX_REVIEW_CHUNKS * MAX_DIFF_CHARS,
} as const;

/** Optional generated-text exclusions, enabled by REVIEW_SKIP_GENERATED_FILES. */
const NOISE_PATTERNS: RegExp[] = [
  // Lockfiles - regenerated wholesale, reviewing them is meaningless.
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/,
  // Any other lockfile by extension.
  /\.lock$/,
  // Build output / vendored / dependency trees.
  /(^|\/)(node_modules|dist|build|out|coverage|vendor|third_party|\.next|\.turbo|\.svelte-kit)\//,
  // Minified bundles and every sourcemap, not just js/css ones.
  /\.min\.[^/]+$/,
  /\.map$/,
  // Conventionally generated filenames.
  /\.generated\.[^/]+$/,
  /\.pb\.(ts|js|go)$/,
  /_pb2?\.py$/,
  // Prisma's generated client - checked in by projects that vendor it.
  /(^|\/)(prisma\/)?generated\//,
  /(^|\/)node_modules\/\.prisma\//,
  // Test snapshots - regenerated, not hand-written.
  /(^|\/)__snapshots__\//,
  /\.snap$/,
  // Binary, font, media and archive assets: GitHub gives no usable patch anyway.
  /\.(png|jpe?g|gif|bmp|ico|webp|avif|pdf|woff2?|ttf|eot|otf|mp4|mov|avi|webm|mp3|wav|zip|tar|gz|bz2|xz|7z|rar|jar|so|dll|dylib|wasm|exe|bin|class|pyc)$/i,
];

function isNoiseFile(filename: string): boolean {
  return isBinaryPath(filename) || (process.env.REVIEW_SKIP_GENERATED_FILES === "true" && NOISE_PATTERNS.some((pattern) => pattern.test(filename)));
}

/**
 * Compiles the repo's `path_filters` into a predicate.
 *
 * Filters MERGE with the built-in noise list rather than replacing it: a repo
 * asking to skip its generated directory should not thereby opt back into
 * having its lockfile reviewed. A leading "!" excludes; a bare pattern
 * includes, and the presence of any include pattern narrows the review to
 * files matching one of them.
 */
function compilePathFilters(patterns: string[]): (filename: string) => boolean {
  const excludes = patterns.filter((p) => p.startsWith("!")).map((p) => picomatch(p.slice(1), { dot: true }));
  const includes = patterns.filter((p) => !p.startsWith("!")).map((p) => picomatch(p, { dot: true }));

  return (filename: string) => {
    if (excludes.some((match) => match(filename))) return false;
    if (includes.length > 0 && !includes.some((match) => match(filename))) return false;
    return true;
  };
}

const TEST_PATTERNS: RegExp[] = [
  /(^|\/)(tests?|__tests__|e2e|spec)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /_test\.[a-z]+$/,
];

const SUPPORTING_PATTERNS: RegExp[] = [
  /\.(md|mdx|txt|json|ya?ml|toml|ini|cfg|conf|csv)$/i,
  /(^|\/)(Dockerfile|Makefile|\.gitignore|\.dockerignore|LICENSE)$/i,
  /(^|\/)\.github\//,
];

/**
 * Review priority when the budget can't fit everything. Source code first
 * (where real bugs live), then tests, then docs/config. Deliberately coarse:
 * a smarter ranking (call-graph centrality, churn history) would need
 * context this stage doesn't have, and the coarse version already captures
 * the decision that matters - never drop a source file to make room for a
 * README.
 */
function filePriority(filename: string): number {
  if (TEST_PATTERNS.some((pattern) => pattern.test(filename))) return 1;
  if (SUPPORTING_PATTERNS.some((pattern) => pattern.test(filename))) return 2;
  return 0;
}

function patchSize(file: PullRequestFile): number {
  return file.patch?.length ?? 0;
}

export interface DiffChunk {
  files: PullRequestFile[];
  diffText: string;
}

export interface SelectedDiff {
  /** Chunks to send to the AI, in priority order. Empty when the PR has no reviewable text diff at all. */
  chunks: DiffChunk[];
  /** Every file that survived the noise filter - what static analysis should scan, regardless of AI budget. */
  analyzableFiles: PullRequestFile[];
  /** Binary files, path-filter exclusions, and optional generated-file exclusions. */
  skippedAsNoise: string[];
  /** Kept for coverage compatibility; the resumable planner no longer leaves files here. */
  skippedForBudget: string[];
  /** Patches already shortened upstream. Newly reconstructed patches are never truncated. */
  truncatedFiles: string[];
  /** Files triaged out as not worth an AI call, with the reason. Reported as a count-by-reason, not a file list. */
  triaged: { filename: string; reason: SkipReason }[];
  /**
   * Files GitHub gave no patch for and Phase 1 could not reconstruct one for
   * either. They are NOT reviewable — there is nothing to read — so they are
   * excluded from the chunks and named in the coverage note instead.
   *
   * These deliberately share the author-facing path with every other kind of
   * gap. Routing them anywhere else is how "this file was never reviewed"
   * turns back into a log line nobody reads, which is the exact failure the
   * `patch: null` work existed to remove.
   */
  diffUnavailable: string[];
  /** Files remaining after noise + user filters + triage — the number the size gate reads. */
  reviewableCount: number;
  /** Sum of `changes` over the reviewable files — the other number the size gate reads. */
  reviewableChangedLines: number;
  /** Unique reviewable files packed into one or more chunks. */
  coveredCount: number;
  /** Original patch characters retained for review. */
  coveredChars: number;
  /** Characters of patch across every reviewable file, before truncation. The denominator for character coverage. */
  reviewableChars: number;
}

/**
 * The share of a PR this review will actually put in front of the model,
 * measured on BOTH dimensions the chunk budget bounds, and reported as the
 * worse of the two.
 *
 * File count alone is not enough: an upstream API may already have shortened
 * a patch. Character coverage keeps that loss visible even though this planner
 * now splits every retained patch into complete sections.
 *
 * 1 means full coverage. This — not a line count — is what decides whether a
 * review is worth posting: a review covering 95% of a PR is a real review
 * with a footnote, while one covering 20% is a misleading one, because "no
 * issues found" gets read as a statement about the whole PR.
 */
export function coverageRatio(selection: SelectedDiff): number {
  return Math.min(fileCoverage(selection), charCoverage(selection));
}

export function fileCoverage(selection: SelectedDiff): number {
  if (selection.reviewableCount === 0) return 1;
  return selection.coveredCount / selection.reviewableCount;
}

export function charCoverage(selection: SelectedDiff): number {
  if (selection.reviewableChars === 0) return 1;
  // Clamped because coverage above 100% is never meaningful.
  return Math.min(1, selection.coveredChars / selection.reviewableChars);
}

export interface SelectionOptions {
  /** Repo `path_filters` from .prsentry.yaml, merged with the built-in noise list. */
  pathFilters?: string[];
  /** Disable trivial-file triage even if REVIEW_SKIP_TRIVIAL_FILES is enabled. */
  skipTriage?: boolean;
}

/**
 * Turns a raw PR diff into the set of AI passes to actually run, replacing
 * the old "bail out entirely above the size cap" behavior.
 *
 * Binary/path-filter exclusions happen first. Everything else is ranked and
 * packed into requests bounded by characters and file count. Oversized files
 * become valid diff sections; no tail is dropped. MAX_REVIEW_CHUNKS is applied
 * later as a per-worker-window limit so all chunks can resume over time.
 */
export function selectDiffForReview(files: PullRequestFile[], options: SelectionOptions = {}): SelectedDiff {
  const passesUserFilters = compilePathFilters(options.pathFilters ?? []);

  const skippedAsNoise: string[] = [];
  const triaged: { filename: string; reason: SkipReason }[] = [];
  const diffUnavailable: string[] = [];
  const analyzableFiles: PullRequestFile[] = [];

  for (const file of files) {
    // A file with no patch at all is one Phase 1 could not reconstruct even
    // a "diff unavailable" marker for — binary, almost always. Counted here
    // rather than dropped, so the totals add up to the PR's real file count.
    if (!file.patch) {
      (isNoiseFile(file.filename) || !passesUserFilters(file.filename) ? skippedAsNoise : diffUnavailable).push(file.filename);
      continue;
    }
    // Phase 1 could not obtain this file's diff by any route. Its "patch" is
    // a marker, not a diff, so there is nothing here to review — but the file
    // DID change, so it has to be reported rather than quietly counted as
    // covered. Checked before the noise filter so a genuinely unreadable
    // source file can't be misfiled as noise.
    if (file.patchSource === "unavailable") {
      diffUnavailable.push(file.filename);
      continue;
    }
    if (isNoiseFile(file.filename) || !passesUserFilters(file.filename)) {
      skippedAsNoise.push(file.filename);
      continue;
    }

    // Content-based generated detection reads the patch we already have — a
    // bulk-generated file is usually a full-file rewrite, so its @generated
    // header is sitting in text that cost nothing to obtain. No file is
    // fetched purely to run this check.
    if (!options.skipTriage && process.env.REVIEW_SKIP_TRIVIAL_FILES === "true") {
      const { skip } = triageFile(file);
      if (skip) {
        triaged.push({ filename: file.filename, reason: skip });
        continue;
      }
    }

    analyzableFiles.push(file);
  }

  const ranked = [...analyzableFiles].sort((a, b) => {
    const riskDelta = riskReasons(b).length - riskReasons(a).length;
    if (riskDelta !== 0) return riskDelta;
    const priorityDelta = filePriority(a.filename) - filePriority(b.filename);
    if (priorityDelta !== 0) return priorityDelta;
    return patchSize(a) - patchSize(b);
  });

  const chunks: DiffChunk[] = [];
  const truncatedFiles: string[] = [];
  const skippedForBudget: string[] = [];

  let current: PullRequestFile[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({ files: current, diffText: buildDiffText(current) });
    current = [];
    currentChars = 0;
  };

  for (const file of ranked) {
    const originalPatch = file.patch ?? "";
    if ((file.originalPatchChars ?? originalPatch.length) > originalPatch.length) truncatedFiles.push(file.filename);
    const sections = splitPatchSections(originalPatch, Math.max(256, MAX_DIFF_CHARS - file.filename.length * 2 - 32));
    for (const patch of sections) {
      const candidate = sections.length === 1 ? file : { ...file, patch };
      const size = buildDiffText([candidate]).length + 2;
      if (current.length && (currentChars + size > MAX_DIFF_CHARS || current.length >= MAX_DIFF_FILES || current.some((entry) => entry.filename === file.filename))) flush();
      current.push(candidate);
      currentChars += size;
    }
  }
  flush();

  return {
    chunks,
    analyzableFiles,
    skippedAsNoise,
    skippedForBudget,
    truncatedFiles,
    triaged,
    diffUnavailable,
    reviewableCount: analyzableFiles.length,
    reviewableChangedLines: analyzableFiles.reduce((total, file) => total + (file.changes ?? 0), 0),
    coveredCount: analyzableFiles.length,
    // Count each original patch once; section headers are transport overhead.
    coveredChars: analyzableFiles.reduce((total, file) => total + (file.patch?.length ?? 0), 0),
    // originalPatchChars when Phase 1 already truncated this file, so coverage
    // is measured against the diff that actually exists rather than against
    // the shortened copy we happen to be holding.
    reviewableChars: analyzableFiles.reduce(
      (total, file) => total + (file.originalPatchChars ?? file.patch?.length ?? 0),
      0,
    ),
  };
}

const MAX_LISTED_FILES = 15;

function formatFileList(files: string[]): string {
  const shown = files.slice(0, MAX_LISTED_FILES).map((file) => `\`${file}\``);
  const remainder = files.length - shown.length;
  return remainder > 0 ? `${shown.join(", ")} and ${remainder} more` : shown.join(", ");
}

/**
 * The step-4 honesty requirement: a review that silently covered only part
 * of a PR is worse than one that says so, because the author reasonably
 * reads "no issues found" as "no issues in my PR". Noise files are
 * deliberately NOT listed - nobody expects their lockfile reviewed, and
 * listing 30 of them would bury the part that matters. Returns an empty
 * string when full coverage was achieved, so callers can append
 * unconditionally.
 */
export function formatCoverageNote(selection: SelectedDiff, aiFailedFiles: string[] = []): string {
  const notes: string[] = [];

  // Counts by reason, not a file list: a 400-file formatting PR would
  // otherwise bury the review under 400 filenames nobody wants to read. The
  // reason is what makes this actionable — "12 files skipped" alone reads as
  // the bot giving up.
  if (selection.triaged.length > 0 || selection.skippedAsNoise.length > 0) {
    const byReason = new Map<string, number>();
    if (selection.skippedAsNoise.length > 0) {
      byReason.set("generated, vendored, or binary", selection.skippedAsNoise.length);
    }
    for (const { reason } of selection.triaged) {
      const label = describeSkipReason(reason);
      byReason.set(label, (byReason.get(label) ?? 0) + 1);
    }
    const total = selection.skippedAsNoise.length + selection.triaged.length;
    const breakdown = [...byReason.entries()].map(([label, count]) => `${count} ${label}`).join(", ");
    notes.push(`**${total} file(s) were skipped** as not worth reviewing: ${breakdown}.`);
  }

  if (selection.diffUnavailable.length > 0) {
    // GitHub wouldn't render these diffs and Phase 1 couldn't rebuild them.
    // Stated first because it's the most severe kind of gap: the file
    // changed and nobody — not the model, not a linter — saw a single line
    // of it.
    notes.push(
      `**${selection.diffUnavailable.length} file(s) had no obtainable diff** and were NOT reviewed: ${formatFileList(selection.diffUnavailable)}. ` +
        `GitHub declined to render their diffs and their contents could not be fetched (too large, binary, or unreadable).`,
    );
  }

  if (aiFailedFiles.length > 0) {
    // Distinct from skippedForBudget: these files DID fit the budget and
    // were sent to the model, which failed on them even after the chunk was
    // split down (see runFindingsWithBisect). Worth naming separately —
    // "too big to review" and "the reviewer errored" are different problems
    // with different fixes.
    notes.push(
      `**${aiFailedFiles.length} file(s) could not be fully reviewed** — one or more sections failed or were not reached before the provider/time limit: ${formatFileList(aiFailedFiles)}.`,
    );
  }

  if (selection.skippedForBudget.length > 0) {
    notes.push(
      `**${selection.skippedForBudget.length} file(s) were not reviewed** - this PR exceeds the review size budget: ${formatFileList(selection.skippedForBudget)}.`,
    );
  }
  if (selection.truncatedFiles.length > 0) {
    notes.push(
      `**${selection.truncatedFiles.length} file(s) were only partially reviewed** (patch too large to include in full): ${formatFileList(selection.truncatedFiles)}.`,
    );
  }
  if (notes.length === 0) return "";

  // Only advise splitting when the gap was actually caused by size — that
  // advice does nothing about a model failure, and offering it there would
  // blame the author for our error.
  if (selection.skippedForBudget.length > 0 || selection.truncatedFiles.length > 0) {
    notes.push("Splitting this into smaller pull requests will get you a complete review.");
  }
  return `\n\n---\n\n${notes.join("\n\n")}`;
}
