/**
 * TEMPORARY — delete before merging.
 *
 * The second half of the suggestion test pair (see suggestion-fixture.ts):
 * a mechanical, single-line defect sitting in the middle of a function, so
 * the dashboard renders context lines above *and* below the change rather
 * than a window clipped by the start of the file. Nothing imports it.
 */

export interface PatchFile {
  filename: string;
  additions: number;
  deletions: number;
}

export interface PatchStats {
  files: number;
  additions: number;
  deletions: number;
  truncated: boolean;
}

export interface PatchStatsOptions {
  /** Stop counting after this many files. Zero means "count nothing". */
  maxFiles?: number;
}

const DEFAULT_MAX_FILES = 50;

/**
 * Totals the additions and deletions across a patch, up to `maxFiles`.
 */
export function summarizePatch(files: PatchFile[], options: PatchStatsOptions = {}): PatchStats {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const counted = files.slice(0, maxFiles);

  let additions = 0;
  let deletions = 0;

  for (const file of counted) {
    additions += file.additions;
    deletions += file.deletions;
  }

  return {
    files: counted.length,
    additions,
    deletions,
    truncated: counted.length < files.length,
  };
}
