import type { PullRequestFile } from "@/lib/github/diff";
import { computeLineContents } from "@/lib/github/diff-lines";
import type { LocationValidation, TrackedFinding } from "@/lib/review/stage-types";

/**
 * The one stage no model participates in.
 *
 * Every claim above this point is a model's assertion about where something
 * is, and a fluent wrong line number is indistinguishable from a right one
 * until someone opens the file. Here the repository decides: the file either
 * exists at the reviewed commit or it does not, the line either exists or it
 * does not, the quoted snippet either matches the bytes at that line or it
 * does not.
 *
 * A line that is wrong is corrected only when the correction is unambiguous —
 * exactly one line in a small window carries the quoted code. Anything else
 * is left invalid. Guessing a plausible nearby line is how a reader is sent
 * to code that has nothing to do with the finding, and losing a real defect
 * to a strict check is much cheaper than that.
 *
 * "We did not fetch that file" is NOT the same as "that file does not exist",
 * and conflating them was measured discarding four of five findings on a real
 * pull request: the context builder fetches a bounded number of files, this
 * ran over the rest, and every finding beyond the budget was marked invalid
 * for a reason that had nothing to do with whether it was right. Callers now
 * supply the missing sources before validating (see resolveMissingSources).
 */

const SEARCH_RADIUS = 15;

function normalise(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** Lines in a window whose content matches the quote, ignoring indentation and run-length whitespace. */
function matchingLines(lines: string[], quote: string, around: number): number[] {
  const needle = normalise(quote);
  if (needle.length < 3) return [];
  const hits: number[] = [];
  const from = Math.max(1, around - SEARCH_RADIUS);
  const to = Math.min(lines.length, around + SEARCH_RADIUS);
  for (let n = from; n <= to; n++) {
    if (normalise(lines[n - 1] ?? "") === needle) hits.push(n);
  }
  return hits;
}

export interface ValidationInput {
  /** Head content per path at the reviewed commit, from the shared context builder. */
  sources: Map<string, string>;
  /** The PR's changed files, for deciding whether a finding is about this change at all. */
  files: PullRequestFile[];
  commitSha: string;
}

/**
 * Checks one finding's location against the repository and, where it can be
 * done unambiguously, repairs it.
 *
 * `relevantToPR` is deliberately generous: a defect can legitimately sit in
 * unchanged code that the change newly reaches, so touching a changed file is
 * enough. It is only false when the finding names a file this pull request
 * never touched at all.
 */
export function validateLocation(tracked: TrackedFinding, input: ValidationInput): TrackedFinding {
  const { candidate } = tracked;
  const changedFiles = new Set(input.files.map((f) => f.filename));
  const content = input.sources.get(candidate.file);

  const validation: LocationValidation = {
    fileValid: content !== undefined,
    lineValid: false,
    snippetValid: false,
    commitValid: input.commitSha.length > 0,
    relevantToPR: changedFiles.has(candidate.file),
  };

  if (content === undefined) return { ...tracked, validation };

  const lines = content.split("\n");
  let startLine = candidate.startLine;
  let endLine = Math.max(candidate.startLine, candidate.endLine);
  validation.lineValid = startLine >= 1 && startLine <= lines.length && endLine <= lines.length;

  // A quoted snippet is the only thing that can repair a wrong line, and only
  // when it appears exactly once nearby. Two matches is ambiguous; zero means
  // there is nothing to anchor to.
  const anchorQuote = candidate.evidence.find((e) => e.file === candidate.file)?.quote
    ?? candidate.codeSnippet?.split("\n").map((l) => l.trim()).find((l) => l.length > 2);

  if (anchorQuote) {
    const exact = validation.lineValid && normalise(lines[startLine - 1] ?? "") === normalise(anchorQuote);
    if (exact) {
      validation.snippetValid = true;
    } else {
      const hits = matchingLines(lines, anchorQuote, startLine);
      if (hits.length === 1) {
        const corrected = hits[0];
        endLine = Math.max(corrected, corrected + (endLine - startLine));
        validation.correctedFrom = startLine;
        startLine = corrected;
        validation.lineValid = true;
        validation.snippetValid = true;
      } else {
        validation.snippetValid = false;
      }
    }
  }

  // Evidence that does not match the file it claims cannot support anything,
  // so it is dropped rather than shown to a reader as corroboration.
  const evidence = candidate.evidence.filter((e) => {
    const source = input.sources.get(e.file);
    if (!source) return false;
    const sourceLines = source.split("\n");
    return normalise(sourceLines[e.line - 1] ?? "") === normalise(e.quote);
  });

  return {
    ...tracked,
    candidate: { ...candidate, startLine, endLine, evidence },
    validation,
  };
}

/**
 * Whether a validated finding may be presented as a confirmed defect.
 *
 * The bar is location, not verdict: a finding whose file does not exist, or
 * whose lines do not, cannot be shown to anybody usefully however certain the
 * reviewers were about it. Findings that fail here are kept as unresolved so
 * they remain auditable, rather than deleted.
 */
export function isPresentable(tracked: TrackedFinding): boolean {
  const v = tracked.validation;
  if (!v) return false;
  return v.fileValid && v.lineValid && v.commitValid && v.relevantToPR;
}

/** True when the finding's line numbers are inside the diff GitHub will accept a comment on. */
export function isCommentable(tracked: TrackedFinding, files: PullRequestFile[]): boolean {
  const lines = computeLineContents(files).get(tracked.candidate.file);
  return Boolean(lines?.has(tracked.candidate.startLine));
}
