import { createTwoFilesPatch } from "diff";
import { getFileContent } from "@/lib/github/file-content";
import { logger } from "@/lib/logger";

/** Retain complete reconstructed patches; section planning bounds model requests. */

/** Context lines around each hunk — matches what GitHub's own patches carry. */
const PATCH_CONTEXT_LINES = 3;


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
  /** Complete patch; request sizing happens later in the section planner. */
  patch: string;
  /**
   * Original diff length. Retained for compatibility with callers that may
   * supply an upstream-shortened patch. Zero when no text diff exists.
   */
  originalChars: number;
}

/** Linear, exact fallback for rewrites whose minimal diff exceeds the CPU deadline. */
export function buildReplacementPatch(baseContent: string, headContent: string): string {
  const lines = (text: string) => text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const oldLines = lines(baseContent);
  const newLines = lines(headContent);
  return [
    `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...(oldLines.length && !baseContent.endsWith("\n") ? ["\\ No newline at end of file"] : []),
    ...newLines.map((line) => `+${line}`),
    ...(newLines.length && !headContent.endsWith("\n") ? ["\\ No newline at end of file"] : []),
  ].join("\n") + "\n";
}

export async function buildFallbackPatch(
  installationId: number,
  owner: string,
  repo: string,
  filename: string,
  status: string,
  baseRef: string,
  headRef: string,
  previousFilename?: string,
): Promise<FallbackPatch> {
  const wantsBase = status !== "added";
  const wantsHead = status !== "removed";

  const [baseContent, headContent] = await Promise.all([
    wantsBase ? getFileContent(installationId, owner, repo, previousFilename ?? filename, baseRef) : Promise.resolve(""),
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
    { context: PATCH_CONTEXT_LINES, timeout: 2_000 },
  );

  if (patch === undefined) {
    // Myers diff can be quadratic on a full rewrite. A replacement hunk is
    // larger but exact, linear to construct, and the section planner can
    // review it without blocking BullMQ's lock renewal for minutes.
    const body = buildReplacementPatch(baseContent ?? "", headContent ?? "");
    logger.info({ filename, chars: body.length }, "diff computation timed out; preserving full replacement patch");
    return { patch: body, originalChars: body.length };
  }

  // createTwoFilesPatch emits its own "===" banner and ---/+++ header lines;
  // strip them so the result starts at the first @@ hunk, matching the shape
  // GitHub's own `patch` field has and that computeCommentableLines parses.
  const firstHunk = patch.indexOf("@@");
  const body = firstHunk === -1 ? "" : patch.slice(firstHunk);

  if (body.length === 0) {
    // Both sides were successfully read. Empty-file creation/deletion and
    // rename-only changes are metadata changes, not retrieval failures.
    const metadata = `@@ -0,0 +0,0 @@\n# No text changes; file status: ${status}${previousFilename ? `; previous path: ${previousFilename}` : ""}.\n`;
    return { patch: metadata, originalChars: metadata.length };
  }

  return { patch: body, originalChars: body.length };
}
