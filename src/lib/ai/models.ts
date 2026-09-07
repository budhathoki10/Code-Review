import type OpenAI from "openai";
import { envNumber } from "@/lib/env";

/**
 * Which model plays which role, and whether it reasons.
 *
 * Both roles are configuration rather than constants because the two are not
 * interchangeable in practice and the right pairing is an empirical question,
 * not a design one. Measured on this endpoint: `ultra-550b` with reasoning
 * enabled returned `outputTokens: 0` and `APIConnectionTimeoutError` on every
 * attempt — 80 to 110 seconds of internal reasoning and the connection closed
 * before a single token came back, which leaves every downstream stage
 * verifying an empty list. `super-120b` with reasoning off completed the same
 * work in 1–8 seconds. Anything built on top of a Phase 1 that returns
 * nothing returns nothing, however many stages it has, so the pairing has to
 * be changeable without a deploy.
 *
 * Defaults follow the specified architecture: ultra reviews, super verifies.
 * Set REVIEW_PRIMARY_MODEL / REVIEW_PRIMARY_THINKING to move off it.
 */

export const PRIMARY_MODEL = process.env.REVIEW_PRIMARY_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b";
export const VERIFIER_MODEL = process.env.REVIEW_VERIFIER_MODEL ?? "nvidia/nemotron-3-super-120b-a12b";
/** Arbitration is the primary model acting as an independent adjudicator, per spec §20. */
export const ARBITER_MODEL = process.env.REVIEW_ARBITER_MODEL ?? PRIMARY_MODEL;

function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw !== "false" && raw !== "0";
}

export const PRIMARY_THINKING = flag("REVIEW_PRIMARY_THINKING", true);
export const VERIFIER_THINKING = flag("REVIEW_VERIFIER_THINKING", true);
export const ARBITER_THINKING = flag("REVIEW_ARBITER_THINKING", true);

/**
 * NIM/vLLM passthrough for reasoning.
 *
 * `enable_thinking` is the key this endpoint's chat template reads. The
 * existing single-model path uses `thinking`, which the same template also
 * accepts; both are sent so a stage behaves the same whichever the deployed
 * template happens to honour, and neither is part of the OpenAI schema, which
 * is why this is typed loosely at the call site.
 */
export function reasoningKwargs(enabled: boolean): Record<string, unknown> {
  return { chat_template_kwargs: { thinking: enabled, enable_thinking: enabled } };
}

export interface StageModel {
  model: string;
  thinking: boolean;
  /** Output ceiling. Reasoning traces are emitted into this same budget, so a stage that reasons needs materially more of it. */
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

function stage(model: string, thinking: boolean, prefix: string, defaultMaxTokens: number, defaultTemp: number): StageModel {
  return {
    model,
    thinking,
    maxTokens: envNumber(`${prefix}_MAX_TOKENS`, defaultMaxTokens),
    temperature: envNumber(`${prefix}_TEMPERATURE`, defaultTemp),
    timeoutMs: envNumber(`${prefix}_TIMEOUT_MS`, 300_000),
  };
}

/** Phase 1. Highest output budget: it produces the most text and reasons while doing it. */
export const primaryStage = (): StageModel => stage(PRIMARY_MODEL, PRIMARY_THINKING, "REVIEW_PRIMARY", 16_000, 0.2);
/** Phase 2. Verifies and independently searches, so it needs room for both. */
export const verifierStage = (): StageModel => stage(VERIFIER_MODEL, VERIFIER_THINKING, "REVIEW_VERIFIER", 12_000, 0.1);
/** Debate turns are narrow: one finding, one position, brief reasoning. */
export const debateStage = (model: string, thinking: boolean): StageModel => stage(model, thinking, "REVIEW_DEBATE", 6_000, 0.1);
/** Arbitration is decisive and short. Temperature 0: the same evidence should reach the same verdict. */
export const arbiterStage = (): StageModel => stage(ARBITER_MODEL, ARBITER_THINKING, "REVIEW_ARBITER", 8_000, 0);

/** Shared request shape, so no stage can silently diverge on the parameters that matter. */
export function requestParams(
  s: StageModel,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  tool: OpenAI.Chat.Completions.ChatCompletionFunctionTool,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  return {
    model: s.model,
    temperature: s.temperature,
    max_tokens: s.maxTokens,
    messages,
    tools: [tool],
    tool_choice: { type: "function", function: { name: tool.function.name } },
    ...reasoningKwargs(s.thinking),
  } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
}
