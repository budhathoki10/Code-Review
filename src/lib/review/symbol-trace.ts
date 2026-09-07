import { envNumber } from "@/lib/env";
import type { CandidateFinding } from "@/lib/review/stage-types";

/**
 * Every place the symbols a finding names are actually used.
 *
 * This exists because of a specific, repeated failure: the reviewers do not
 * follow a symbol to its consumers. Two examples from one real review of this
 * repository, both wrong, both confidently stated:
 *
 *   - It claimed findings were "marked as confirmed after arbitration
 *     failure". The line it cited assigns `status: "uncertain"`, and forty
 *     lines below, `uncertain` is what routes a finding into the *unresolved*
 *     bucket. Same file. Fully in the prompt. It did not look down.
 *   - It claimed `callStage`'s `stage` argument drove progress persistence.
 *     `stage-call.ts` uses it for a log line and an error label, nothing else.
 *     One import away. It did not look across.
 *
 * The tempting fix is more context or a firmer prompt. Neither works, and the
 * first example is why: the answer was already in the window. Nothing was
 * missing. Asking a model to hold a forty-line dependency in attention while
 * it reasons about a hundred thousand characters of surrounding code is
 * asking for the thing it is worst at, and no amount of instruction converts
 * a limitation into a capability.
 *
 * So this does the tracing instead, deterministically, and hands over the
 * result. "Follow `settled` across this file" — which fails — becomes "read
 * these four lines" — which does not. The model is left doing the part it is
 * genuinely good at, judging code it can see all at once.
 *
 * Deliberately lexical rather than an AST pass. A real resolver would need a
 * TypeScript Program over the whole repository, and the reviewer holds a
 * partial checkout of files fetched on demand — the type-accurate answer is
 * not available at any price here. Over-reporting a same-named local costs a
 * line of prompt; missing the assignment that decides the finding costs the
 * finding. The trade is chosen in that direction on purpose.
 */

/** Symbols traced per finding. Past this, the dossier is longer than the code it explains. */
const MAX_SYMBOLS = envNumber("REVIEW_TRACE_MAX_SYMBOLS", 4);
/** References per symbol. A symbol used forty times is a utility, and listing it teaches nothing. */
const MAX_REFS_PER_SYMBOL = envNumber("REVIEW_TRACE_MAX_REFS", 12);
/** Total dossier size for one finding, in characters. */
const MAX_TRACE_CHARS = envNumber("REVIEW_TRACE_MAX_CHARS", 4_000);

/**
 * Words that are never worth tracing.
 *
 * Language keywords, the standard globals, and the handful of type names that
 * appear in every file. Tracing `const` returns every line in the repository
 * and displaces the one reference that mattered.
 */
const NOISE = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch",
  "case", "break", "continue", "new", "class", "extends", "implements", "interface", "type",
  "enum", "import", "export", "from", "as", "default", "async", "await", "yield", "try",
  "catch", "finally", "throw", "typeof", "instanceof", "in", "of", "void", "delete", "this",
  "super", "null", "undefined", "true", "false", "static", "readonly", "public", "private",
  "protected", "abstract", "declare", "namespace", "module", "satisfies", "keyof", "infer",
  "string", "number", "boolean", "object", "symbol", "bigint", "any", "unknown", "never",
  "Array", "Object", "String", "Number", "Boolean", "Promise", "Map", "Set", "Date", "JSON",
  "Math", "Error", "RegExp", "console", "process", "require", "length", "push", "map",
  "filter", "slice", "join", "split", "then", "log", "info", "warn", "error",
]);

/** An identifier, at least two characters, not starting with a digit. */
const IDENTIFIER = /\b[A-Za-z_$][A-Za-z0-9_$]{1,}\b/g;

export interface SymbolReference {
  file: string;
  line: number;
  text: string;
}

export interface SymbolTrace {
  symbol: string;
  references: SymbolReference[];
}

/**
 * The identifiers a finding is actually making a claim about.
 *
 * Taken from the lines it cites, not from its prose: the prose is the model's
 * own words and tracing those would follow its mistake rather than check it.
 * Ordered by how often they appear in the cited range, because a symbol
 * written three times in five lines is what those lines are about.
 */
export function symbolsInRange(source: string, startLine: number, endLine: number): string[] {
  const lines = source.split("\n");
  const from = Math.max(1, startLine);
  const to = Math.min(lines.length, Math.max(from, endLine));
  const cited = lines.slice(from - 1, to).join("\n");

  const counts = new Map<string, number>();
  for (const match of cited.matchAll(IDENTIFIER)) {
    const word = match[0];
    if (NOISE.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word]) => word)
    .slice(0, MAX_SYMBOLS);
}

/**
 * Whether a line is prose rather than code.
 *
 * Comments mention the symbols around them constantly, and this repository
 * comments heavily — tracing `stage` across two files spent five of its twelve
 * reference slots on sentences about staging and ran out before reaching the
 * two lines that actually used the value. The budget belongs to code.
 */
