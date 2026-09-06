import { Linter, type Linter as LinterTypes } from "eslint";
import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import globals from "globals";
import { lint as lintMarkdown } from "markdownlint/sync";
import stylelint from "stylelint";
import stylelintStandardConfig from "stylelint-config-standard";
import htmlhintPkg from "htmlhint";
import { createLinter as createActionLinter, type RunActionlint } from "actionlint";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import type { FindingDoc } from "@/lib/db/collections";
import type { PullRequestFile } from "@/lib/github/diff";
import { getFileContent } from "@/lib/github/file-content";

/** Bounds how much a single review pays in extra GitHub/CPU calls for this stage. */
const MAX_FILES = 15;
const MAX_FINDINGS = 10;

const JS_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const MARKDOWN_EXTENSIONS = [".md", ".mdx"];
const CSS_EXTENSIONS = [".css", ".scss", ".less"];
const HTML_EXTENSIONS = [".html", ".htm"];
const JSON_EXTENSIONS = [".json"];
const SQL_EXTENSIONS = [".sql"];
const PROTO_EXTENSIONS = [".proto"];
const WORKFLOW_FILE = /^\.github\/workflows\/.+\.ya?ml$/;

/**
 * Every tool below either runs in-process (pure JS or WASM) or is a
 * Node-invokable CLI launcher script shipped by its own npm package — no
 * external OS-level binary install, nothing added to the deploy image.
 * Each was individually verified working (not just "package exists on
 * npm") before being wired in; several plausible-looking npm package names
 * turned out to be unrelated squatted packages or non-functional shells,
 * and are deliberately NOT used here:
 *
 *   - `shellcheck` (npm) — critical Zip Slip vuln in its own postinstall
 *     dependency, and its "fixed" version's install script isn't even
 *     cross-platform.
 *   - `prisma-lint` — pulls in a high-severity lodash vuln (code injection
 *     / prototype pollution) via `chevrotain`, with no fix available.
 *   - `ruff` (bare name) — an unrelated "coroutine with ES6 generators"
 *     library, not Astral's Ruff. The real thing,
 *     `@astral-sh/ruff-wasm-nodejs`, is genuine and officially published —
 *     but it loads a `.wasm` file from disk at runtime the same way
 *     `content-tag` (below) does, and hits the identical Turbopack
 *     build-time tracing failure. Confirmed by actually building with it,
 *     not assumed from the ember-template-lint case alone.
 *   - `clippy`, `pmd`, `fortitude`, `regal` (bare names) — each an
 *     unrelated package that happens to share the tool's name (a CLI
 *     filter library, "print markdown to pdf", an "outpost server", and a
 *     TypeScript game framework, respectively). The real tools all need a
 *     full compiler/language toolchain (Rust, JVM, Rust again, Go/OPA)
 *     that isn't npm-installable.
 *   - `golangci-lint` (npm) — an empty shell package: no `bin`, no `main`,
 *     nothing to execute.
 *   - `swiftlint` (npm) — genuinely only runs on macOS
 *     (`postinstall.js` hard-exits on any other `process.platform`); this
 *     worker deploys to Linux (see render.yaml), so it would never run
 *     there either, not just here in dev.
 *   - `luacheck` (npm) — doesn't bundle the actual tool; it shells out to
 *     a system `luacheck` binary that isn't there without a separate
 *     Lua/LuaRocks install.
 *   - `clang-tidy` — technically runs, but fails on essentially any real
 *     C/C++ file (no standard-library headers/include paths configured,
 *     no compilation database) and its npm package is marked "no longer
 *     supported."
 *   - `react-doctor` — operates on a whole project directory (dead-code,
 *     circular-import, and dependency analysis need the full repo, not
 *     one fetched file) and by default calls out to a third-party API
 *     (Socket.dev) for supply-chain scanning — a data-sharing decision
 *     that shouldn't be made implicitly.
 *   - `ember-template-lint` — genuinely broke the production build. Its
 *     `content-tag` dependency loads a native `.wasm` file at runtime, and
 *     Next's bundler (Turbopack) fails to trace/resolve that path when
 *     collecting page data for any route that transitively imports this
 *     file — not a soft failure, a hard `next build` error blocking every
 *     deployment. Confirmed by actually running the build, not assumed.
 *   - Pylint, Flake8, RuboCop, PHPStan, PHPMD, PHPCS, PMD, Cppcheck,
 *     PSScriptAnalyzer, SQLFluff, TFLint — none have a working npm
 *     distribution at all; the real tools need Python, Ruby, JVM, or a
 *     compiler toolchain installed on the host.
 */

