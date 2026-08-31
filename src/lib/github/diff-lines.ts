import type { FindingDoc } from "@/lib/db/collections";
import type { PullRequestFile } from "@/lib/github/diff";

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

//Its only job is to decide where an AI finding can be placed as a GitHub inline comment.


/**
 * The one place a unified-diff patch is turned into new-file line numbers.
 *
 * Both public views below are built from this walk. They used to be two
 * separate copies of it, kept in step by a "mirrors the other exactly"
 * comment and a test asserting the two agreed — an invariant policed by
 * prose rather than held by construction. Anything the walk learns (a new
 * hunk-header dialect, another non-content marker) now only has to be taught
 * once, and the two results cannot drift.
 *
 * The numbering rules, which are what actually matter:
 *   - A hunk header resets the counter to the new-file start it declares.
 *   - `\ No newline at end of file` is a marker, not a content line.
 *   - Added (`+`) and context (` `) lines exist in the new file: recorded,
 *     and they advance the counter.
 *   - Removed (`-`) lines exist only in the old file: no new-file number, and
 *     they must NOT advance the counter, or every line after the first
 *     deletion is attributed to the wrong text.
 *
 * A file with a patch always gets an entry, even if that patch yields no
 * lines; a file with no patch at all gets none. Callers distinguish "reviewed
 * and empty" from "never parsed" on exactly that.
 */
function walkPatches<T>(
  files: PullRequestFile[],
  create: () => T,
  record: (into: T, line: number, text: string) => void,
): Map<string, T> {
  const result = new Map<string, T>();

  for (const file of files) {
    if (!file.patch) continue;

    const collected = create();
    let newLine = 0;

    for (const rawLine of file.patch.split("\n")) {
      const hunkMatch = rawLine.match(HUNK_HEADER);
      if (hunkMatch) {
        newLine = Number(hunkMatch[1]);
        continue;
      }
      if (rawLine.startsWith("\\")) continue;
      if (rawLine.startsWith("+") || rawLine.startsWith(" ")) {
        record(collected, newLine, rawLine.slice(1));
        newLine++;
      }
    }

    result.set(file.filename, collected);
  }

  return result;
}

/**
 * Which new-file line numbers are actually part of the diff (context or added
 * lines) — GitHub only accepts inline review comments anchored to one of
 * these. Old-file (LEFT-side) commenting is intentionally not supported:
 * findings only ever describe the new code.
 */
export function computeCommentableLines(files: PullRequestFile[]): Map<string, Set<number>> {
  return walkPatches(
    files,
    () => new Set<number>(),
    (lines, line) => lines.add(line),
  );
}

/**
 * New-file line number → that line's text, per file, read from the same
 * patches `computeCommentableLines` walks — so its keys are exactly that
 * function's line numbers, by construction.
 *
 * Exists so a stored finding can show the line it is replacing, side by side
 * with the suggestion, without re-fetching the file: the dashboard renders
 * long after the diff is gone, and GitHub's own suggestion widget gets the
 * "before" side for free from the PR page, which our dashboard does not.
 */
export function computeLineContents(files: PullRequestFile[]): Map<string, Map<number, string>> {
  return walkPatches(
    files,
    () => new Map<number, string>(),
    (contents, line, text) => contents.set(line, text),
  );
}

/**
 * How many lines of unchanged code to keep on each side of a suggestion.
 *
 * Three is what GitHub itself shows around a collapsed hunk. Fewer stops
 * being enough to recognise where you are in a function; more turns a
 * one-line fix into a wall of code the reader has to scan past.
 */
export const CONTEXT_RADIUS = 3;

/**
 * The lines bracketing `line`, for rendering a suggestion with its
 * surroundings (see FindingDoc.originalContext).
 *
 * `line` itself is excluded — the caller already stores it as `originalLine`,
 * and one copy cannot drift from another. Missing neighbours are skipped
 * rather than padded: `lineContents` only holds lines the diff actually
 * contained, so near a hunk edge the window is simply shorter, and a removed
 * line in the middle leaves a numbering gap the renderer shows as a break.
 * Returns undefined when nothing surrounds the line, so callers can leave the
 * field off entirely instead of storing an empty array.
 */
