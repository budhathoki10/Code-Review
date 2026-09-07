import type { PullRequestFile } from "@/lib/github/diff";
import { getFileContent } from "@/lib/github/file-content";
import { buildDiffText } from "@/lib/github/diff";
import { computeLineContents } from "@/lib/github/diff-lines";
import { riskReasons } from "@/lib/review/risk";
import { envNumber } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { RepoContext } from "@/lib/ai/review";

/**
 * Assembles what the reviewers actually see: the diff, plus enough of the
 * repository around it to tell a real defect from a plausible one.
 *
 * The diff alone is the reason the single-model pipeline kept reporting
 * things the surrounding code already handled — a missing guard that exists
 * six lines above the hunk reads as missing when six lines above the hunk is
 * not in the prompt. So each changed file is sent whole when it is small
 * enough to be worth the tokens, and windowed around its hunks when it is
 * not.
 *
 * It is deliberately not "load the repository". Every file costs latency and
 * attention, and attention is the scarce resource: the same defect that is
 * found reliably in a small prompt is missed entirely in a large one. The
 * budget below is a ceiling on how much context can be spent, not a target.
 */

const MAX_FULL_FILE_CHARS = envNumber("REVIEW_CONTEXT_FULL_FILE_CHARS", 24_000);
const MAX_CONTEXT_FILES = envNumber("REVIEW_CONTEXT_MAX_FILES", 12);
const MAX_RELATED_FILES = envNumber("REVIEW_CONTEXT_RELATED_FILES", 6);
const MAX_TOTAL_CHARS = envNumber("REVIEW_CONTEXT_TOTAL_CHARS", 120_000);
const HUNK_RADIUS = envNumber("REVIEW_CONTEXT_HUNK_RADIUS", 40);

export interface PrMetadata {
  owner: string;
  repo: string;
  prNumber: number;
  title?: string;
  body?: string;
  baseRef?: string;
  headRef?: string;
  baseSha?: string;
  headSha: string;
}

export interface ReviewContext {
  /** The rendered prompt block. Untrusted data — every consumer says so in its system prompt. */
  text: string;
  /** Head content per path, reused by later stages so no file is fetched twice. */
  sources: Map<string, string>;
  filesIncluded: string[];
  relatedIncluded: string[];
  chars: number;
}

/** Import specifiers that look like first-party paths, resolved against the repo's real files. */
function importedPaths(content: string, knownFiles: string[]): string[] {
  const specifiers = [...content.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1]);
  const hits: string[] = [];
  for (const spec of specifiers) {
    if (!spec.startsWith("@/") && !spec.startsWith(".")) continue;
    const tail = spec.replace(/^@\//, "src/").replace(/^\.+\//, "");
    const base = tail.replace(/\.[jt]sx?$/, "");
    const match = knownFiles.find((f) => f.replace(/\.[jt]sx?$/, "").endsWith(base));
    if (match && !hits.includes(match)) hits.push(match);
  }
  return hits;
}