/**
 * Core rule set for every JS-family file: ESLint's own "recommended" config
 * (61 rules — real correctness bugs like no-const-assign, no-dupe-keys,
 * no-unsafe-optional-chaining, not style preferences) plus a handful of
 * extra bug-risk rules that recommended doesn't include because they read
 * as stylistic in origin but still catch real mistakes.
 */
const CORE_RULES: LinterTypes.RulesRecord = {
  ...(js.configs.recommended.rules as LinterTypes.RulesRecord),
  eqeqeq: "warn",
  "no-var": "warn",
  "no-throw-literal": "warn",
  "no-self-compare": "warn",
};

/**
 * TypeScript-only additions: typescript-eslint's own "recommended" set (23
 * rules), registered only for .ts/.tsx files. Deliberately the
 * non-type-checked variant — a type-aware pass needs the target repo's
 * tsconfig and a real compiled program, neither of which exists here, only
 * single-file content fetched over the GitHub API.
 */
const TS_RULES: LinterTypes.RulesRecord = {
  ...(tsPlugin.configs.recommended.rules as LinterTypes.RulesRecord),
};

/**
 * Rules whose violation is a likely runtime crash or a security-relevant
 * mistake, rather than a quality nit — bumped a severity tier up in
 * `severityForEslintRule`. Everything else still gets reported, just
 * ranked lower.
 */
const BUG_RISK_RULES = new Set([
  "no-debugger",
  "no-eval",
  "no-implied-eval",
  "no-unreachable",
  "use-isnan",
  "no-constant-condition",
  "no-self-compare",
  "no-fallthrough",
  "constructor-super",
  "no-this-before-super",
  "no-const-assign",
  "no-class-assign",
  "no-dupe-class-members",
  "no-dupe-keys",
  "no-dupe-args",
  "no-func-assign",
  "no-import-assign",
  "no-unsafe-finally",
  "no-unsafe-negation",
  "no-unsafe-optional-chaining",
  "getter-return",
  "setter-return",
  "for-direction",
  "no-async-promise-executor",
  "no-obj-calls",
  "@typescript-eslint/no-unsafe-declaration-merging",
  "@typescript-eslint/no-misused-new",
  "@typescript-eslint/no-this-alias",
  "@typescript-eslint/no-unsafe-function-type",
]);

/**
 * Regex-based secret detection. Not a substitute for a real scanner (e.g.
 * TruffleHog) — no entropy analysis, no verification against the live
 * credential — but catches the common, high-signal patterns cheaply, in
 * process, with no external binary. Reported at "medium" confidence since
 * pattern matches (unlike lint rules) can be examples/fixtures, not real
 * secrets. Runs on every supported file, not just JS.
 */
