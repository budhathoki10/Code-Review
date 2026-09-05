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

/** A focused, numbered window; never silently label the snippet a complete file. */
export function codeWindow(content: string, line: number, radius: number, maxChars = 6000): string {
  const lines = content.split("\n");
  const start = Math.max(0, line - 1 - radius);
  return lines.slice(start, line + radius).map((text, index) => `${start + index + 1}: ${text}`)
    .join("\n").slice(0, maxChars);
}
