import { createTwoFilesPatch } from "diff";
import { getFileContent } from "@/lib/github/file-content";
import { logger } from "@/lib/logger";

/**
 * How much locally-computed patch text one file may contribute. A file whose
 * diff GitHub refused to render is, by definition, enormous — recomputing it
 * in full and handing the model 2 MB of hunks would blow the very budget
 * this fallback exists to keep the file inside. Deliberately generous enough
 * that a typical "too big for GitHub" file (a few thousand changed lines)
 * still arrives whole.
 */
const MAX_GENERATED_PATCH_CHARS = Number(process.env.MAX_GENERATED_PATCH_CHARS ?? 60_000);

/** Context lines around each hunk — matches what GitHub's own patches carry. */
const PATCH_CONTEXT_LINES = 3;

const TRUNCATION_NOTE = "\n...[locally computed diff truncated — file too large to include in full]";

/**
 * Marker used when a file's diff could not be produced by any route. It is
 * deliberately a real patch body rather than an omission: the file still
 * appears in the review with an explicit statement that its contents are
 * unknown, so "no issues found" can never be read as a claim about a file
 * nobody actually looked at.
 */
export function diffUnavailableNote(filename: string, reason: string): string {
  return `@@ -0,0 +0,0 @@\n# DIFF UNAVAILABLE for ${filename}: ${reason}.\n# This file changed in this pull request but its contents could not be retrieved, so it was NOT reviewed.`;
}

/**
 * Rebuilds a unified diff for one file locally, for the case GitHub declines
 * to render itself.
 *
 * GitHub omits `patch` when a single file's diff is very large. Before this,
 * such a file was dropped by every downstream filter without appearing in
 * any "what went unreviewed" list — the failure mode being fixed here, and
 * the worst one in the pipeline, since the files GitHub refuses to diff are
 * exactly the largest changes in the PR.
 *
 * Fetches the file at both refs through getFileContent (which caches, and
 * which falls back to the Blobs API for anything over the Contents API's
 * 1 MB ceiling — expected to fire often on precisely these files) and diffs
 * the two strings. Never throws for a missing side: an added file has no
 * base, a deleted file has no head, and both are normal.
 */
export interface FallbackPatch {
  /** The patch to review — possibly truncated to fit the review budget. */
  patch: string;
  /**
   * Length of the diff BEFORE truncation.
   *
   * Coverage is measured against this, not against the truncated result.
   * Without it, a file whose 400,000-character diff was cut to 60,000 reports
   * as fully covered, because everything downstream only ever sees the
   * shortened patch — the truncation becomes invisible at exactly the point
   * the coverage gate is trying to measure it. Zero when there was no diff to
   * measure (an unavailable or identical file).
   */
  originalChars: number;
}

export async function buildFallbackPatch(
  installationId: number,
  owner: string,
  repo: string,
  filename: string,
  status: string,
  baseRef: string,
  headRef: string,
): Promise<FallbackPatch> {
  const wantsBase = status !== "added";
  const wantsHead = status !== "removed";

  const [baseContent, headContent] = await Promise.all([
    wantsBase ? getFileContent(installationId, owner, repo, filename, baseRef) : Promise.resolve(""),
    wantsHead ? getFileContent(installationId, owner, repo, filename, headRef) : Promise.resolve(""),
  ]);

  if (baseContent === undefined && headContent === undefined) {
    logger.warn({ filename, status }, "diff unavailable — could not read the file at either ref");
    return { patch: diffUnavailableNote(filename, "the file could not be read at either commit (binary, too large, or unreadable)"), originalChars: 0 };
  }
  // One side missing when the status says it should exist means a genuinely
  // unreadable blob — most often a binary file the Blobs fallback declined.
  if ((wantsBase && baseContent === undefined) || (wantsHead && headContent === undefined)) {
    logger.warn({ filename, status }, "diff unavailable — one side of the comparison could not be read");
    return { patch: diffUnavailableNote(filename, "the file could not be read at one of the two commits (likely binary or too large)"), originalChars: 0 };
  }

  const patch = createTwoFilesPatch(
    `a/${filename}`,
    `b/${filename}`,
    baseContent ?? "",
    headContent ?? "",
    undefined,
    undefined,
    { context: PATCH_CONTEXT_LINES },
  );

  // createTwoFilesPatch emits its own "===" banner and ---/+++ header lines;
  // strip them so the result starts at the first @@ hunk, matching the shape
  // GitHub's own `patch` field has and that computeCommentableLines parses.
  const firstHunk = patch.indexOf("@@");
  const body = firstHunk === -1 ? "" : patch.slice(firstHunk);

  if (body.length === 0) {
    return { patch: diffUnavailableNote(filename, "the file's contents are identical at both commits"), originalChars: 0 };
  }

  if (body.length > MAX_GENERATED_PATCH_CHARS) {
    logger.info({ filename, chars: body.length }, "locally computed patch truncated to fit the review budget");
    return {
      patch: `${body.slice(0, MAX_GENERATED_PATCH_CHARS)}${TRUNCATION_NOTE}`,
      originalChars: body.length,
    };
  }

  return { patch: body, originalChars: body.length };
}