const SECRET_PATTERNS: { label: string; regex: RegExp }[] = [
  { label: "AWS Access Key ID", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Google API Key", regex: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  { label: "GitHub Token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/ },
  { label: "Slack Token", regex: /\bxox[baprs]-[0-9A-Za-z-]{10,72}\b/ },
  { label: "Stripe Secret Key", regex: /\bsk_live_[0-9a-zA-Z]{24,}\b/ },
  { label: "Private Key Block", regex: /-----BEGIN\s?(RSA|EC|DSA|OPENSSH|PGP)?\s?PRIVATE KEY-----/ },
  {
    label: "Hardcoded Secret",
    regex: /\b(api[_-]?key|secret|password|token)\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{16,}['"]/i,
  },
];

/**
 * HTMLHint's own default ruleset, minus two rules that would false-positive
 * on every partial/component HTML file (the common case in a diff — a
 * fragment, not a full document): `doctype-first` and `title-require` both
 * assume the file is a standalone page.
 */
const { HTMLHint } = htmlhintPkg;
const HTML_RULES = { ...HTMLHint.defaultRuleset, "doctype-first": false, "title-require": false };

const linter = new Linter();
let actionLinterPromise: Promise<RunActionlint> | undefined;

/**
 * Resolves a CLI tool's launcher script path from `node_modules`, deferred
 * to actual call time (never at module load) and using `process.cwd()`
 * rather than `createRequire(...).resolve(...)`. Both choices exist
 * because of a real, confirmed failure: Next's build-time page-data
 * collection evaluates this module inside Turbopack's tracing sandbox,
 * where `require.resolve` doesn't return a real filesystem path (it
 * returned a bundler-internal number here), and any top-level code that
 * depends on one breaks the production build outright — not a soft
 * failure, a hard `next build` error blocking every deployment (confirmed
 * by actually building, not assumed). `process.cwd()` is a plain runtime
 * value, not a module-resolution call, so it isn't subject to the same
 * tracing substitution — and Next.js always runs with cwd = project root,
 * in dev and in production alike. Same reasoning as the lazy pattern in
 * `src/lib/mongodb.ts`, for the same class of build-vs-runtime mismatch.
 */
function nodeModulesBin(relativePath: string): string {
  return path.join(process.cwd(), "node_modules", relativePath);
}

function severityForEslintRule(ruleId: string, eslintSeverity: number): FindingDoc["severity"] {
  const isBugRisk = BUG_RISK_RULES.has(ruleId);
  if (eslintSeverity === 2) return isBugRisk ? "high" : "medium";
  return isBugRisk ? "medium" : "low";
}

function eslintConfigFor(filename: string): LinterTypes.Config {
  const isTypeScript = filename.endsWith(".ts") || filename.endsWith(".tsx");
  return {
    // Required once a config carries a `plugins` key: Linter.verify's flat-
    // config matching silently no-ops (a fatal "no matching configuration"
    // pseudo-message, not a lint finding) for a plugin-bearing config with
    // no `files` glob. Harmless to always set — verify() is already called
    // once per exact filename.
    files: [filename],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      // Without declared globals, eslint:recommended's no-undef would flag
      // ordinary environment usage (console, process, fetch, window) as
      // undefined. TypeScript files skip no-undef entirely below — the
      // compiler already catches genuinely undefined identifiers, more
      // accurately than a JS-only heuristic can.
      globals: { ...globals.browser, ...globals.node, ...globals.es2021 },
      ...(isTypeScript ? { parser: tsParser } : {}),
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    ...(isTypeScript
      ? { plugins: { "@typescript-eslint": tsPlugin } as unknown as Pick<LinterTypes.Config, "plugins"> }
      : {}),
    rules: isTypeScript ? { ...CORE_RULES, "no-undef": "off", ...TS_RULES } : CORE_RULES,
  };
}

/** Extracts the first balanced JSON value (object or array) from mixed CLI output, string-content-safe. */
function extractFirstJsonValue<T>(text: string): T | undefined {
  let startIdx = -1;
  let openChar = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "[") {
      startIdx = i;
      openChar = text[i];
      break;
    }
  }
  if (startIdx === -1) return undefined;

  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(startIdx, i + 1)) as T;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

const MAX_CLI_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * Writes content to a real temp file (most CLI linters need a file path,
 * not stdin) and runs a Node-launcher CLI tool against it — via async
 * `spawn`, not `spawnSync`. This runs inside a long-lived BullMQ worker
 * that also has to keep responding to BullMQ's own stall-detection
 * heartbeat; `spawnSync` freezes the entire process (all timers, all other
 * async work) for as long as the subprocess takes, and two of these calls
 * back-to-back on a slow file can add up past BullMQ's stall window even
 * though each one individually finishes fine — the job then looks "dead"
 * to BullMQ and can get picked up by a second worker while the first is
 * still quietly finishing. `spawn` lets the event loop — and that
 * heartbeat — keep running while the subprocess works in the background.
 */
/** Removes the per-call temp dir, swallowing (but logging) any failure — a cleanup error must never leak past a caller expecting a settled promise, and must never mask the original result. */
function safeCleanup(dir: string, log: Logger): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn({ err, dir }, "failed to clean up linter temp directory");
  }
}

