import { getInstallationOctokit } from "@/lib/github/app";
import type { FindingDoc } from "@/lib/db/collections";

// this write the comment in the github
const SEVERITY_EMOJI: Record<FindingDoc["severity"], string> = {
  critical: "🔴",
  high: "🔴",
  medium: "🟠",
  low: "🔵",
  info: "⚪",
};

function formatFinding(finding: FindingDoc): string {
  const location = finding.line ? `\`${finding.file}:${finding.line}\`` : `\`${finding.file}\``;
  const lines = [
    `${SEVERITY_EMOJI[finding.severity]} **${capitalize(finding.severity)} — ${capitalize(finding.category)}**`,
    `${location} — ${finding.title}`,
    finding.explanation,
  ];
  if (finding.suggestion) {
    lines.push(`\n\`\`\`diff\n${finding.suggestion}\n\`\`\``);
  }
  return lines.join("\n");
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Matches the sample output shape from Documentation.md's Phase 3 section.
 *
 * `overflowFindings` are findings that qualified for an inline comment but
 * lost the per-review inline cap (see capInlineComments). They are rendered
 * in a collapsed <details> block rather than posted as individual line
 * comments — still fully disclosed, just not occupying the reader's
 * attention by default. They are deliberately NOT also listed in the main
 * findings list above, so every finding appears exactly once in this
 * comment.
 */
export function formatSummaryComment(review: {
  summary?: string;
  findings: FindingDoc[];
  overflowFindings?: FindingDoc[];
}): string {
  const parts = ["##  AI Code Review", "", review.summary ?? "No summary available."];

  if (review.findings.length > 0) {
    parts.push("", `**Findings (${review.findings.length}):**`, "");
    parts.push(review.findings.map(formatFinding).join("\n\n"));
  }

  const overflow = review.overflowFindings ?? [];
  if (overflow.length > 0) {
    // The blank line after </summary> is required — without it GitHub
    // renders the block's Markdown as literal text.
    parts.push(
      "",
      "<details>",
      `<summary><b>${overflow.length} more finding(s)</b> — not posted inline to keep this review readable</summary>`,
      "",
      overflow.map(formatFinding).join("\n\n"),
      "",
      "</details>",
    );
  }

  return parts.join("\n");
}

/** Posts the summary comment and returns the created comment's GitHub ID. */
export async function postSummaryComment(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<number> {
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    { owner, repo, issue_number: prNumber, body },
  );
  return Number(data.id);
}

/**
 * Edits an existing summary comment in place instead of posting a new one —
 * used for incremental reviews, so a PR with many small pushes gets one
 * comment kept up to date rather than a new comment spammed per push.
 */
export async function updateSummaryComment(
  installationId: number,
  owner: string,
  repo: string,
  commentId: number,
  body: string,
): Promise<void> {
  const octokit = await getInstallationOctokit(installationId);
  await octokit.request(
    "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
    { owner, repo, comment_id: commentId, body },
  );
}
