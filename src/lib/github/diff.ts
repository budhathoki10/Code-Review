import { getInstallationOctokit } from "@/lib/github/app";
import { buildFallbackPatch } from "@/lib/github/patch-fallback";
import { logger } from "@/lib/logger";
import { envNumber } from "@/lib/env";
import { isBinaryPath } from "@/lib/github/file-types";

//  this  ask for the github to get the changed file

/**
 * Per-AI-pass budget, NOT a review cutoff. A PR bigger than this is split
 * into several passes by selectDiffForReview (see review/diff-selection.ts)
 * rather than skipped — these two constants bound one chunk, not the review.
 *
 * The char budget is sized against the model's COMPLETION budget, not its
 * context window. Reasoning is on, and the reasoning trace is spent out of
 * `NVIDIA_MAX_TOKENS` before the `submit_findings` tool call is emitted — so
 * a chunk large enough to reason at length about truncates the answer and
 * throws "Model output exhausted its token budget", losing the whole chunk.
 * Measured on this endpoint: 100k-char chunks (~25-30k input tokens) hit
 * `finish_reason: "length"` and cost a 458-file PR every one of its files,
 * while a 35k-char chunk answers with `tool_calls` and room to spare.
 *
 * The file count is an attention budget, not a size one. Measured on an
 * 11-file PR with a real bug repeated across four dialect files: as one
 * chunk the model reported nothing in two runs of three, and as four chunks
 * it reported findings in three of three, naming the bug in all four files.
 * A chunk it can hold in its head is worth more than a chunk that fits.
 */
export const MAX_DIFF_FILES = Math.max(1, Math.floor(envNumber("MAX_DIFF_FILES", 8)));
export const MAX_DIFF_CHARS = Math.max(1024, Math.floor(envNumber("MAX_DIFF_CHARS", 15_000)));

const FILES_PER_PAGE = 100;

/**
 * GitHub's pull-request files endpoint stops at 3000 files however you
 * paginate it, so a PR past this point can never be fully enumerated through
 * this API. Rather than review a silently truncated file list, such a PR is
 * flagged oversized and handed to the Phase 2 bail-out, which reports the
 * real counts instead of guessing.
 */
export const GITHUB_MAX_PR_FILES = 3000;

/**
 * How many files may take the `patch: null` fallback route in one review.
 * Each one costs two content fetches (and often two Blobs fetches on top),
 * so a PR where hundreds of files exceeded GitHub's diff-rendering limit
 * would spend its entire rate-limit budget here. Past this point the
 * remaining files are marked "diff unavailable", which is the same honest
 * outcome, just without paying for it.
 */
const MAX_PATCH_FALLBACKS = Math.max(0, envNumber("MAX_PATCH_FALLBACKS", GITHUB_MAX_PR_FILES));

export interface PullRequestFile {
  filename: string;
  patch?: string;
  status: string;
  /** Total changed lines GitHub attributes to this file — recorded before any expensive work, so Phase 2 can gate on size without fetching anything. */
  changes?: number;
  additions?: number;
  deletions?: number;
  previousFilename?: string;
  /** True when this file's patch was computed locally because GitHub returned `patch: null`, or is a "diff unavailable" marker. */
  patchSource?: "github" | "local" | "unavailable";
  /**
   * Size of this file's diff before any truncation, when the patch we hold is
   * shorter than the real thing. Coverage measures against this so a file cut
   * from 400k characters to 60k cannot report as fully covered.
   */
  originalPatchChars?: number;
}

export interface PullRequestDiff {
  fileCount: number;
  diffText: string;
  files: PullRequestFile[];
  /** Sum of `changes` across every file — the number Phase 2's max_changed_lines gate reads. */
  totalChangedLines: number;
  /** Set when the PR exceeds what the files endpoint can enumerate; the caller must bail out rather than review a partial list. */
  oversized?: boolean;
}

/** Binary files (no `patch` field from GitHub) are skipped rather than guessed at. Shared by getPullRequestDiff and getIncrementalDiff so both build the same diffText shape the AI/linters already expect. */
export function buildDiffText(files: { filename: string; patch?: string }[]): string {
  return files
    .filter((file) => file.patch)
    .map((file) => `--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch}`)
    .join("\n\n");
}

interface RawFile {
  previous_filename?: string;
  filename: string;
  patch?: string | null;
  status: string;
  changes?: number;
  additions?: number;
  deletions?: number;
}

function toPullRequestFile(raw: RawFile): PullRequestFile {
  return {
    filename: raw.filename,
    previousFilename: raw.previous_filename,
    // Normalize null to undefined up front so the rest of the pipeline has
    // exactly one "no patch" representation to reason about.
    patch: raw.patch ?? undefined,
    status: raw.status,
    changes: raw.changes,
    additions: raw.additions,
    deletions: raw.deletions,
    patchSource: raw.patch ? "github" : undefined,
  };
}

/**
 * Fills in patches GitHub declined to render.
 *
 * A file with no patch is either binary (nothing to review, and the noise
 * filter drops it anyway) or so large that GitHub gave up rendering its
 * diff — the second case being the one that matters, since those are the
 * biggest changes in the PR and were previously dropped without appearing in
 * any "unreviewed" list. Every such file leaves this function with either a
 * real patch or an explicit "diff unavailable" marker; none leave with
 * nothing.
 */