function runCliTool(binPath: string, args: string[], content: string, extension: string, log: Logger): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "review-lint-"));
  const tempFile = path.join(dir, `file${extension}`);

  return new Promise<string>((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;

    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      safeCleanup(dir, log);
      resolve(result);
    };

    try {
      writeFileSync(tempFile, content, "utf-8");
    } catch (err) {
      log.warn({ err, binPath }, "failed to write linter temp file");
      safeCleanup(dir, log);
      resolve("");
      return;
    }

    const finalArgs = args.map((a) => (a === "__FILE__" ? tempFile : a));
    const child = spawn(process.execPath, [binPath, ...finalArgs]);

    // Manual timeout — spawn() has no built-in equivalent to spawnSync's
    // `timeout` option. Same 10s ceiling as before: a safety net for a
    // hung/pathological run, not the expected duration.
    const timer = setTimeout(() => {
      child.kill();
      finish(stdout);
    }, 10_000);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CLI_OUTPUT_BYTES) {
        stdout += chunk.toString("utf-8");
      } else if (!truncated) {
        truncated = true;
        log.warn({ binPath }, "linter stdout exceeded the buffer cap, output truncated");
      }
    });
    // Captured for diagnostics only — never merged into stdout, since that
    // would risk corrupting the JSON extractFirstJsonValue expects to find.
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("close", (code, signal) => {
      // Most of these tools use 0 = clean, 1 = findings reported — both
      // normal, but only if stdout actually has content: since every call
      // here is `spawn(process.execPath, [binPath, ...])`, a binPath that
      // doesn't resolve is Node's own "Cannot find module" error, not the
      // linter's — and Node exits with code 1 for that too, indistinguishable
      // from "the linter ran and found something" by code alone. Requiring
      // non-empty stdout for the code-1 case catches that: a real
      // module-not-found produces no stdout at all, just a stack trace on
      // stderr.
      const looksLikeNormalFindingsExit = code === 1 && stdout.trim().length > 0;
      if (code !== 0 && !looksLikeNormalFindingsExit) {
        log.warn({ binPath, code, signal, stderr: stderr.slice(0, 2000) }, "linter exited non-cleanly");
      }
      finish(stdout);
    });
    child.on("error", (err) => {
      log.warn({ err, binPath }, "linter subprocess failed to spawn");
      finish("");
    });
  });
}

function scanForSecrets(content: string, filename: string, commentableLines: Set<number>): FindingDoc[] {
  const findings: FindingDoc[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    if (!commentableLines.has(lineNumber)) continue;

    const line = lines[i];
    const match = SECRET_PATTERNS.find((pattern) => pattern.regex.test(line));
    if (!match) continue;

    findings.push({
      severity: "critical",
      category: "security",
      file: filename,
      line: lineNumber,
      title: `Potential secret: ${match.label}`,
      explanation: `This line matches the pattern for a ${match.label}. If this is a real credential, revoke and rotate it, then load it from an environment variable instead of committing it.`,
      confidence: "medium",
      source: "static-analysis",
    });
  }

  return findings;
}

function scanJs(content: string, filename: string, commentableLines: Set<number>): FindingDoc[] {
  const messages = linter.verify(content, eslintConfigFor(filename), filename);
  const findings: FindingDoc[] = [];

  for (const message of messages) {
    if (!message.ruleId || !commentableLines.has(message.line)) continue;
    findings.push({
      severity: severityForEslintRule(message.ruleId, message.severity),
      category: "quality",
      file: filename,
      line: message.line,
      title: `ESLint: ${message.ruleId}`,
      explanation: message.message,
      confidence: "high",
      source: "static-analysis",
    });
  }

  return findings;
}

interface BiomeOutput {
  diagnostics: { severity: string; message: string; category: string; location: { start: { line: number } } }[];
}

async function scanBiome(content: string, filename: string, commentableLines: Set<number>, log: Logger): Promise<FindingDoc[]> {
  const ext = path.extname(filename);
  const output = await runCliTool(
    nodeModulesBin("@biomejs/biome/bin/biome"),
    ["lint", "--reporter=json", "__FILE__"],
    content,
    ext,
    log,
  );
  const parsed = extractFirstJsonValue<BiomeOutput>(output);
  if (!parsed) return [];

  const findings: FindingDoc[] = [];
  for (const diag of parsed.diagnostics ?? []) {
    const line = diag.location?.start?.line;
    if (line === undefined || !commentableLines.has(line)) continue;
    const group = biomeRuleGroup(diag.category);
    if (group && BIOME_OPINION_GROUPS.has(group)) continue;
    findings.push({
      severity: diag.severity === "error" ? "medium" : "low",
      category: "quality",
      file: filename,
      line,
      title: `Biome: ${diag.category}`,
      explanation: diag.message,
      confidence: "high",
      source: "static-analysis",
    });
  }
  return findings;
}

