import { parse as parseYaml } from "yaml";
import { getFileContent, GitHubRateLimitError } from "@/lib/github/file-content";
import { logger } from "@/lib/logger";

export const CONFIG_PATH = ".prsentry.yaml";

export interface RepoReviewConfig {
  /** Glob patterns; a leading "!" excludes. Merged with the built-in noise list, never replacing it. */
  pathFilters: string[];
  /**
   * Optional per-repo cutoffs, STRICTER than the pipeline's own capacity
   * ceiling (see REVIEW_CAPACITY). Undefined — the normal case — means the
   * repo has expressed no opinion and the capacity ceiling alone decides.
   *
   * These are deliberately not defaulted to a number. A default here is what
   * caused the bug this replaced: an arbitrary 8,000-line cutoff became the
   * *primary* gate and refused exactly the large, all-real-code PRs the
   * pipeline was perfectly capable of reviewing.
   */
  maxFiles?: number;
  maxChangedLines?: number;
}

export const DEFAULT_CONFIG: RepoReviewConfig = {
  pathFilters: [],
};

export interface ConfigLoadResult {
  config: RepoReviewConfig;
  /**
   * Human-readable problems with the file, naming the offending key. Non-empty
   * means the file was present but partly unusable — the review still runs on
   * defaults for the bad keys, and the caller surfaces these to the author.
   * A broken config must never fail a review: the author would get silence
   * and no way to tell why.
   */
  errors: string[];
  /** False when the repo simply has no config file, which is the normal case. */
  found: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates one positive integer field, collecting a message that names the
 * key rather than throwing — "max_files must be a positive number, got
 * 'lots'" tells the author exactly what to edit.
 */
function readPositiveInt(raw: Record<string, unknown>, key: string, errors: string[]): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    errors.push(
      `\`reviews.${key}\` must be a positive number (got \`${JSON.stringify(value)}\`) — ignoring it and using the pipeline's own capacity ceiling instead.`,
    );
    return undefined;
  }
  return Math.floor(value);
}

/** Parses already-fetched YAML text. Split out from the fetch so it can be tested without any network. */
export function parseRepoConfig(text: string): ConfigLoadResult {
  const errors: string[] = [];

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return {
      config: DEFAULT_CONFIG,
      errors: [`\`${CONFIG_PATH}\` is not valid YAML: ${error instanceof Error ? error.message : "parse error"}. Using defaults.`],
      found: true,
    };
  }

  if (raw === null || raw === undefined) return { config: DEFAULT_CONFIG, errors, found: true };

  if (!isPlainObject(raw)) {
    return { config: DEFAULT_CONFIG, errors: [`\`${CONFIG_PATH}\` must be a YAML mapping. Using defaults.`], found: true };
  }

  if (raw.version !== undefined && raw.version !== 1) {
    errors.push(`\`version\` must be \`1\` (got \`${JSON.stringify(raw.version)}\`) — reading the rest of the file as version 1 anyway.`);
  }

  const reviewsSection = raw.reviews;
  if (reviewsSection === undefined) return { config: DEFAULT_CONFIG, errors, found: true };
  if (!isPlainObject(reviewsSection)) {
    errors.push("`reviews` must be a mapping. Using defaults.");
    return { config: DEFAULT_CONFIG, errors, found: true };
  }

  let pathFilters: string[] = [];
  const rawFilters = reviewsSection.path_filters;
  if (rawFilters !== undefined) {
    if (!Array.isArray(rawFilters) || rawFilters.some((entry) => typeof entry !== "string")) {
      errors.push("`reviews.path_filters` must be a list of glob strings — ignoring it.");
    } else {
      pathFilters = rawFilters as string[];
    }
  }

  // Unknown keys are reported but never fatal: a typo shouldn't silently do
  // nothing, and shouldn't stop the review either.
  const known = new Set(["path_filters", "max_files", "max_changed_lines"]);
  for (const key of Object.keys(reviewsSection)) {
    if (!known.has(key)) {
      errors.push(`\`reviews.${key}\` is not a recognized setting — ignoring it. Valid keys: ${[...known].join(", ")}.`);
    }
  }

  return {
    config: {
      pathFilters,
      maxFiles: readPositiveInt(reviewsSection, "max_files", errors),
      maxChangedLines: readPositiveInt(reviewsSection, "max_changed_lines", errors),
    },
    errors,
    found: true,
  };
}

/**
 * Reads `.prsentry.yaml` from the head commit. Absent is the normal case and
 * costs one cached content fetch; rate limiting propagates, because a config
 * we failed to read could have raised the limits this review is about to
 * enforce, and silently applying stricter defaults would bail out a PR the
 * repo had explicitly allowed.
 */
export async function loadRepoConfig(
  installationId: number,
  owner: string,
  repo: string,
  ref: string,
): Promise<ConfigLoadResult> {
  let text: string | undefined;
  try {
    text = await getFileContent(installationId, owner, repo, CONFIG_PATH, ref);
  } catch (error) {
    if (error instanceof GitHubRateLimitError) throw error;
    logger.debug({ err: error }, "could not read repo config");
    return { config: DEFAULT_CONFIG, errors: [], found: false };
  }

  if (text === undefined) return { config: DEFAULT_CONFIG, errors: [], found: false };
  return parseRepoConfig(text);
}

/** Renders config problems as a Markdown block for the PR comment. Empty string when there are none. */
export function formatConfigErrors(errors: string[]): string {
  if (errors.length === 0) return "";
  return `\n\n---\n\n**Problems in \`${CONFIG_PATH}\`:**\n\n${errors.map((e) => `- ${e}`).join("\n")}`;
}
