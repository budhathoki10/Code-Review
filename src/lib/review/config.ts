import { parse as parseYaml } from "yaml";
import type { FindingDoc } from "@/lib/db/collections";
import { getFileContent, GitHubRateLimitError } from "@/lib/github/file-content";
import { logger } from "@/lib/logger";

export const CONFIG_PATH = ".prsentry.yaml";

/**
 * The categories a finding can carry, as a runtime value — the parser has to
 * validate user-supplied strings against them and name the valid ones back in
 * an error message, neither of which a type union can do.
 *
 * Built from a Record keyed by the union rather than written as a plain array
 * so the list is provably complete: adding a category to FindingDoc without
 * adding it here is a compile error. Completeness matters, not just validity —
 * the "you disabled everything" guard below counts against this list, so a
 * category missing from it would both be un-disableable and make that guard
 * fire one category early.
 */
const CATEGORY_KEYS = {
  security: true,
  bug: true,
  performance: true,
  quality: true,
  testing: true,
} satisfies Record<FindingDoc["category"], true>;

export const REVIEW_CATEGORIES = Object.keys(CATEGORY_KEYS) as FindingDoc["category"][];

export interface RepoReviewConfig {
  /** Glob patterns; a leading "!" excludes. Merged with the built-in noise list, never replacing it. */
  pathFilters: string[];
  /**
   * Categories this repo has switched off entirely. Severity answers "how bad
   * is it"; this answers "what kind of thing do I even want flagged" — a repo
   * that wants security findings and nothing else can't express that by
   * raising severityThreshold, which would drop critical bugs along with the
   * testing nits.
   *
   * Findings in these categories are dropped before the review is stored, so
   * they also can't fail the check run. A category that is off is off, not
   * merely hidden: a check failing on a finding the repo asked not to receive
   * would be the same surprise the setting exists to prevent.
   */
  disabledCategories: FindingDoc["category"][];
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
  disabledCategories: [],
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

/**
 * Reads the disabled-category list, dropping (and naming) any entry that
 * isn't a real category. One bad entry never invalidates the good ones: a
 * repo that misspells "testng" alongside a correct "performance" still gets
 * performance switched off, and is told about the typo.
 */
function readDisabledCategories(raw: Record<string, unknown>, errors: string[]): FindingDoc["category"][] {
  const value = raw.disabled_categories;
  if (value === undefined) return [];

  if (!Array.isArray(value)) {
    errors.push("`reviews.disabled_categories` must be a list of category names — ignoring it.");
    return [];
  }

  const valid = new Set<string>(REVIEW_CATEGORIES);
  const accepted = new Set<FindingDoc["category"]>();
  for (const entry of value) {
    if (typeof entry === "string" && valid.has(entry)) {
      accepted.add(entry as FindingDoc["category"]);
      continue;
    }
    errors.push(
      `\`reviews.disabled_categories\` contains \`${JSON.stringify(entry)}\`, which is not a category — ignoring that entry. Valid categories: ${REVIEW_CATEGORIES.join(", ")}.`,
    );
  }

  // Every category off would silently turn the reviewer into an expensive
  // no-op that still pays for the model call, which is never what someone
  // means — they mean "stop reviewing this repo", which is uninstalling.
  if (accepted.size === REVIEW_CATEGORIES.length) {
    errors.push(
      "`reviews.disabled_categories` disables every category, which would leave no findings at all — ignoring it. Remove the app from this repo instead if that's the intent.",
    );
    return [];
  }

  return [...accepted];
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
  const known = new Set(["path_filters", "max_files", "max_changed_lines", "disabled_categories"]);
  for (const key of Object.keys(reviewsSection)) {
    if (!known.has(key)) {
      errors.push(`\`reviews.${key}\` is not a recognized setting — ignoring it. Valid keys: ${[...known].join(", ")}.`);
    }
  }

  return {
    config: {
      pathFilters,
      disabledCategories: readDisabledCategories(reviewsSection, errors),
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