interface OxlintOutput {
  diagnostics: { message: string; code: string; severity: string; labels: { span: { line: number } }[] }[];
}

async function scanOxlint(content: string, filename: string, commentableLines: Set<number>, log: Logger): Promise<FindingDoc[]> {
  const ext = path.extname(filename);
  const output = await runCliTool(nodeModulesBin("oxlint/bin/oxlint"), ["--format=json", "__FILE__"], content, ext, log);
  const parsed = extractFirstJsonValue<OxlintOutput>(output);
  if (!parsed) return [];

  const findings: FindingDoc[] = [];
  for (const diag of parsed.diagnostics ?? []) {
    const line = diag.labels?.[0]?.span?.line;
    if (line === undefined || !commentableLines.has(line)) continue;
    findings.push({
      severity: diag.severity === "error" ? "medium" : "low",
      category: "quality",
      file: filename,
      line,
      title: `oxlint: ${diag.code}`,
      explanation: diag.message,
      confidence: "high",
      source: "static-analysis",
    });
  }
  return findings;
}

/**
 * markdownlint's own default rule set (all ~50 built-in rules — it doesn't
 * ship a separate curated "recommended" subset the way ESLint does).
 * Findings are documentation-quality issues, not code-correctness bugs, so
 * they're capped at "low" severity — they shouldn't outrank a real JS bug
 * or a secret.
 */
function scanMarkdown(content: string, filename: string, commentableLines: Set<number>): FindingDoc[] {
  const result = lintMarkdown({ strings: { [filename]: content } });
  const violations = result[filename] ?? [];

  const findings: FindingDoc[] = [];
  for (const violation of violations) {
    if (!commentableLines.has(violation.lineNumber)) continue;

    const [code, name] = violation.ruleNames;
    findings.push({
      severity: "low",
      category: "quality",
      file: filename,
      line: violation.lineNumber,
      title: `markdownlint: ${code} (${name})`,
      explanation: violation.errorDetail
        ? `${violation.ruleDescription} — ${violation.errorDetail}`
        : violation.ruleDescription,
      confidence: "high",
      source: "static-analysis",
    });
  }

  return findings;
}

/**
 * Stylelint's own `stylelint-config-standard` (41 rules — the project's
 * maintained baseline for CSS/SCSS/Less, same "use the vendor's curated
 * set" approach as the ESLint/typescript-eslint rules above).
 */
async function scanCss(content: string, filename: string, commentableLines: Set<number>): Promise<FindingDoc[]> {
  const result = await stylelint.lint({
    code: content,
    codeFilename: filename,
    config: { rules: stylelintStandardConfig.rules },
  });

  const findings: FindingDoc[] = [];
  for (const warning of result.results[0]?.warnings ?? []) {
    if (!commentableLines.has(warning.line)) continue;
    findings.push({
      severity: warning.severity === "error" ? "medium" : "low",
      category: "quality",
      file: filename,
      line: warning.line,
      title: `Stylelint: ${warning.rule}`,
      explanation: warning.text,
      confidence: "high",
      source: "static-analysis",
    });
  }

  return findings;
}

/** Biome also lints JSON — the only tool in this file that covers that file type. */
function scanJson(content: string, filename: string, commentableLines: Set<number>, log: Logger): Promise<FindingDoc[]> {
  return scanBiome(content, filename, commentableLines, log);
}

/**
 * HTMLHint's default ruleset (see HTML_RULES above for the two disabled
 * rules). `spec-char-escape`/`src-not-empty` here are the closest thing to
 * a security-relevant signal this tool has — everything else is
 * correctness (unpaired tags, duplicate IDs).
 */
