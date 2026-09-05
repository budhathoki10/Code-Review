import picomatch from "picomatch";
import { MAX_DIFF_CHARS, MAX_DIFF_FILES, buildDiffText, type PullRequestFile } from "@/lib/github/diff";
import { triageFile, describeSkipReason, type SkipReason } from "@/lib/review/triage";
import { riskReasons } from "@/lib/review/risk";

/**
 * Hard ceiling on how many AI passes one review may spend on an oversized
 * PR. Without it, a 500-file PR would fan out into dozens of provider calls
 * and multiply the cost of a single review without bound. Files that don't
 * fit inside this many chunks are reported as unreviewed rather than
 * silently dropped (see SelectedDiff.skippedForBudget).
 */
export const MAX_REVIEW_CHUNKS = Number(process.env.MAX_REVIEW_CHUNKS ?? 4);

/**
 * What one review can actually put in front of the model, derived from the
 * chunk budget rather than picked. Currently 4 chunks x 40 files x 100k
 * chars = 160 files / 400,000 characters.
 *
 * This is the honest answer to "is this PR too big?", and it replaces the
 * fixed changed-line cutoff that used to decide it. A raw line count is the
 * wrong question: it refuses the 20,000-line PR of real code (the one most
 * worth reviewing) while waving through a 20,000-line PR that is 95%
 * lockfile churn, because it measures the diff GitHub reported instead of
 * the work this pipeline can do.
 */
export const REVIEW_CAPACITY = {
  files: MAX_REVIEW_CHUNKS * MAX_DIFF_FILES,
  chars: MAX_REVIEW_CHUNKS * MAX_DIFF_CHARS,
} as const;

/**
 * A single file whose patch alone exceeds the per-chunk char budget can't be
 * dropped (it's usually the most interesting file in the PR) and can't be
 * sent whole, so its patch is cut to this many chars with an explicit
 * marker. Deliberately below MAX_DIFF_CHARS so a truncated file still leaves
 * room for at least some of its neighbours in the same chunk.
 */
const MAX_SINGLE_FILE_CHARS = Math.floor(MAX_DIFF_CHARS * 0.6);

const TRUNCATION_MARKER = "\n...[patch truncated - file too large to include in full]";

/**
 * Paths whose diffs cost tokens but never produce a useful review finding -
 * lockfiles, build output, vendored dependencies, minified bundles, test
 * snapshots, and binary assets. Dropped before any size measurement, which
 * is what makes this the cheapest possible large-PR mitigation: a 100-file
 * PR is frequently ~60 real files once generated churn is excluded, and
 * removing them costs nothing and improves review quality on PRs of *every*
 * size (the model stops spending attention on regenerated lockfile noise).
 */
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
  /\.(png|jpe?g|gif|bmp|ico|webp|avif|svg|pdf|woff2?|ttf|eot|otf|mp4|mov|avi|webm|mp3|wav|zip|tar|gz|bz2|xz|7z|rar|jar|so|dll|dylib|wasm|exe|bin|class|pyc)$/i,
];

function isNoiseFile(filename: string): boolean {
  return NOISE_PATTERNS.some((pattern) => pattern.test(filename));
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
  /** Generated/vendored/binary files excluded up front. Not worth reporting as "unreviewed" - nobody wants them reviewed. */
  skippedAsNoise: string[];
  /** Real source files that did not fit the chunk budget. These MUST be surfaced to the author (see formatCoverageNote). */
  skippedForBudget: string[];
  /** Files included but whose patch was cut to fit. Also surfaced to the author. */
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
  /** Files actually packed into chunks, i.e. reviewable minus what the chunk budget couldn't reach. */
  coveredCount: number;
  /** Characters of patch actually packed into chunks — AFTER any per-file truncation. */
  coveredChars: number;
  /** Characters of patch across every reviewable file, before truncation. The denominator for character coverage. */
  reviewableChars: number;
}

