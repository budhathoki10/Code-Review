import OpenAI from "openai";
import { envNumber } from "@/lib/env";
import { logger } from "@/lib/logger";

export const DEFAULT_OPENROUTER_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";

let nvidiaClient: OpenAI | undefined;
let openRouterClient: OpenAI | undefined;

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
  onProviderAttempt?: (provider: "nvidia" | "openrouter") => void;
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