function scanHtml(content: string, filename: string, commentableLines: Set<number>): FindingDoc[] {
  const messages = HTMLHint.verify(content, HTML_RULES);
  const findings: FindingDoc[] = [];

  for (const message of messages) {
    if (!commentableLines.has(message.line)) continue;
    findings.push({
      severity: message.type === "error" ? "medium" : "low",
      category: "quality",
      file: filename,
      line: message.line,
      title: `HTMLHint: ${message.rule.id}`,
      explanation: message.message,
      confidence: "high",
      source: "static-analysis",
    });
  }

  return findings;
}

/**
 * actionlint compiled to WASM, running in-process (no subprocess, no
 * binary path management) — catches GitHub Actions workflow mistakes
 * static YAML validation can't: undefined context/expression references,
 * invalid `needs`/`matrix` usage, malformed `run:` shell blocks. Scoped to
 * `.github/workflows/*.yml` by path, not just extension — a plain `.yml`
 * elsewhere isn't a workflow and would misparse under its schema.
 */
async function scanWorkflow(content: string, filename: string, commentableLines: Set<number>): Promise<FindingDoc[]> {
  actionLinterPromise ??= createActionLinter();
  const runActionlint = await actionLinterPromise;
  const results = runActionlint(content, filename);

  const findings: FindingDoc[] = [];
  for (const result of results) {
    if (!commentableLines.has(result.line)) continue;
    findings.push({
      severity: "medium",
      category: "quality",
      file: filename,
      line: result.line,
      title: `actionlint: ${result.kind}`,
      explanation: result.message,
      confidence: "high",
      source: "static-analysis",
    });
  }

  return findings;
}

interface SquawkFinding {
  line: number;
  level: string;
  message: string;
  rule_name: string;
}

/** Squawk — Postgres migration linter (lock timeouts, unsafe NOT NULL additions, missing IF NOT EXISTS, etc). */
async function scanSql(content: string, filename: string, commentableLines: Set<number>, log: Logger): Promise<FindingDoc[]> {
  const output = await runCliTool(
    nodeModulesBin("squawk-cli/js/bin/squawk"),
    ["--reporter", "json", "__FILE__"],
    content,
    ".sql",
    log,
  );
  const parsed = extractFirstJsonValue<SquawkFinding[]>(output);
  if (!parsed) return [];

  const findings: FindingDoc[] = [];
  for (const finding of parsed) {
    // Statement-level findings (not tied to one line) report line 0, which
    // never matches a real diff line — they're naturally filtered out here
    // rather than needing a special case.
    if (!commentableLines.has(finding.line)) continue;
    findings.push({
      severity: "medium",
      category: "quality",
      file: filename,
      line: finding.line,
      title: `squawk: ${finding.rule_name}`,
      explanation: finding.message,
      confidence: "high",
      source: "static-analysis",
    });
  }
  return findings;
}

interface BufFinding {
  start_line: number;
  type: string;
  message: string;
}

/**
 * Buf — Protobuf linter. Its default ruleset includes directory-structure
 * rules (e.g. a `package foo.bar` must live under a `foo/bar/` directory)
 * that assume the file sits in its real repo location; since this lints an
 * isolated fetched file, those specific rules may false-positive more than
 * they would in the actual repo tree. Left on rather than hand-picking a
 * subset — same "use the vendor's default" posture as everywhere else in
 * this file — but worth knowing if buf findings look off.
 */
async function scanProto(content: string, filename: string, commentableLines: Set<number>, log: Logger): Promise<FindingDoc[]> {
  const output = await runCliTool(
    nodeModulesBin("@bufbuild/buf/bin/buf"),
    ["lint", "__FILE__", "--error-format=json"],
    content,
    ".proto",
    log,
  );

  const findings: FindingDoc[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let parsed: BufFinding;
    try {
      parsed = JSON.parse(line) as BufFinding;
    } catch {
      continue;
    }
    if (!commentableLines.has(parsed.start_line)) continue;
    findings.push({
      severity: "low",
      category: "quality",
      file: filename,
      line: parsed.start_line,
      title: `buf: ${parsed.type}`,
      explanation: parsed.message,
      confidence: "high",
      source: "static-analysis",
    });
  }
  return findings;
}

