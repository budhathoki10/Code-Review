import type { FindingDoc } from "@/lib/db/collections";
import type { PullRequestFile } from "@/lib/github/diff";

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

//Its only job is to decide where an AI finding can be placed as a GitHub inline comment.


/**
 * Walks each file's unified-diff patch to find which new-file line numbers
 * are actually part of the diff (context or added lines) — GitHub only
 * accepts inline review comments anchored to one of these. Removed
 * (old-file-only) lines and anything outside a hunk are never commentable.
 * Old-file (LEFT-side) commenting is intentionally not supported — findings
 * only ever describe the new code.
 */
export function computeCommentableLines(
  files: PullRequestFile[],
): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();

  for (const file of files) {
    if (!file.patch) continue;

    const commentable = new Set<number>();
    let newLine = 0;

    for (const rawLine of file.patch.split("\n")) {
      const hunkMatch = rawLine.match(HUNK_HEADER);
      if (hunkMatch) {
        newLine = Number(hunkMatch[1]);
        continue;
      }
      if (rawLine.startsWith("\\")) {
        // "\ No newline at end of file" — not a content line.
        continue;
      }
      if (rawLine.startsWith("+")) {
        commentable.add(newLine);
        newLine++;
      } else if (rawLine.startsWith("-")) {
        // Old-file-only line; doesn't exist in the new file, doesn't advance newLine.
      } else if (rawLine.startsWith(" ")) {
        commentable.add(newLine);
        newLine++;
      }
    }

    result.set(file.filename, commentable);
  }

  return result;
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

function formatInlineComment(finding: FindingDoc): string {
  const lines = [
    ` **AI Reviewer** — ${capitalize(finding.category)} · ${capitalize(finding.severity)}`,
    finding.explanation,
  ];
  if (finding.suggestion) {
    lines.push(`\n**Suggested fix:**\n\`\`\`diff\n${finding.suggestion}\n\`\`\``);
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
