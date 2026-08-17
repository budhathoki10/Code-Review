import type { FindingDoc } from "@/lib/db/collections";
import type { PullRequestFile } from "@/lib/github/diff";

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

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
      mappable.push({ path: finding.file, line: finding.line, body: formatInlineComment(finding) });
    } else {
      unmappable.push(finding);
    }
  }

  return { mappable, unmappable };
}
