import OpenAI from "openai";
import { createHash } from "node:crypto";
import { envNumber } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { AiCredentials } from "@/lib/ai/credentials";
import { ByoProviderError } from "@/lib/ai/credential-errors";

// Re-exported so callers that catch provider failures keep a single import.
export { ByoProviderError } from "@/lib/ai/credential-errors";

export const DEFAULT_OPENROUTER_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";

let nvidiaClient: OpenAI | undefined;
let openRouterClient: OpenAI | undefined;

/**
 * Clients for user-supplied endpoints, keyed by a hash of base URL and key.
 *
 * The platform clients can be singletons because there is exactly one of each.
 * User-supplied ones cannot: one instance serves many users, each with their
 * own endpoint, and building a fresh OpenAI client per call throws away the
 * connection pool. Bounded because the cache is keyed by user input, and an
 * unbounded map keyed by user input is a slow memory leak.
 */
const BYO_CLIENT_CACHE_LIMIT = 50;
const byoClients = new Map<string, OpenAI>();

/**
 * A cache key that cannot leak the key it is derived from.
 *
 * Map keys end up in heap dumps and, sooner or later, in a log line someone
 * added while debugging. A hash is just as unique and reveals nothing.
 */
function credentialCacheKey(baseUrl: string, apiKey: string): string {
  return createHash("sha256").update(`${baseUrl}\u0000${apiKey}`).digest("hex");
}

/** A client for one user's own provider. Cached per (base URL, key) pair. */
export function getByoClient(credentials: AiCredentials): OpenAI {
  const { baseUrl, apiKey } = credentials;
  if (!baseUrl || !apiKey) throw new Error("Bring-your-own credentials are missing a base URL or API key");

  const cacheKey = credentialCacheKey(baseUrl, apiKey);
  const cached = byoClients.get(cacheKey);
  if (cached) return cached;

  // Oldest-first eviction. Map preserves insertion order, so the first key is
  // the least recently created — enough for a cache whose only job is to stop
  // unbounded growth.
  if (byoClients.size >= BYO_CLIENT_CACHE_LIMIT) {
    const oldest = byoClients.keys().next();
    if (!oldest.done) byoClients.delete(oldest.value);
  }

  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl,
    maxRetries: 0,
    timeout: envNumber("BYO_REQUEST_TIMEOUT_MS", 120_000),
  });
  byoClients.set(cacheKey, client);
  return client;
}

/** Test seam: drops cached user clients so a suite can rebuild them. */
export function resetByoClients(): void {
  byoClients.clear();
}

export function getClient(): OpenAI {
  if (!nvidiaClient) {
    const apiKey = process.env.NVIDIA_API_KEY;
    const baseURL = process.env.NVIDIA_BASE_URL;
    if (!apiKey || !baseURL) {
      throw new Error("Missing NVIDIA_API_KEY or NVIDIA_BASE_URL");
    }
    nvidiaClient = new OpenAI({
      apiKey,
      baseURL,
      maxRetries: envNumber("NVIDIA_MAX_RETRIES", 2),
      timeout: envNumber("NVIDIA_REQUEST_TIMEOUT_MS", 120_000),
    });
  }
  return nvidiaClient;
}

function getOpenRouterClient(): OpenAI | undefined {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return undefined;

  if (!openRouterClient) {
    const referer = process.env.OPENROUTER_HTTP_REFERER?.trim();
    const title = process.env.OPENROUTER_APP_NAME?.trim();
    openRouterClient = new OpenAI({
      apiKey,
      baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
      maxRetries: 0,
      timeout: envNumber("OPENROUTER_REQUEST_TIMEOUT_MS", 120_000),
      defaultHeaders: {
        ...(referer ? { "HTTP-Referer": referer } : {}),
        ...(title ? { "X-OpenRouter-Title": title } : {}),
      },
    });
  }
  return openRouterClient;
}

/**
 * Errors that mean NVIDIA did not serve the request, rather than that the
 * request or model output was invalid. These are safe to retry through an
 * independent provider with the same messages and tool contract.
 */
export function isNvidiaProviderFailure(error: unknown): boolean {
  const status = (error as { status?: number } | undefined)?.status;
  if (status !== undefined) {
    return status === 401 || status === 403 || status === 404
      || status === 408 || status === 409 || status === 425 || status === 429
      || status >= 500;
  }

  const name = error instanceof Error ? `${error.name} ${error.constructor.name}` : "";
  const message = error instanceof Error ? error.message : String(error);
  return /Connection|Timeout|Abort|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket|fetch failed/i.test(`${name} ${message}`);
}

type NvidiaReasoningParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
  chat_template_kwargs?: { thinking?: boolean; enable_thinking?: boolean };
};

type OpenRouterParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
  reasoning?: { enabled: boolean };
};

function openRouterParams(params: NvidiaReasoningParams): OpenRouterParams {
  const { chat_template_kwargs: chatTemplate, ...portable } = params;
  const thinking = chatTemplate?.enable_thinking ?? chatTemplate?.thinking;

  return {
    ...portable,
    model: process.env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL,
    ...(thinking === undefined ? {} : { reasoning: { enabled: thinking } }),
  };
}

export interface ProviderCallContext {
  /** Used only to keep a fallback request inside the caller's review budget. */
  deadlineAt?: number;
  operation?: string;
  onProviderAttempt?: (provider: "nvidia" | "openrouter" | "byo") => void;
  /**
   * Whose provider to call. Absent means the platform's own NVIDIA
   * deployment, which is what every call did before per-user models existed.
   */
  credentials?: AiCredentials;
}

function openRouterOptions(
  options: OpenAI.RequestOptions | undefined,
  deadlineAt: number | undefined,
): OpenAI.RequestOptions | undefined {
  const configured = envNumber("OPENROUTER_REQUEST_TIMEOUT_MS", 120_000);
  const remaining = deadlineAt === undefined ? undefined : deadlineAt - Date.now();
  const timeout = Math.max(1, Math.min(configured, options?.timeout ?? configured, remaining ?? configured));

  return {
    ...options,
    maxRetries: 0,
    timeout,
    // The NVIDIA timeout signal may already be aborted. A fresh signal gives
    // OpenRouter the remaining bounded window instead of failing instantly.
    signal: AbortSignal.timeout(timeout),
  };
}

/**
 * Sends a completion to NVIDIA first and immediately fails over the exact
 * request to OpenRouter when NVIDIA is unavailable. Invalid requests and
 * malformed model output are intentionally not hidden by provider failover.
 */
export async function createChatCompletion(
  params: NvidiaReasoningParams,
  options?: OpenAI.RequestOptions,
  context: ProviderCallContext = {},
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const credentials = context.credentials;

  // A user's own provider gets the request as-is and gets no failover. The
  // operator's OpenRouter account is not a safety net for someone else's
  // billing problem: quietly absorbing it would mean paying for their reviews
  // indefinitely while they see nothing wrong.
  if (credentials?.source === "byo") {
    context.onProviderAttempt?.("byo");
    try {
      return await getByoClient(credentials).chat.completions.create(
        { ...params, model: credentials.model },
        { ...options, maxRetries: 0 },
      );
    } catch (error) {
      const status = (error as { status?: number } | undefined)?.status;
      const authFailure = status === 401 || status === 403;
      logger.warn(
        { operation: context.operation, status, model: credentials.model, ownerUserId: credentials.ownerUserId },
        authFailure ? "user AI key was rejected" : "user AI provider failed",
      );
      throw new ByoProviderError(
        authFailure
          ? "Your API key was rejected by the provider."
          : `Your AI provider did not complete the request${status ? ` (HTTP ${status})` : ""}.`,
        credentials.ownerUserId,
        status,
        authFailure,
        { cause: error },
      );
    }
  }

  context.onProviderAttempt?.("nvidia");
  try {
    return await getClient().chat.completions.create(params, { ...options, maxRetries: 0 });
  } catch (error) {
    if (!isNvidiaProviderFailure(error)) throw error;

    const fallback = getOpenRouterClient();
    const fallbackModel = process.env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL;
    const remaining = context.deadlineAt === undefined ? undefined : context.deadlineAt - Date.now();
    if (!fallback || (remaining !== undefined && remaining <= 0)) {
      if (!fallback) {
        logger.error(
          { operation: context.operation, status: (error as { status?: number })?.status },
          "NVIDIA failed and OpenRouter fallback is not configured",
        );
      }
      throw error;
    }

    logger.warn(
      {
        operation: context.operation,
        status: (error as { status?: number })?.status,
        nvidiaModel: params.model,
        openRouterModel: fallbackModel,
      },
      "NVIDIA request failed; falling back to OpenRouter",
    );

    context.onProviderAttempt?.("openrouter");
    return fallback.chat.completions.create(
      openRouterParams(params),
      openRouterOptions(options, context.deadlineAt),
    );
  }
}
