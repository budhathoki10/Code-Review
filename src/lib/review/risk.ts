import type { PullRequestFile } from "@/lib/github/diff";

/** Cheap, explainable signals, not a claim that every matching file is vulnerable. */
export function riskReasons(file: PullRequestFile): string[] {
  const reasons: string[] = [];
  const path = file.filename.toLowerCase();
  const changed = (file.patch ?? "").split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line)).join("\n");
  if (/(^|[/_.-])(auth\w*|permission\w*|session\w*|middleware|rbac)([/_.-]|$)/.test(path) ||
      /\b(checkPermission|isAdmin|authorize|verifyToken|verifySignature|requireAuth)\b/.test(changed)) reasons.push("authentication / permissions");
  if (/(^|[/_.-])(payment\w*|billing|checkout|stripe|refund\w*)([/_.-]|$)/.test(path)) reasons.push("payments");
  if (/(^|\/)(migrations?|schema)(\/|\.)/.test(path) || /\b(ALTER TABLE|DROP TABLE|DROP COLUMN|deleteMany|TRUNCATE)\b/i.test(changed)) reasons.push("data / migrations");
  if (/(^|\/)(api|webhooks?)(\/|\.)/.test(path) || /\b(eval|exec|execSync|spawn|innerHTML|dangerouslySetInnerHTML)\b/.test(changed)) reasons.push("external input / execution");
  return reasons;
}

/**
 * A focused, numbered window; never silently label the snippet a complete file.
 *
 * Grown outward from the anchor rather than rendered whole and then cut. A
 * character-offset `.slice(0, maxChars)` removes only the TAIL, so every line
 * *after* the finding disappeared first — and that is exactly where the
 * counterevidence a verifier is asked to look for lives: an early return, a
 * validation branch, a catch block. On a risky file (radius 35, 4500 chars,
 * ~63 chars per numbered line) and on the risk-context window (radius 25,
 * 3000 chars, ~59 per line) ordinary TypeScript crosses that line routinely.
 * Growing symmetrically also guarantees every surviving line is whole, so
 * every line the model can see is one it can legally quote as evidence.
 */
export function codeWindow(content: string, line: number, radius: number, maxChars = 6000): string {
  const lines = content.split("\n");
  // Clamped rather than trusted: a line number past the end of the file (a
  // hallucinated one, or a file that changed between fetches) used to slice an
  // empty range and return "".
  const anchor = Math.min(Math.max(line - 1, 0), Math.max(lines.length - 1, 0));
  const lowest = Math.max(0, anchor - radius);
  const highest = Math.min(lines.length - 1, anchor + radius);
  const cost = (index: number) => `${index + 1}: ${lines[index]}\n`.length;

  let start = anchor;
  let end = anchor;
  let used = cost(anchor);
  for (let step = 1; step <= radius; step++) {
    const below = anchor - step;
    const above = anchor + step;
    if (below >= lowest && used + cost(below) <= maxChars) { start = below; used += cost(below); }
    if (above <= highest && used + cost(above) <= maxChars) { end = above; used += cost(above); }
  }
  return lines.slice(start, end + 1).map((text, index) => `${start + index + 1}: ${text}`).join("\n");
}