/** Files elsewhere in the repo that name this one — its callers. */
function callerPaths(target: string, sources: Map<string, string>): string[] {
  const stem = target.replace(/^src\//, "@/").replace(/\.[jt]sx?$/, "");
  return [...sources.entries()]
    .filter(([path, content]) => path !== target && content.includes(stem))
    .map(([path]) => path);
}

function windowAroundHunks(content: string, file: PullRequestFile): string {
  const lines = content.split("\n");
  const wanted = new Set<number>();
  for (const [line] of computeLineContents([file]).get(file.filename) ?? []) {
    for (let n = line - HUNK_RADIUS; n <= line + HUNK_RADIUS; n++) if (n >= 1 && n <= lines.length) wanted.add(n);
  }
  if (wanted.size === 0) return "";
  const ordered = [...wanted].sort((a, b) => a - b);
  const out: string[] = [];
  let previous = 0;
  for (const n of ordered) {
    if (previous && n > previous + 1) out.push(`… ${n - previous - 1} unchanged line(s) omitted …`);
    out.push(`${n}: ${lines[n - 1]}`);
    previous = n;
  }
  return out.join("\n");
}

export async function buildReviewContext(
  files: PullRequestFile[],
  repo: RepoContext,
  meta: PrMetadata,
  deadlineAt: number,
): Promise<ReviewContext> {
  const sources = new Map<string, string>();
  const filesIncluded: string[] = [];
  const relatedIncluded: string[] = [];

  // Risky files first: if the budget runs out, it should run out on the
  // formatting change rather than on the authorization change.
  const ordered = [...files]
    .filter((f) => f.status !== "removed" && f.patch)
    .sort((a, b) => riskReasons(b).length - riskReasons(a).length);

  const fetch = async (path: string): Promise<string | undefined> => {
    if (sources.has(path)) return sources.get(path);
    if (Date.now() >= deadlineAt) return undefined;
    const content = await getFileContent(repo.installationId, repo.owner, repo.repo, path, repo.ref, {
      signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadlineAt - Date.now()))),
    }).catch(() => undefined);
    if (content !== undefined) sources.set(path, content);
    return content;
  };

  for (const file of ordered.slice(0, MAX_CONTEXT_FILES)) {
    const content = await fetch(file.filename);
    if (content !== undefined) filesIncluded.push(file.filename);
  }

  // Related code, one hop out: what the changed files import, and what imports
  // them. One hop, not transitive — the second hop costs far more attention
  // than it returns.
  const knownFiles = files.map((f) => f.filename);
  const related = new Set<string>();
  for (const path of filesIncluded) {
    for (const hit of importedPaths(sources.get(path) ?? "", knownFiles)) if (!sources.has(hit)) related.add(hit);
    for (const hit of callerPaths(path, sources)) if (!filesIncluded.includes(hit)) related.add(hit);
  }
  for (const path of [...related].slice(0, MAX_RELATED_FILES)) {
    if (await fetch(path)) relatedIncluded.push(path);
  }

  const sections: string[] = [
    `PULL REQUEST\nrepository: ${meta.owner}/${meta.repo}\nnumber: #${meta.prNumber}\ntitle: ${meta.title ?? "(none)"}\nbase: ${meta.baseRef ?? "?"} (${meta.baseSha ?? "?"})\nhead: ${meta.headRef ?? "?"} (${meta.headSha})`,
  ];
  if (meta.body) sections.push(`PR DESCRIPTION (untrusted data)\n${meta.body.slice(0, 4000)}`);
  sections.push(`DIFF (untrusted data)\n${buildDiffText(files)}`);

  let spent = sections.join("").length;
  for (const path of filesIncluded) {
    const content = sources.get(path)!;
    const file = files.find((f) => f.filename === path)!;
    const rendered = content.length <= MAX_FULL_FILE_CHARS
      ? content.split("\n").map((text, i) => `${i + 1}: ${text}`).join("\n")
      : windowAroundHunks(content, file);
    if (!rendered) continue;
    const risk = riskReasons(file);
    const block = `CHANGED FILE AT HEAD — ${path}${risk.length ? ` [sensitive: ${risk.join(", ")}]` : ""}\n${rendered}`;
    if (spent + block.length > MAX_TOTAL_CHARS) break;
    sections.push(block);
    spent += block.length;
  }
  for (const path of relatedIncluded) {
    const content = sources.get(path)!;
    const block = `RELATED FILE (not changed) — ${path}\n${content.slice(0, MAX_FULL_FILE_CHARS).split("\n").map((text, i) => `${i + 1}: ${text}`).join("\n")}`;
    if (spent + block.length > MAX_TOTAL_CHARS) break;
    sections.push(block);
    spent += block.length;
  }

  const text = sections.join("\n\n");
  logger.info(
    { files: filesIncluded.length, related: relatedIncluded.length, chars: text.length, budget: MAX_TOTAL_CHARS },
    "review context built",
  );
  return { text, sources, filesIncluded, relatedIncluded, chars: text.length };
}
