import type { PullRequestFile } from "@/lib/github/diff";

/**
 * Snaps a finding's line number to the line its quoted code actually sits on.
 *
 * A model reports a fluent, confident line number that is regularly wrong:
 * measured on a real pull request, a finding about swapped error constants on
 * lines 11-14 was reported at 110-114, and one about a helper on lines 25-27
 * was reported at 33. The finding itself was right both times. Nothing
 * downstream can tell the difference, because a wrong line number looks
 * exactly like a right one until someone opens the file — and these are
 * posted as inline comments, so the author sees a correct finding attached to
 * unrelated code and concludes the reviewer is broken.
 *
 * The repair is deterministic and uses only the patch already in hand: the
 * hunk headers carry real post-change line numbers, so the quoted line can be
 * looked up rather than trusted.
 *
 * Ambiguity is never guessed. A quote matching two lines, or none, leaves the
 * finding exactly as the model reported it — sending a reader to a plausible
 * but wrong line is worse than leaving the original number alone, and this
 * cannot tell which of two identical lines was meant.
 */

/** Collapses whitespace so indentation changes and tabs-vs-spaces do not defeat a match. */
function normalise(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/**
 * Maps post-change line number to text for one file's patch.
 *
 * Context and added lines only: a removed line does not exist in the file the
 * reader will open, so anchoring a comment to one is not possible.
 */
export function patchLineIndex(patch: string | undefined): Map<number, string> {
  const index = new Map<number, string>();
  if (!patch) return index;

  let lineNumber = 0;
  for (const raw of patch.split("\n")) {
    const header = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      lineNumber = Number(header[1]);
      continue;
    }
    if (lineNumber === 0) continue;
    // "\ No newline at end of file" carries no line of its own.
    if (raw.startsWith("\\")) continue;
    if (raw.startsWith("-")) continue;
    if (raw.startsWith("+") || raw.startsWith(" ")) {
      index.set(lineNumber, raw.slice(1));
      lineNumber += 1;
      continue;
    }
    // A bare line in a unified diff is context emitted without its leading
    // space by some providers; treat it as context rather than losing the
    // rest of the hunk's numbering.
    index.set(lineNumber, raw);
    lineNumber += 1;
  }
  return index;
}

/**
 * The line a snippet unambiguously occupies, or undefined.
 *
 * A multi-line snippet anchors on its first substantial line: that is the one
 * a comment should attach to, and requiring every line to match would reject
 * a snippet the model reformatted slightly.
 */
export function anchorLine(snippet: string | undefined, index: Map<number, string>): number | undefined {
  if (!snippet) return undefined;
  const needle = snippet
    .split("\n")
    .map(normalise)
    // Braces and similar match everywhere; they cannot identify a line.
    .find((line) => line.length > 3);
  if (!needle) return undefined;

  const hits: number[] = [];
  for (const [line, text] of index) {
    if (normalise(text) === needle) hits.push(line);
    if (hits.length > 1) return undefined;
  }
  return hits[0];
}

export interface AnchorableFinding {
  file: string;
  line?: number;
  codeSnippet?: string;
}

export interface AnchorStats {
  corrected: number;
  confirmed: number;
  unanchored: number;
}

/**
 * Rewrites each finding's line to where its quoted code really is.
 *
 * Returns the findings and a tally, so a review that is silently failing to
 * anchor anything is visible in the logs rather than only in a reader's
 * confusion.
 */
export function anchorFindings<T extends AnchorableFinding>(
  findings: T[],
  files: PullRequestFile[],
): { findings: T[]; stats: AnchorStats } {
  const indexes = new Map<string, Map<number, string>>();
  for (const file of files) indexes.set(file.filename, patchLineIndex(file.patch));

  const stats: AnchorStats = { corrected: 0, confirmed: 0, unanchored: 0 };
  const anchored = findings.map((finding) => {
    const index = indexes.get(finding.file);
    if (!index || index.size === 0) {
      stats.unanchored += 1;
      return finding;
    }
    const line = anchorLine(finding.codeSnippet, index);
    if (line === undefined) {
      stats.unanchored += 1;
      return finding;
    }
    if (line === finding.line) {
      stats.confirmed += 1;
      return finding;
    }
    stats.corrected += 1;
    return { ...finding, line };
  });

  return { findings: anchored, stats };
}