async function fillMissingPatches(
  installationId: number,
  owner: string,
  repo: string,
  files: PullRequestFile[],
  baseRef: string,
  headRef: string,
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void },
): Promise<void> {
  const missing = files.filter((file) => file.patch === undefined && !isBinaryPath(file.filename));
  if (missing.length === 0) return;

  log.info({ count: missing.length }, "files returned without a patch — reconstructing diffs locally");

  let budget = MAX_PATCH_FALLBACKS;
  for (const file of missing) {
    if (budget <= 0) {
      file.patch = `@@ -0,0 +0,0 @@\n# DIFF UNAVAILABLE for ${file.filename}: too many oversized files in this pull request to reconstruct them all.\n# This file changed but was NOT reviewed.`;
      file.patchSource = "unavailable";
      continue;
    }
    budget -= 1;

    const fallback = await buildFallbackPatch(
      installationId,
      owner,
      repo,
      file.filename,
      file.status,
      baseRef,
      headRef,
      file.previousFilename,
    );
    file.patch = fallback.patch;
    file.patchSource = fallback.patch.includes("# DIFF UNAVAILABLE") ? "unavailable" : "local";
    // Only meaningful when the reconstruction was cut short; otherwise the
    // patch we hold IS the whole diff and the default (patch.length) is right.
    if (fallback.originalChars > fallback.patch.length) {
      file.originalPatchChars = fallback.originalChars;
    }
  }

  const unavailable = missing.filter((file) => file.patchSource === "unavailable").map((file) => file.filename);
  if (unavailable.length > 0) {
    log.warn({ files: unavailable }, "some files have no obtainable diff and are reported as unreviewed");
  }
}

function summarize(files: PullRequestFile[]): { totalChangedLines: number } {
  return { totalChangedLines: files.reduce((total, file) => total + (file.changes ?? 0), 0) };
}

/**
 * Builds a unified-diff-style text blob from a PR's changed files, diffed
 * against its base branch — always the *entire* PR, regardless of what was
 * reviewed before. Used for the first review of a PR, and as the fallback
 * whenever getIncrementalDiff isn't usable.
 *
 * Fully paginated: the files endpoint defaults to 30 per page, so a PR of
 * any real size was previously reviewed from a truncated file list with
 * nothing recording that fact.
 */
export async function getPullRequestDiff(
  installationId: number,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PullRequestDiff> {
  const octokit = await getInstallationOctokit(installationId);

  const raw = (await octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: FILES_PER_PAGE,
  })) as RawFile[];

  const files = raw.map(toPullRequestFile);

  // At the endpoint's hard ceiling the list is truncated by GitHub, not by
  // us, and there is no way to page past it — so the honest move is to
  // report the PR as un-enumerable and let the caller bail out.
  const oversized = files.length >= GITHUB_MAX_PR_FILES;

  // The base/head SHAs are only needed to reconstruct diffs GitHub declined
  // to render, so they're fetched lazily — a PR where every file came back
  // with a patch (the overwhelming majority) pays nothing for this.
  const needsFallback = files.some((file) => file.patch === undefined && !isBinaryPath(file.filename));
  if (!oversized && needsFallback) {
    const { data: pr } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: pullNumber,
    });
    await fillMissingPatches(installationId, owner, repo, files, pr.base.sha, pr.head.sha, logger);
  }

  return {
    fileCount: files.length,
    diffText: buildDiffText(files),
    files,
    ...summarize(files),
    ...(oversized ? { oversized: true } : {}),
  };
}

/**
 * Builds the same PullRequestDiff shape, but diffed between two arbitrary
 * commits (the previous review's headSha and this push's headSha) instead
 * of against the PR's base branch — the delta since the last review, not
 * the whole PR. Uses GitHub's compare API, which computes a merge-base
 * ("three-dot") diff, so it still returns a sensible result even if history
 * was rewritten (e.g. a force-push) rather than erroring outright — callers
 * should still treat this as fallible (see pipeline.ts's fallback to
 * getPullRequestDiff on any rejection here).
 *
 * Paginated for the same reason the files endpoint is: `compare` returns at
 * most 300 files per page, and a large delta silently lost the rest.
 */
export async function getIncrementalDiff(
  installationId: number,
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
): Promise<PullRequestDiff> {
  const octokit = await getInstallationOctokit(installationId);

  const pages = (await octokit.paginate("GET /repos/{owner}/{repo}/compare/{basehead}", {
    owner,
    repo,
    basehead: `${baseSha}...${headSha}`,
    per_page: FILES_PER_PAGE,
  })) as { files?: RawFile[] }[];

  // The compare endpoint returns an object, not a list, so paginate yields
  // one whole response per page rather than concatenating rows — and it
  // pages over COMMITS (`total_commits`), not files. A file touched by
  // commits on more than one page can therefore appear more than once, so
  // flattening alone would review it twice and report duplicate findings.
  // First occurrence wins, except that an entry carrying a patch always
  // beats one without.
  const byName = new Map<string, RawFile>();
  for (const page of pages) {
    for (const raw of page.files ?? []) {
      const existing = byName.get(raw.filename);
      if (!existing || (!existing.patch && raw.patch)) byName.set(raw.filename, raw);
    }
  }

  const totalRows = pages.reduce((total, page) => total + (page.files?.length ?? 0), 0);
  if (totalRows > byName.size) {
    logger.debug({ totalRows, unique: byName.size }, "compare pages repeated files — deduplicated by filename");
  }

  const files = [...byName.values()].map(toPullRequestFile);

  // Compare pagination pages commits, not files; GitHub only supplies the
  // first 300 changed paths. Force the pipeline's full-PR fallback at the cap.
  if (files.length >= 300) throw new Error("Incremental compare reached GitHub's 300-file limit; full PR diff required");

  await fillMissingPatches(installationId, owner, repo, files, baseSha, headSha, logger);

  return {
    fileCount: files.length,
    diffText: buildDiffText(files),
    files,
    ...summarize(files),
  };
}