function isSupportedFile(filename: string): boolean {
  return (
    JS_EXTENSIONS.some((ext) => filename.endsWith(ext)) ||
    MARKDOWN_EXTENSIONS.some((ext) => filename.endsWith(ext)) ||
    CSS_EXTENSIONS.some((ext) => filename.endsWith(ext)) ||
    HTML_EXTENSIONS.some((ext) => filename.endsWith(ext)) ||
    JSON_EXTENSIONS.some((ext) => filename.endsWith(ext)) ||
    SQL_EXTENSIONS.some((ext) => filename.endsWith(ext)) ||
    PROTO_EXTENSIONS.some((ext) => filename.endsWith(ext)) ||
    WORKFLOW_FILE.test(filename)
  );
}

/**
 * Rules the three JS linters share under different names, mapped to one key.
 *
 * Exact-name matching already collapses ESLint against oxlint (both call it
 * `no-useless-escape`), but Biome renames nearly everything, so its version
 * of a shared rule would survive deduplication and post a third comment
 * saying the same thing in different words. Only rules actually seen
 * duplicated are listed — a rule genuinely unique to one linter must keep
 * reporting.
 */
const EQUIVALENT_RULES: Record<string, string> = {
  nouselessescapeinregex: "no-useless-escape",
  nodoubleequals: "eqeqeq",
  novar: "no-var",
  nodebugger: "no-debugger",
  noexplicitany: "@typescript-eslint/no-explicit-any",
  nounusedvariables: "no-unused-vars",
  nounreachable: "no-unreachable",
};

/**
 * Biome rule groups that express a preference rather than a defect.
 *
 * There is no biome.json in a repo we review, so Biome runs its full default
 * set — including `style`, which is how PR #58 collected seven
 * "Forbidden non-null assertion." comments on a *test file* whose `!` usage
 * is deliberate, and which the repo's own ESLint config does not ban.
 * Enforcing one tool's house style on a codebase that never opted into it is
 * noise, and noise crowds real findings out of the MAX_FINDINGS budget.
 */
const BIOME_OPINION_GROUPS = new Set(["style", "nursery"]);

/** `lint/style/noNonNullAssertion` → `style`. */
function biomeRuleGroup(category: string): string | undefined {
  return category.split("/")[1];
}

/**
 * One comparable key per lint finding, so the same defect reported by two or
 * three linters posts once.
 *
 * Normalizes the three title formats — `ESLint: no-useless-escape`,
 * `oxlint: eslint(no-useless-escape)`, `Biome: lint/complexity/noUselessEscapeInRegex`
 * — down to a bare rule name, then folds known cross-tool synonyms together.
 */
