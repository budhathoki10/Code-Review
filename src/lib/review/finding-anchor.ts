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
 * Every post-change line whose text matches the snippet's first substantial line.
 *
 * A multi-line snippet anchors on its first substantial line: that is the one
 * a comment should attach to, and requiring every line to match would reject
 * a snippet the model reformatted slightly.
 */
export function anchorCandidates(snippet: string | undefined, index: Map<number, string>): number[] {
  if (!snippet) return [];
  const needle = snippet
    .split("\n")
    .map(normalise)
    // Braces and similar match everywhere; they cannot identify a line.
    .find((line) => line.length > 3);
  if (!needle) return [];

  const hits: number[] = [];
  for (const [line, text] of index) {
    if (normalise(text) === needle) hits.push(line);
  }
  return hits;
}

/** The line a snippet unambiguously occupies, or undefined. */
export function anchorLine(snippet: string | undefined, index: Map<number, string>): number | undefined {
  const hits = anchorCandidates(snippet, index);
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Quote style is not a difference worth reporting.
 *
 * A model asked for a suggestion re-types the line in whatever quoting it
 * prefers, so `'password'` and `"password"` come back as different strings for
 * identical code. Only used for the no-op check below, never for anchoring,
 * where a quote change is a real edit a reader may want to see.
 */
function normaliseCode(line: string): string {
  return line.replace(/\s+/g, " ").replace(/['"`]/g, '"').trim();
}

/** Below this, a line is too generic for its presence in the file to mean anything. */
const MIN_NO_OP_LENGTH = 20;

/**
 * Whether applying this suggestion would change nothing.
 *
 * A suggestion identical to code already in the file is self-refuting: the
 * finding says a change is needed and its own proposed change is the current
 * state. Measured on a real review, a model reported a security bug — a
 * password flag hardcoded to false — and supplied, as the fix, the exact line
 * already in the file. It had inferred the absence from a diff hunk that did
 * not happen to show that line.
 *
 * This is deliberately not a judgement about whether the finding is right. A
 * no-op suggestion is useless to the reader either way, and dropping it costs
 * nothing a correct finding would have delivered.
 *
 * Short lines are exempt: `return null;` appears in most files and its
 * presence proves nothing about the finding that proposed it.
 */
export function suggestionIsNoOp(suggestion: string | undefined, index: Map<number, string>): boolean {
  if (!suggestion) return false;
  const wanted = suggestion
    .split("\n")
    .map(normaliseCode)
    .filter((line) => line.length >= MIN_NO_OP_LENGTH);
  if (wanted.length === 0) return false;

  const present = new Set<string>();
  for (const text of index.values()) present.add(normaliseCode(text));
  return wanted.every((line) => present.has(line));
}

export interface AnchorableFinding {
  file: string;
  line?: number;
  codeSnippet?: string;
  suggestion?: string;
}

export interface AnchorStats {
  corrected: number;
  confirmed: number;
  unanchored: number;
  /** Findings whose line could not be verified and now carry none. */
  delined: number;
  /** Findings dropped because their suggestion was already the file's content. */
  dropped: number;
}

/**
 * Rewrites each finding's line to where its quoted code really is, and drops
 * the ones the patch contradicts.
 *
 * A finding whose quote matches nothing in the patch keeps no line at all.
 * Leaving the model's own number there was the earlier behaviour and it failed
 * open: an unmatched quote means the reported line is unverified, and posting
 * an unverified line produces a correct-looking comment on unrelated code —
 * measured on a real review, findings about one function landed inside a CSS
 * string a hundred lines away. A finding with no line still reaches the reader
 * through the summary body (see mapFindingsToInlineComments), which is where
 * one that cannot say where it lives belongs.
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

  const stats: AnchorStats = { corrected: 0, confirmed: 0, unanchored: 0, delined: 0, dropped: 0 };
  const anchored: T[] = [];

  for (const finding of findings) {
    const index = indexes.get(finding.file);
    // No patch for this file in this chunk — there is nothing to check the
    // line against, and nothing to contradict it either. Left as reported;
    // computeCommentableLines still refuses to post it at a line the diff
    // does not cover.
    if (!index || index.size === 0) {
      stats.unanchored += 1;
      anchored.push(finding);
      continue;
    }

    if (suggestionIsNoOp(finding.suggestion, index)) {
      stats.dropped += 1;
      continue;
    }

    const hits = anchorCandidates(finding.codeSnippet, index);
    if (hits.length === 1) {
      if (hits[0] === finding.line) stats.confirmed += 1;
      else stats.corrected += 1;
      anchored.push({ ...finding, line: hits[0] });
      continue;
    }

    // Several identical lines: this cannot tell which was meant, but if the
    // model's own number is one of them, the two agree and that is enough.
    if (hits.length > 1 && finding.line !== undefined && hits.includes(finding.line)) {
      stats.confirmed += 1;
      anchored.push(finding);
      continue;
    }

    stats.unanchored += 1;
    if (finding.line === undefined) {
      anchored.push(finding);
      continue;
    }
    stats.delined += 1;
    anchored.push({ ...finding, line: undefined });
  }

  return { findings: anchored, stats };
}