/**
 * The share of a PR this review will actually put in front of the model,
 * measured on BOTH dimensions the chunk budget bounds, and reported as the
 * worse of the two.
 *
 * File count alone is not enough. The packer is bounded by files *and*
 * characters, and an oversized single file is truncated rather than dropped —
 * so a PR of four enormous files can pack all four into chunks, report 100%
 * file coverage, and still have had most of its actual content cut. Measuring
 * characters as well is what makes truncation visible to the gate instead of
 * invisible.
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
  // coveredChars is measured on the rendered chunk text, which adds a
  // per-file `--- a/… +++ b/…` header the denominator doesn't have, so this
  // can nudge just over 1 on a fully-covered PR. Clamped, since "more than
  // complete" is not a meaningful coverage figure.
  return Math.min(1, selection.coveredChars / selection.reviewableChars);
}

export interface SelectionOptions {
  /** Repo `path_filters` from .prsentry.yaml, merged with the built-in noise list. */
  pathFilters?: string[];
  /** Skip the cheap-triage stage. Used by `@prsentry review --force`, where the author has asked for everything. */
  skipTriage?: boolean;
}

/**
 * Turns a raw PR diff into the set of AI passes to actually run, replacing
 * the old "bail out entirely above the size cap" behavior.
 *
 * Four stages, in order:
 *   1. Drop noise (lockfiles, build output, binaries) - free, and applied at
 *      every PR size, not just large ones.
 *   2. Rank what's left: source > tests > docs/config, and within a tier,
 *      smaller patches first so a single enormous file can't crowd out ten
 *      small ones. Maximises the number of files reviewed per token spent.
 *   3. Greedily pack files into chunks bounded by BOTH MAX_DIFF_CHARS and
 *      MAX_DIFF_FILES, up to MAX_REVIEW_CHUNKS chunks.
 *   4. Record whatever still didn't fit so the caller can tell the author
 *      exactly what went unreviewed, instead of silently reviewing a subset.
 *
 * Note this function never fails a review for size: a PR of any size yields
 * at least one chunk (with an oversized single file truncated rather than
 * dropped). Deciding *not* to review is no longer a size decision.
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
      skippedAsNoise.push(file.filename);
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
    if (!options.skipTriage) {
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
    if (chunks.length >= MAX_REVIEW_CHUNKS) {
      skippedForBudget.push(file.filename);
      continue;
    }

    let candidate = file;
    const originalPatch = file.patch ?? "";
    if (originalPatch.length > MAX_SINGLE_FILE_CHARS) {
      candidate = { ...file, patch: `${originalPatch.slice(0, MAX_SINGLE_FILE_CHARS)}${TRUNCATION_MARKER}` };
      truncatedFiles.push(file.filename);
    }

    const size = patchSize(candidate);
    const wouldOverflow = currentChars + size > MAX_DIFF_CHARS || current.length >= MAX_DIFF_FILES;
    if (wouldOverflow && current.length > 0) {
      flush();
      // Re-check the chunk cap: the flush above may have consumed the last
      // allowed chunk, in which case this file (and everything after it) is
      // reported rather than silently dropped.
      if (chunks.length >= MAX_REVIEW_CHUNKS) {
        skippedForBudget.push(file.filename);
        continue;
      }
    }

    current.push(candidate);
    currentChars += size;
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
    coveredCount: chunks.reduce((total, chunk) => total + chunk.files.length, 0),
    // Patch characters on both sides, never rendered chunk text: the rendered
    // form adds per-file headers the denominator has no equivalent for, which
    // would inflate coverage. `analyzableFiles` holds the ORIGINAL files while
    // the chunks hold possibly-truncated clones, so a truncated file correctly
    // contributes only the characters that survived.
    coveredChars: chunks.reduce(
      (total, chunk) => total + chunk.files.reduce((sum, file) => sum + (file.patch?.length ?? 0), 0),
      0,
    ),
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
      `**${aiFailedFiles.length} file(s) could not be reviewed** — the model failed on them repeatedly: ${formatFileList(aiFailedFiles)}.`,
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
