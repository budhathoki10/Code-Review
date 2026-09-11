import type OpenAI from "openai";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { getClient } from "@/lib/ai/review";
import { addUsage, EMPTY_USAGE, usageFromResponse, type TokenUsage } from "@/lib/db/usage";
import { requestParams, type StageModel } from "@/lib/ai/models";
import { ReviewStageError, type ReviewStage } from "@/lib/review/stage-types";
import { parseToolArguments } from "@/lib/ai/tool-arguments";

/**
 * One structured call to a reviewer, with bounded retry, and a hard rule: a
 * failure is a failure.
 *
 * The rule matters more than the retry. Every stage here can fail in a way
 * that superficially resembles success — an empty tool call, a response
 * truncated mid-JSON, a schema that parses to zero findings — and the
 * tempting handling for each is to return an empty list and carry on. That
 * turns "the provider timed out" into "your code is clean", which is the
 * single most damaging thing this pipeline can say. Every one of those paths
 * throws ReviewStageError instead, and the caller decides whether the review
 * is degraded or dead. Nothing here ever invents a finding either.
 *
 * Retries cover the transient shapes only — 5xx, 429, timeouts, and malformed
 * output, which on this endpoint is usually truncation rather than a model
 * that cannot count braces. A 4xx is our own request and is not retried.
 */

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number } | undefined)?.status;
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  const name = error instanceof Error ? `${error.name} ${error.constructor.name}` : "";
  return /Connection|Timeout|Abort|ECONNRESET|socket/i.test(name);
}

export interface StageResult<T> {
  value: T;
  usage: TokenUsage;
  attempts: number;
}

export async function callStage<T>({
  stage,
  model,
  system,
  user,
  tool,
  schema,
  deadlineAt,
  maxAttempts = 3,
}: {
  stage: ReviewStage;
  model: StageModel;
  system: string;
  user: string;
  tool: OpenAI.Chat.Completions.ChatCompletionFunctionTool;
  schema: z.ZodType<T>;
  deadlineAt: number;
  maxAttempts?: number;
}): Promise<StageResult<T>> {
  let usage = EMPTY_USAGE;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new ReviewStageError(stage, `Deadline exceeded before attempt ${attempt}`, lastError);
    }

    const startedAt = Date.now();
    try {
      const response = await getClient().chat.completions.create(
        requestParams(model, [{ role: "system", content: system }, { role: "user", content: user }], tool),
        {
          maxRetries: 0,
          timeout: Math.min(remainingMs, model.timeoutMs),
          signal: AbortSignal.timeout(remainingMs),
        },
      );
      usage = addUsage(usage, usageFromResponse(response.usage));

      const choice = response.choices[0];
      // Truncation is not an empty result. Reasoning traces share this budget,
      // so "length" here usually means the answer never started.
      if (choice?.finish_reason === "length") throw new Error("Response truncated before the tool call completed");

      const call = choice?.message.tool_calls?.[0];
      if (call?.type !== "function" || call.function.name !== tool.function.name) {
        throw new Error(`Model did not call ${tool.function.name}`);
      }

      let parsed: unknown;
      try {
        parsed = parseToolArguments(call.function.arguments);
      } catch {
        throw new Error("Tool arguments were not valid JSON");
      }

      const value = schema.parse(parsed);
      logger.info(
        { stage, model: model.model, thinking: model.thinking, attempt, durationMs: Date.now() - startedAt, outputTokens: usage.outputTokens },
        "review stage completed",
      );
      return { value, usage, attempts: attempt };
    } catch (error) {
      lastError = error;
      const retryable = isRetryable(error) || error instanceof z.ZodError || error instanceof SyntaxError
        || (error instanceof Error && /truncated|not valid JSON|did not call/.test(error.message));
      logger.warn(
        { stage, model: model.model, attempt, retryable, durationMs: Date.now() - startedAt, err: error instanceof Error ? error.message : String(error) },
        "review stage attempt failed",
      );
      if (!retryable || attempt === maxAttempts) break;
      // Bounded exponential backoff, clamped so a retry never outlives the deadline.
      const backoff = Math.min(2 ** (attempt - 1) * 1500, 12_000);
      const room = deadlineAt - Date.now();
      if (room <= backoff) break;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  throw new ReviewStageError(
    stage,
    `${stage} failed after ${maxAttempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    lastError,
  );
}

/** Usage across several stage calls, so a review's true cost survives a partial failure. */
export function sumUsage(results: { usage: TokenUsage }[]): TokenUsage {
  return results.reduce((total, r) => addUsage(total, r.usage), EMPTY_USAGE);
}