export function canonicalRuleKey(title: string): string {
  const withoutTool = title.replace(/^(ESLint|oxlint|Biome):\s*/i, "");
  const bare = withoutTool
    // oxlint wraps the rule in its originating plugin: eslint(no-x) → no-x.
    .replace(/^[a-z@/-]+\((.+)\)$/i, "$1")
    // Biome namespaces it: lint/complexity/noUselessEscapeInRegex → noUselessEscapeInRegex.
    .replace(/^lint\/[^/]+\//, "")
    .trim();
  const folded = bare.toLowerCase();
  return EQUIVALENT_RULES[folded] ?? folded;
}

/**
 * Collapses findings that describe the same defect at the same place.
 *
 * Two distinct sources of duplication, both observed on PR #58: three linters
 * reporting one useless escape in three phrasings, and Biome reporting one
 * diagnostic per `!` operator — two identical comments anchored to the single
 * line that happened to contain two of them. Keying on
 * (line, canonical rule) collapses both. The first finding wins, so the
 * earlier-running linter's severity and wording are what survive.
 */
export function dedupeLintFindings(findings: FindingDoc[]): FindingDoc[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    // Keyed on file as well as line: scanFile only ever passes one file's
    // findings, but nothing about this function requires that.
    const key = `${finding.file}::${finding.line}::${canonicalRuleKey(finding.title)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function scanFile(content: string, filename: string, commentableLines: Set<number>, log: Logger): Promise<FindingDoc[]> {
  if (WORKFLOW_FILE.test(filename)) return scanWorkflow(content, filename, commentableLines);
  if (MARKDOWN_EXTENSIONS.some((ext) => filename.endsWith(ext))) return scanMarkdown(content, filename, commentableLines);
  if (CSS_EXTENSIONS.some((ext) => filename.endsWith(ext))) return scanCss(content, filename, commentableLines);
  if (HTML_EXTENSIONS.some((ext) => filename.endsWith(ext))) return scanHtml(content, filename, commentableLines);
  if (JSON_EXTENSIONS.some((ext) => filename.endsWith(ext))) return scanJson(content, filename, commentableLines, log);
  if (SQL_EXTENSIONS.some((ext) => filename.endsWith(ext))) return scanSql(content, filename, commentableLines, log);
  if (PROTO_EXTENSIONS.some((ext) => filename.endsWith(ext))) return scanProto(content, filename, commentableLines, log);
  if (JS_EXTENSIONS.some((ext) => filename.endsWith(ext))) {
    // Three JS/TS linters run on the same file, as explicitly requested —
    // real overlap exists (all three can flag the same == vs === issue),
    // but each also has rules the others don't (Biome's own rule set,
    // oxlint's, ESLint+typescript-eslint's), so no single one subsumes the
    // others. ESLint runs in-process (cheap, no need to parallelize);
    // Biome and oxlint each spawn a subprocess, so they run concurrently
    // via Promise.all rather than one after another — halving the
    // event-loop-blocked window for this file versus running them in
    // sequence.
    //
    // Overlap is the price of that coverage, so the merged list is
    // deduplicated (see dedupeLintFindings) rather than concatenated —
    // without it one useless escape posts three times.
    const eslintFindings = scanJs(content, filename, commentableLines);
    const [biomeFindings, oxlintFindings] = await Promise.all([
      scanBiome(content, filename, commentableLines, log),
      scanOxlint(content, filename, commentableLines, log),
    ]);
    return dedupeLintFindings([...eslintFindings, ...biomeFindings, ...oxlintFindings]);
  }
  return [];
}

/**
 * Runs a bounded static-analysis pass over the PR's changed supported files
 * (fetched at `headSha`, not from the diff patch — the patch alone isn't
 * parseable source): a regex-based secret scan on every file, then
 * language-appropriate linters — ESLint+Biome+oxlint for JS-family,
 * Biome for JSON, markdownlint for .md/.mdx, Stylelint for
 * .css/.scss/.less, HTMLHint for .html/.htm, actionlint for
 * .github/workflows/*.yml,
 * Squawk for .sql, Buf for .proto. Findings are restricted to lines
 * actually in the diff, so this never flags pre-existing issues outside
 * the PR's changes. Every failure mode (fetch error, parse error, a
 * missing/misbehaving external binary) is swallowed per-file — static
 * analysis is a bonus signal, never a reason to fail the review.
 */
export async function runStaticAnalysis(
  installationId: number,
  owner: string,
  repo: string,
  headSha: string,
  files: PullRequestFile[],
  commentableLines: Map<string, Set<number>>,
  log: Logger,
  deadlineAt = Date.now() + 120_000,
): Promise<FindingDoc[]> {
  const candidates = files
    .filter((file) => file.status !== "removed")
    .filter((file) => isSupportedFile(file.filename))
    .slice(0, MAX_FILES);

  const findings: FindingDoc[] = [];

  for (const file of candidates) {
    if (Date.now() >= deadlineAt) { log.warn("static analysis deadline reached; remaining files skipped"); break; }
    if (findings.length >= MAX_FINDINGS) break;

    const lines = commentableLines.get(file.filename);
    if (!lines || lines.size === 0) continue;

    try {
      const content = await getFileContent(installationId, owner, repo, file.filename, headSha, { signal: AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())) });
      if (!content) continue;

      // Secrets first: a hardcoded credential outranks a lint nit, so it
      // shouldn't get crowded out of the MAX_FINDINGS budget by one.
      for (const finding of scanForSecrets(content, file.filename, lines)) {
        if (findings.length >= MAX_FINDINGS) break;
        findings.push(finding);
      }
      if (findings.length >= MAX_FINDINGS) break;

      for (const finding of await scanFile(content, file.filename, lines, log)) {
        if (findings.length >= MAX_FINDINGS) break;
        findings.push(finding);
      }
    } catch {
      continue;
    }
  }

  return findings;
}
