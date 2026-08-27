import { getInstallationOctokit } from "@/lib/github/app";
import { logger } from "@/lib/logger";

/**
 * Thrown when GitHub is still rate limiting after we waited out the reset
 * window and retried once. Distinct from every other failure because it
 * demands a different response: a missing file means "skip this file", but
 * a rate limit means the rest of this review would be silently incomplete,
 * so the review stops and retries later instead of posting a partial result
 * that reads like a full one.
 */
export class GitHubRateLimitError extends Error {
  readonly resetAt: Date | undefined;

  constructor(message: string, resetAt?: Date) {
    super(message);
    this.name = "GitHubRateLimitError";
    this.resetAt = resetAt;
  }
}

/**
 * The Contents API refuses to return content for files over 1 MB, answering
 * with `content: ""` and `"too_large"`. This spec makes that a routine case
 * rather than an edge one — the whole reason we fetch a file directly is
 * that its diff was too big for GitHub to render — so the Blobs API
 * fallback below is expected to fire often, not rarely.
 */
const TOO_LARGE = "too_large";

/**
 * Bounds the shared content cache. Keys are `installation:owner/repo:path@ref`
 * and refs are commit SHAs, so entries are immutable and become irrelevant
 * on their own once a PR moves on; this cap exists purely so a long-running
 * worker process cannot grow without bound across thousands of reviews.
 * Evicts oldest-first, which for this access pattern means "the review we
 * finished longest ago".
 */
const MAX_CACHE_ENTRIES = Number(process.env.FILE_CONTENT_CACHE_ENTRIES ?? 500);
const MAX_CACHE_BYTES = Number(process.env.FILE_CONTENT_CACHE_BYTES ?? 32 * 1024 * 1024);

/** `undefined` is cached too — a file that genuinely isn't readable shouldn't be re-fetched either. */
const cache = new Map<string, string | undefined>();
let cachedBytes = 0;

function cacheKey(installationId: number, owner: string, repo: string, path: string, ref: string): string {
  return `${installationId}:${owner}/${repo}:${path}@${ref}`;
}

function remember(key: string, value: string | undefined): string | undefined {
  // Subtract whatever this key already held before adding the new value.
  // Two concurrent callers can both miss the `cache.has` guard and both land
  // here for the same key — routine at worker concurrency 5 × chunk
  // concurrency × parallel fetch_file calls. Without this the map keeps one
  // entry while the byte counter counts it twice, so `cachedBytes` drifts
  // above the real footprint and starts evicting live entries early, forcing
  // exactly the re-fetches this cache exists to prevent.
  cachedBytes -= cache.get(key)?.length ?? 0;
  cache.set(key, value);
  cachedBytes += value?.length ?? 0;

  while (cache.size > MAX_CACHE_ENTRIES || cachedBytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cachedBytes -= cache.get(oldest.value)?.length ?? 0;
    cache.delete(oldest.value);
  }

  return value;
}

/** Exposed for tests and for a worker that wants to drop everything between runs. */
export function clearFileContentCache(): void {
  cache.clear();
  cachedBytes = 0;
}

interface HttpErrorish {
  status?: number;
  response?: { headers?: Record<string, string | undefined> };
}

function rateLimitResetAt(error: unknown): Date | undefined {
  const headers = (error as HttpErrorish)?.response?.headers;
  if (!headers) return undefined;
  if (headers["x-ratelimit-remaining"] !== "0") return undefined;

  const reset = Number(headers["x-ratelimit-reset"]);
  return Number.isFinite(reset) ? new Date(reset * 1000) : undefined;
}

/**
 * Detects the specific 403 that means "you are rate limited", as opposed to
 * the 403 that means "this app has no permission on this repo" — retrying
 * the latter would just burn the same wait again for a guaranteed failure.
 */
function isRateLimited(error: unknown): boolean {
  return (error as HttpErrorish)?.status === 403 && rateLimitResetAt(error) !== undefined;
}

/** Bounds how long a rate-limit wait may block a job, whatever GitHub's reset header claims. */
const MAX_RATE_LIMIT_WAIT_MS = Number(process.env.MAX_RATE_LIMIT_WAIT_MS ?? 60_000);

