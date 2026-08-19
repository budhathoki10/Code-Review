import { createHighlighter, type Highlighter } from "shiki";

const SUPPORTED_LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "css",
  "html",
  "python",
  "go",
  "rust",
  "java",
  "ruby",
  "php",
  "yaml",
  "markdown",
  "bash",
  "sql",
  "c",
  "cpp",
  "csharp",
  "swift",
  "kotlin",
] as const;

const EXT_LANG: Record<string, (typeof SUPPORTED_LANGS)[number]> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "css",
  html: "html",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  php: "php",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  mdx: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
};

function languageFromFile(file: string): (typeof SUPPORTED_LANGS)[number] | null {
  const ext = file.split(".").pop()?.toLowerCase();
  return (ext ? EXT_LANG[ext] : undefined) ?? null;
}

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter() {
  highlighterPromise ??= createHighlighter({
    themes: ["github-light", "github-dark"],
    langs: [...SUPPORTED_LANGS],
  });
  return highlighterPromise;
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export type DiffLine = { kind: "add" | "del" | "ctx"; text: string; html: string };

/**
 * Splits a unified-diff snippet into per-line records with syntax-highlighted
 * HTML for the code (minus the +/-/space prefix). Highlighting is best-effort:
 * an unrecognized extension or a Shiki failure falls back to escaped plain
 * text rather than losing the diff.
 */
export async function highlightDiffLines(diff: string, file: string): Promise<DiffLine[]> {
  const rawLines = diff.replace(/\n$/, "").split("\n");
  const kinds = rawLines.map((line): DiffLine["kind"] => {
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "del";
    return "ctx";
  });
  const codeLines = rawLines.map((line) => (line[0] === "+" || line[0] === "-" || line[0] === " " ? line.slice(1) : line));

  const lang = languageFromFile(file);
  if (!lang) {
    return codeLines.map((text, i) => ({ kind: kinds[i], text, html: escapeHtml(text) || "&nbsp;" }));
  }

  try {
    const highlighter = await getHighlighter();
    const { tokens } = highlighter.codeToTokens(codeLines.join("\n"), {
      lang,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: "light",
    });
    return codeLines.map((text, i) => {
      const lineTokens = tokens[i] ?? [];
      const html = lineTokens.length
        ? lineTokens
            .map((t) => {
              // Shiki bakes the light-theme color into a plain `color` entry and adds a
              // `--shiki-dark` variable for the override; see globals.css for the CSS side.
              const style = Object.entries(t.htmlStyle ?? {})
                .map(([k, v]) => `${k}:${v}`)
                .join(";");
              return `<span class="shiki-token" style="${style}">${escapeHtml(t.content)}</span>`;
            })
            .join("")
        : "&nbsp;";
      return { kind: kinds[i], text, html };
    });
  } catch {
    return codeLines.map((text, i) => ({ kind: kinds[i], text, html: escapeHtml(text) || "&nbsp;" }));
  }
}