function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/** Whether `line` uses `symbol` as a whole word rather than as part of a longer name. */
function mentions(line: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(line);
}

/**
 * Every reference to one symbol across the sources we hold.
 *
 * The file the finding is in comes first: the miss this module was built for
 * was an assignment forty lines below the cited one, in the same file, and
 * that is the reference most likely to decide whether a finding is real.
 */
export function traceSymbol(symbol: string, sources: Map<string, string>, primaryFile: string): SymbolReference[] {
  const ordered = [primaryFile, ...[...sources.keys()].filter((path) => path !== primaryFile)];
  const refs: SymbolReference[] = [];

  for (const path of ordered) {
    const content = sources.get(path);
    if (content === undefined) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (isComment(lines[i]) || !mentions(lines[i], symbol)) continue;
      refs.push({ file: path, line: i + 1, text: lines[i].trim() });
      if (refs.length >= MAX_REFS_PER_SYMBOL) return refs;
    }
  }
  return refs;
}

/**
 * The traces for one finding.
 *
 * A symbol referenced only once — at the finding's own line — is dropped. It
 * tells the reader nothing they were not already looking at, and the point of
 * the dossier is what happens *elsewhere*.
 */
export function traceFinding(finding: CandidateFinding, sources: Map<string, string>): SymbolTrace[] {
  const source = sources.get(finding.file);
  if (!source) return [];

  const traces: SymbolTrace[] = [];
  for (const symbol of symbolsInRange(source, finding.startLine, finding.endLine)) {
    const references = traceSymbol(symbol, sources, finding.file);
    if (references.length < 2) continue;
    traces.push({ symbol, references });
  }
  return traces;
}

/**
 * The dossier as it appears in a prompt.
 *
 * Rendered as plain located lines rather than as a claim, because a reviewer
 * that is told a conclusion will agree with it. This says only "here is where
 * these symbols appear" and leaves the reading to the model — which is the
 * part it can do once the lines are in front of it.
 */
export function renderTraces(traces: SymbolTrace[]): string {
  if (traces.length === 0) return "";

  const blocks: string[] = [];
  let spent = 0;
  for (const trace of traces) {
    const lines = trace.references.map((r) => `  ${r.file}:${r.line}  ${r.text}`);
    const block = `SYMBOL \`${trace.symbol}\` — every reference we hold:\n${lines.join("\n")}`;
    if (spent + block.length > MAX_TRACE_CHARS) break;
    blocks.push(block);
    spent += block.length + 2;
  }
  return blocks.join("\n\n");
}

/**
 * The dossier block for a set of findings, ready to append to a stage prompt.
 *
 * Empty when nothing traced, so a caller can append it unconditionally
 * without emitting a heading over nothing.
 */
export function buildTraceBlock(findings: CandidateFinding[], sources: Map<string, string>): string {
  const sections: string[] = [];
  for (const finding of findings) {
    const rendered = renderTraces(traceFinding(finding, sources));
    if (!rendered) continue;
    sections.push(`--- traces for ${finding.id} (${finding.file}:${finding.startLine}-${finding.endLine})\n${rendered}`);
  }
  if (sections.length === 0) return "";

  return [
    "",
    "SYMBOL TRACES",
    "Every place the symbols in each finding's cited lines are used, extracted",
    "mechanically from the repository at this commit — not by a model, so this",
    "is fact rather than opinion. A claim about what happens to a value is only",
    "correct if these lines support it. Check them before confirming: several",
    "findings have been rejected for asserting an effect that the value's own",
    "consumers, listed here, plainly contradict.",
    "",
    sections.join("\n\n"),
  ].join("\n");
}

/**
 * Candidate repository paths for the first-party modules a file imports.
 *
 * Returned as candidates rather than resolved paths because resolution needs
 * the repository's file list, and the reviewer holds a partial checkout. The
 * caller attempts each and keeps what exists — a miss costs one failed fetch,
 * and the fetch helper already swallows those.
 *
 * Only first-party specifiers are followed. `node_modules` is not where the
 * reviewer's mistakes live, and pulling a dependency's source in would spend
 * the budget that the file across the import is competing for.
 */
export function importCandidates(source: string, fromPath: string): string[] {
  const specs = [...source.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1]);
  const out = new Set<string>();

  for (const spec of specs) {
    let base: string | undefined;
    if (spec.startsWith("@/")) {
      base = `src/${spec.slice(2)}`;
    } else if (spec.startsWith(".")) {
      const dir = fromPath.split("/").slice(0, -1);
      for (const part of spec.split("/")) {
        if (part === "." || part === "") continue;
        if (part === "..") dir.pop();
        else dir.push(part);
      }
      base = dir.join("/");
    }
    if (!base) continue;

    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(base)) out.add(base);
    else for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) out.add(base + ext);
  }
  return [...out];
}