async function waitForReset(resetAt: Date | undefined): Promise<boolean> {
  const waitMs = resetAt ? resetAt.getTime() - Date.now() : 0;
  if (waitMs <= 0) return true;
  if (waitMs > MAX_RATE_LIMIT_WAIT_MS) {
    logger.warn({ resetAt, waitMs }, "rate-limit reset is further out than we're willing to wait");
    return false;
  }

  logger.warn({ resetAt, waitMs }, "rate limited by GitHub — waiting for reset before one retry");
  await new Promise((resolve) => setTimeout(resolve, waitMs + 1_000));
  return true;
}

/**
 * Runs a GitHub call, and on a rate-limit 403 waits out the reset window and
 * retries exactly once. Still limited after that is not recoverable within
 * this job, so it throws GitHubRateLimitError for the pipeline to turn into
 * "this review will retry" rather than a partial review.
 *
 * This matters more here than it would with a full repo clone: this design
 * deliberately makes many small targeted API calls instead of one big fetch,
 * which trades clone cost for rate-limit exposure.
 */
async function withRateLimitRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isRateLimited(error)) throw error;

    const resetAt = rateLimitResetAt(error);
    if (!(await waitForReset(resetAt))) {
      throw new GitHubRateLimitError("GitHub rate limit reset is too far away to wait for", resetAt);
    }

    try {
      return await operation();
    } catch (retryError) {
      if (isRateLimited(retryError)) {
        throw new GitHubRateLimitError("Still rate limited by GitHub after waiting for the reset", rateLimitResetAt(retryError));
      }
      throw retryError;
    }
  }
}

/**
 * Fetches a single file's content at a specific ref, memoized on
 * `path:ref` so no file is ever fetched twice within one review — the
 * `patch: null` fallback (see patch-fallback.ts), the AI's `fetch_file`
 * tool, and static analysis all route through here and routinely want the
 * same file.
 *
 * Returns `undefined` for anything that isn't a readable file blob (a
 * directory listing, a submodule, a symlink, a missing path) — callers treat
 * that as "skip", never as fatal. Rate limiting is the one failure that
 * throws, because it means the answer is "unknown", not "nothing there".
 */
export async function getFileContent(
  installationId: number,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | undefined> {
  const key = cacheKey(installationId, owner, repo, path, ref);
  if (cache.has(key)) return cache.get(key);

  try {
    const octokit = await getInstallationOctokit(installationId);

    const { data } = await withRateLimitRetry(() =>
      octokit.request("GET /repos/{owner}/{repo}/contents/{path}", { owner, repo, path, ref }),
    );

    if (Array.isArray(data) || data.type !== "file") {
      return remember(key, undefined);
    }

    // Over 1 MB: the Contents API returns the metadata with empty content
    // and this marker instead of the file. The Blobs API has no such limit.
    if (data.content === "" || ("encoding" in data && data.encoding === TOO_LARGE)) {
      if (!data.sha) return remember(key, undefined);
      logger.info({ path, ref, size: data.size }, "file too large for the Contents API — falling back to the Blobs API");
      return remember(key, await getBlobContent(installationId, owner, repo, data.sha));
    }

    if (!("content" in data)) return remember(key, undefined);
    return remember(key, Buffer.from(data.content, "base64").toString("utf-8"));
  } catch (error) {
    if (error instanceof GitHubRateLimitError) throw error;
    logger.debug({ path, ref, err: error }, "could not fetch file content");
    return remember(key, undefined);
  }
}

/**
 * The Blobs API by SHA — no size ceiling, which is why it's the fallback for
 * files the Contents API refuses. Returns `undefined` for a binary blob:
 * GitHub happily base64-encodes one, but handing binary bytes to a reviewer
 * model is worse than admitting we have no diff.
 */
export async function getBlobContent(
  installationId: number,
  owner: string,
  repo: string,
  fileSha: string,
): Promise<string | undefined> {
  try {
    const octokit = await getInstallationOctokit(installationId);
    const { data } = await withRateLimitRetry(() =>
      octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", { owner, repo, file_sha: fileSha }),
    );

    if (data.encoding !== "base64" || typeof data.content !== "string") return undefined;

    const decoded = Buffer.from(data.content, "base64").toString("utf-8");
    // A NUL byte in the first few KB is the cheap, reliable binary tell.
    if (decoded.slice(0, 8192).includes("\u0000")) return undefined;
    return decoded;
  } catch (error) {
    if (error instanceof GitHubRateLimitError) throw error;
    logger.debug({ fileSha, err: error }, "could not fetch blob content");
    return undefined;
  }
}
