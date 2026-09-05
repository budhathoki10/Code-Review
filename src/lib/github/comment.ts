import { getInstallationOctokit } from "@/lib/github/app";
import type { FindingDoc } from "@/lib/db/collections";
import { groupFindingsBySeverity } from "@/lib/review/review-display";
import { evidenceLabel } from "@/lib/review/finding-policy";

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
    evidenceLabel(finding),
    ...(finding.verification?.status === "accepted" ? [`Assessment: ${finding.verification.reason}`, ...finding.verification.evidence.map((e) => `Evidence at \`${e.file}:${e.line}\`: \`${e.quote.replace(/`/g, "'")}\``)] : []),
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
 * Renders one severity's findings as a collapsed folder, worst severity
 * first, matching how the dashboard groups them.
 *
 * `<details>` rather than component state, because this is Markdown posted to
 * GitHub, not a React tree — there is no client to hold an open/closed set,
 * and GitHub strips scripts and styles. The native element already gives
 * every behavior that state would: closed by default, click to toggle, each
 * folder independent so several can be open at once, and its own disclosure
 * triangle.
 *
 * The blank lines after `</summary>` and before `</details>` are required —
 * without them GitHub renders the block's Markdown as literal text.
 */
function formatSeverityFolders(findings: FindingDoc[]): string[] {
  return groupFindingsBySeverity(findings).flatMap((group) => [
    "<details>",
    `<summary>${SEVERITY_EMOJI[group.severity]} <b>${group.severity.toUpperCase()}</b> · ${group.findings.length}</summary>`,
    "",
    group.findings.map(formatFinding).join("\n\n"),
    "",
    "</details>",
    // Separates one folder from the next; without it GitHub renders
    // back-to-back folders flush against each other.
    "",
  ]);
}

/**
 * Findings are grouped into one collapsed folder per severity (see
 * formatSeverityFolders), the same grouping the dashboard uses — a review
 * with two dozen findings lands as three or four compact rows instead of an
 * unreadable wall, and "what's critical here?" is answerable without reading
 * everything.
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
    parts.push(...formatSeverityFolders(review.findings));
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
