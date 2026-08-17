import { Linter, type Linter as LinterTypes } from "eslint";
import tsParser from "@typescript-eslint/parser";
import type { FindingDoc } from "@/lib/db/collections";
import type { PullRequestFile } from "@/lib/github/diff";
import { getFileContent } from "@/lib/github/file-content";

/** Bounds how much a single review pays in extra GitHub/CPU calls for this stage. */
const MAX_FILES = 15;
const MAX_FINDINGS = 10;
const SUPPORTED_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];

/**
 * A small, curated, plugin-free rule set — target repos' own ESLint config
 * (and any plugins it depends on) isn't available here, only file content
 * fetched via the GitHub API. These are core rules chosen for being real
 * bug-risk signals rather than style preferences.
 */
const RULES: LinterTypes.RulesRecord = {
  eqeqeq: "warn",
  "no-var": "warn",
  "no-debugger": "error",
  "no-eval": "error",
  "no-implied-eval": "error",
  "no-throw-literal": "warn",
  "no-unreachable": "error",
  "no-constant-condition": "warn",
  "use-isnan": "error",
  "no-fallthrough": "warn",
  "no-empty-pattern": "warn",
  "no-self-compare": "warn",
};

const BUG_RISK_RULES = new Set([
  "no-debugger",
  "no-eval",
  "no-implied-eval",
  "no-unreachable",
  "use-isnan",
  "no-constant-condition",
  "no-self-compare",
  "no-fallthrough",
]);

const linter = new Linter();

function severityFor(ruleId: string, eslintSeverity: number): FindingDoc["severity"] {
  const isBugRisk = BUG_RISK_RULES.has(ruleId);
  if (eslintSeverity === 2) return isBugRisk ? "high" : "medium";
  return isBugRisk ? "medium" : "low";
}

function configFor(filename: string): LinterTypes.Config {
  const isTypeScript = filename.endsWith(".ts") || filename.endsWith(".tsx");
  return {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      ...(isTypeScript ? { parser: tsParser } : {}),
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: RULES,
  };
}

/**
 * Runs a bounded ESLint pass over the PR's changed supported-extension files
 * (fetched at `headSha`, not from the diff patch — the patch alone isn't
 * parseable source) and returns findings restricted to lines actually in the
 * diff, so this never flags pre-existing issues outside the PR's changes.
 * Every failure mode (fetch error, parse error) is swallowed per-file —
 * static analysis is a bonus signal, never a reason to fail the review.
 */
export async function runStaticAnalysis(
  installationId: number,
  owner: string,
  repo: string,
  headSha: string,
  files: PullRequestFile[],
  commentableLines: Map<string, Set<number>>,
): Promise<FindingDoc[]> {
  const candidates = files
    .filter((file) => file.status !== "removed")
    .filter((file) => SUPPORTED_EXTENSIONS.some((ext) => file.filename.endsWith(ext)))
    .slice(0, MAX_FILES);

  const findings: FindingDoc[] = [];

  for (const file of candidates) {
    if (findings.length >= MAX_FINDINGS) break;

    const lines = commentableLines.get(file.filename);
    if (!lines || lines.size === 0) continue;

    try {
      const content = await getFileContent(installationId, owner, repo, file.filename, headSha);
      if (!content) continue;

      const messages = linter.verify(content, configFor(file.filename), file.filename);

      for (const message of messages) {
        if (findings.length >= MAX_FINDINGS) break;
        if (!message.ruleId || !lines.has(message.line)) continue;

        findings.push({
          severity: severityFor(message.ruleId, message.severity),
          category: "quality",
          file: file.filename,
          line: message.line,
          title: `ESLint: ${message.ruleId}`,
          explanation: message.message,
          confidence: "high",
          source: "static-analysis",
        });
      }
    } catch {
      continue;
    }
  }

  return findings;
}