export function computeContextLines(
  lineContents: Map<number, string> | undefined,
  line: number,
  radius: number = CONTEXT_RADIUS,
): { line: number; text: string }[] | undefined {
  if (!lineContents) return undefined;

  const context: { line: number; text: string }[] = [];
  for (let n = line - radius; n <= line + radius; n++) {
    if (n === line) continue;
    const text = lineContents.get(n);
    if (text !== undefined) context.push({ line: n, text });
  }

  return context.length > 0 ? context : undefined;
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
  /**
   * The finding this comment renders. Carried alongside the rendered body so
   * a caller that caps the inline list (see capInlineComments) can still
   * render the overflow as findings in the summary body — without it, the
   * capped comments would have to be matched back to their findings by
   * path+line, which is ambiguous when two findings share a line.
   */
  finding: FindingDoc;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * A prose marker anywhere in the suggestion disqualifies it from being posted
 * as a GitHub suggestion block — the block becomes the literal replacement
 * text for the commented line, so a sentence like "or accept the current
 * approach" would be offered as code to commit. Checked case-insensitively
 * as whole words, so a legitimate identifier containing one of these (e.g. a
 * variable named `orDefault`) isn't falsely rejected.
 *
 * This is a blocklist of *hedging* words, which is only half the problem: it
 * cannot catch an imperative like "Use a transaction." — see CODE_SHAPE.
 */
const PROSE_MARKERS =
  /\b(consider|maybe|perhaps|alternatively|otherwise|should|could|would|e\.g\.?|i\.e\.?)\b|\bor\b.{0,40}\binstead\b|,\s*or\s|\.\s+[A-Z]/i;

/**
 * Positive evidence that the text is code rather than a sentence about code.
 *
 * PROSE_MARKERS alone let every imperative suggestion through — "Use a
 * transaction.", "Add a null check here.", "Extract this into a helper
 * function." all contain no hedging word and were all accepted, which is
 * exactly the false positive this whole function exists to prevent. No
 * blocklist of English words can be made complete, so the test is inverted:
 * a line of real code carries at least one structural character that an
 * English sentence does not.
 *
 * A bare-identifier replacement (`userId`) has none of these and is rejected
 * too. That's a false negative, and a false negative is always safe — it
 * renders as a plain block, exactly as it did before suggestions existed.
 */
const CODE_SHAPE = /[(){}[\]<>=;:]|=>|\w\.\w/;

/**
 * A newline that lost its backslash somewhere between the model and here.
 *
 * Observed live on PR #58: the model's replacement arrived as
 * `const allFindings = [n  ...aiResult.findings.map(f),n  ];` — literal `n`
 * characters welded to the punctuation that ended each line. Committing that
 * yields a syntax error, so the shape is rejected outright rather than
 * guessed at. `\n` as two visible characters is the same mangling one layer
 * the other way, and is just as wrong to commit.
 *
 * What follows the stray `n` has to be indentation — two or more spaces, a
 * tab, or the end of the text. Accepting a single space would also match
 * `map(n => …)`, where `n` is an ordinary parameter name and the code is
 * perfectly fine.
 */
const MANGLED_NEWLINE = /\\n|[,;{}[\]()]n(?:[ ]{2,}|\t|$)/;

/**
 * Whether `suggestion` is safe to post as a GitHub suggestion block — the
 * fenced form that renders as a one-click "commit suggestion" button rather
 * than plain text.
 *
 * GitHub applies a suggestion block as the literal, verbatim replacement for
 * the line(s) the comment is anchored to. There is no room for explanation
 * inside it: anything that isn't the fix itself would be offered to the
 * developer as code to commit. The system prompt (see FINDINGS_SYSTEM_PROMPT
 * in ai/review.ts) asks the model to leave `suggestion` as prose whenever the
 * fix isn't a clean single-line replacement — this is the safety net for
 * when it doesn't, not the primary mechanism: a false negative here just
 * falls back to today's plain rendering, which is always correct; a false
 * positive would post a sentence as if it were committable code, which is
 * the failure this function exists to prevent.
 */
export function looksLikeCleanCodeSuggestion(suggestion: string): boolean {
  const trimmed = suggestion.trim();
  if (!trimmed || trimmed.length > 400) return false;
  // A real diff/hunk means the model produced a patch, not the pure
  // replacement text GitHub's suggestion syntax requires.
  if (/^[+-]|^@@/m.test(trimmed)) return false;
  // A backtick ANYWHERE, not just at the start of a line: this text is about
  // to be wrapped in a ```suggestion fence, and a backtick run inside it
  // closes that fence early. The rest of the replacement then escapes the
  // block and renders as loose prose. Observed live on PR #58, where the
  // replacement itself contained a fence marker mid-line.
  if (trimmed.includes("`")) return false;
  if (MANGLED_NEWLINE.test(trimmed)) return false;
  if (PROSE_MARKERS.test(trimmed)) return false;
  if (!CODE_SHAPE.test(trimmed)) return false;
  // A sentence-terminal period. Code essentially never ends on `<letter>.`,
  // while prose that cleared CODE_SHAPE by quoting a symbol ("Use x() here.")
  // always does. The whitespace requirement keeps this aimed at sentences.
  if (/[a-z]\.$/i.test(trimmed) && /\s/.test(trimmed)) return false;
  return true;
}

/**
 * Re-anchors a replacement to the indentation of the line it replaces.
 *
 * GitHub commits a suggestion block verbatim, leading whitespace included, so
 * a model that returns `if (x) return;` for a line indented four levels deep
 * silently de-indents it on commit — valid-looking in the diff preview, wrong
 * in the file, and in Python or YAML a behaviour change. Observed live on
 * PR #58.
 *
 * Only applied when the model supplied no indentation of its own: if its
 * first line is already indented it has expressed an intent about placement,
 * and overriding that would be the same class of mistake in reverse.
 * Continuation lines keep their relative indentation.
 */
function reindentSuggestion(suggestion: string, originalLine: string | undefined): string {
  if (originalLine === undefined) return suggestion;
  const indent = originalLine.match(/^[ \t]*/)?.[0] ?? "";
  if (!indent || /^[ \t]/.test(suggestion)) return suggestion;
  return suggestion
    .split("\n")
    .map((line) => (line.trim() ? `${indent}${line}` : line))
    .join("\n");
}

function formatInlineComment(finding: FindingDoc): string {
  const lines = [
    ` **AI Reviewer** — ${capitalize(finding.category)} · ${capitalize(finding.severity)}`,
    finding.explanation,
  ];
  if (finding.suggestion) {
    const committable = looksLikeCleanCodeSuggestion(finding.suggestion);
    // Indentation only matters for the committable fence — the `diff` fence
    // is read-only text nobody can click to apply.
    const body = committable ? reindentSuggestion(finding.suggestion, finding.originalLine) : finding.suggestion;
    lines.push(`\n**Suggested fix:**\n\`\`\`${committable ? "suggestion" : "diff"}\n${body}\n\`\`\``);
  }
  return lines.join("\n");
}

/**
 * Splits findings into ones that can be attached to an exact diff line and
 * ones that can't (no line, wrong file, or a line outside the diff). The
 * summary comment (Phase 3) always lists every finding regardless — this
 * split only decides which ones ALSO get an inline annotation.
 */
export function mapFindingsToInlineComments(
  findings: FindingDoc[],
  commentableLines: Map<string, Set<number>>,
): { mappable: InlineComment[]; unmappable: FindingDoc[] } {
  const mappable: InlineComment[] = [];
  const unmappable: FindingDoc[] = [];

  for (const finding of findings) {
    const lines = finding.line !== undefined ? commentableLines.get(finding.file) : undefined;
    if (finding.line !== undefined && lines?.has(finding.line)) {
      mappable.push({ path: finding.file, line: finding.line, body: formatInlineComment(finding), finding });
    } else {
      unmappable.push(finding);
    }
  }

  return { mappable, unmappable };
}

/**
 * Hard ceiling on inline review comments per review. GitHub accepts far
 * more, but a review that annotates 80 lines is not read — it's dismissed,
 * and it buries the two findings that actually mattered among 78 that
 * didn't. The cap is per REVIEW, not per file or per chunk, because the
 * reader's attention budget is per review.
 */
export const MAX_INLINE_COMMENTS = Number(process.env.MAX_INLINE_COMMENTS ?? 25);

const SEVERITY_RANK: Record<FindingDoc["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/**
 * Splits mappable comments into the ones that get posted inline and the
 * overflow that goes into the summary body instead.
 *
 * Sorted by severity first so the cap spends its 25 slots on the findings
 * most worth reading at the line. Ties keep their original relative order
 * (Array#sort is stable), which is chunk order — source files before tests
 * before docs, per selectDiffForReview's ranking. Nothing is discarded here:
 * `overflow` carries its findings back to the caller for the collapsed
 * section of the summary comment.
 */
export function capInlineComments(
  comments: InlineComment[],
  limit: number = MAX_INLINE_COMMENTS,
): { posted: InlineComment[]; overflow: FindingDoc[] } {
  if (comments.length <= limit) return { posted: comments, overflow: [] };

  const ranked = [...comments].sort((a, b) => SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity]);
  return {
    posted: ranked.slice(0, limit),
    overflow: ranked.slice(limit).map((comment) => comment.finding),
  };
}
