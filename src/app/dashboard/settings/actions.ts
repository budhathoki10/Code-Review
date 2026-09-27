"use server";

import OpenAI from "openai";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { userSettings } from "@/lib/db/collections";
import { encryptSecret, keyFingerprint, secretsConfigured } from "@/lib/crypto/secret-box";
import { findModel, getCatalog, isSafeBaseUrl } from "@/lib/ai/catalog";
import { resetByoClients } from "@/lib/ai/provider";
import { checkRateLimit } from "@/lib/rate-limit";
import { getRedisConnection } from "@/lib/queue/connection";
import { logger } from "@/lib/logger";

/**
 * Saving and clearing a user's own AI provider settings.
 *
 * Returns `{ error }` or `{ success }` rather than throwing, unlike
 * `updateRepositoryConfig` which returns void: every failure here is one the
 * person needs to read and act on — a wrong key, a model that cannot call
 * functions, a provider that would not answer. Silence would leave them with
 * a form that looks saved and reviews that fail tomorrow.
 */

const PROBE_TIMEOUT_MS = 20_000;

/** A tool definition small enough to be free and specific enough to prove function calling works. */
const PROBE_TOOL: OpenAI.Chat.Completions.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "report_ready",
    description: "Report that you are ready to review code.",
    parameters: {
      type: "object",
      properties: { ready: { type: "boolean", description: "Always true." } },
      required: ["ready"],
      additionalProperties: false,
    },
  },
};

interface ProbeResult {
  ok: boolean;
  error?: string;
}

/**
 * One real call to the chosen provider, to find out now rather than later.
 *
 * It checks two things that cannot be checked any other way. That the key
 * works — otherwise the first sign of trouble is a failed review on someone
 * else's pull request. And that the model genuinely honours a forced tool
 * call on this provider, which catalogue metadata claims but cannot
 * guarantee: every stage of this pipeline reads its result out of a function
 * call, and a model that answers in prose produces no findings at all, which
 * reads to the author as "your code is clean".
 */
async function probeCredentials(baseUrl: string, apiKey: string, model: string): Promise<ProbeResult> {
  const client = new OpenAI({ apiKey, baseURL: baseUrl, maxRetries: 0, timeout: PROBE_TIMEOUT_MS });

  try {
    const response = await client.chat.completions.create({
      model,
      max_tokens: 64,
      temperature: 0,
      messages: [
        { role: "system", content: "You are verifying connectivity. Call report_ready with ready set to true." },
        { role: "user", content: "Confirm you are ready." },
      ],
      tools: [PROBE_TOOL],
      tool_choice: { type: "function", function: { name: "report_ready" } },
    }, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });

    const call = response.choices[0]?.message.tool_calls?.[0];
    if (call?.type !== "function" || call.function.name !== "report_ready") {
      return {
        ok: false,
        error: "This model did not return a function call. Code review needs a model that supports tool calling — pick another model.",
      };
    }
    return { ok: true };
  } catch (error) {
    // Each of these sends the reader somewhere different, so they are worth
    // telling apart. "Check the key" is actively misleading for a balance or
    // a quota problem, where the key is working exactly as it should.
    const status = (error as { status?: number } | undefined)?.status;
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ baseUrl, model, status, err: message }, "AI credential probe failed");

    switch (status) {
      case 401:
      case 403:
        return { ok: false, error: "The provider rejected this API key. Check that you copied it correctly and that it is still active." };
      case 402:
        return { ok: false, error: "This key works, but the account has no credit left. Top up with your provider, then try again." };
      case 404:
        return { ok: false, error: "The provider does not recognise this model. Pick another model." };
      case 429:
        return { ok: false, error: "The provider rate-limited the check. Wait a moment and try again." };
      case 400:
      case 422:
        // Often a model that will not accept a forced tool call, which this
        // pipeline needs on every single stage.
        return { ok: false, error: "The provider refused the request. This model may not support the forced tool calls code review needs — try another model." };
      default:
        return { ok: false, error: `The provider did not answer${status ? ` (HTTP ${status})` : ""}. Try again, or pick another model.` };
    }
  }
}

/**
 * How long to wait for the rate-limit check before giving up on it.
 *
 * The shared Redis connection is configured with `maxRetriesPerRequest: null`
 * because BullMQ's blocking connections require it. The side effect is that a
 * command issued while Redis is unreachable is queued and retried forever: it
 * never resolves and never rejects. An `await` on it therefore hangs for as
 * long as the process lives, and a try/catch around it can never fire.
 *
 * That is what a `try/catch` here originally assumed it was handling, and the
 * result was a settings form stuck on "Checking your key…" with no error,
 * forever, whenever Redis was down — which is a far worse outcome than the
 * unthrottled probe this check exists to prevent.
 */
const RATE_LIMIT_TIMEOUT_MS = 1_000;

/**
 * Whether this user is within their probe allowance.
 *
 * Fails open, deliberately and on a bound. This limiter protects against
 * someone hammering a third-party endpoint through the form; it is not an
 * authorization control, and the action behind it is already authenticated,
 * validated, and bounded by the probe's own timeout. Letting an unreachable
 * Redis block a signed-in user from configuring their own account trades a
 * small abuse risk for a total outage of the feature.
 */
async function withinRateLimit(userId: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      checkRateLimit(getRedisConnection(), `ai-settings:${userId}`, 10, 60),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          logger.warn({ userId }, "rate limit check timed out — allowing the AI settings probe through");
          resolve(true);
        }, RATE_LIMIT_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    // A missing REDIS_URL throws synchronously from getRedisConnection.
    logger.warn(
      { userId, err: error instanceof Error ? error.message : String(error) },
      "could not rate limit the AI settings probe",
    );
    return true;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function saveAiSettings(input: {
  providerId: string;
  model: string;
  apiKey: string;
}): Promise<{ error: string } | { success: true }> {
  const session = await auth();
  if (!session?.user?.id) return { error: "Sign in to change these settings." };
  const userId = session.user.id;

  // Encryption before validation: a deployment without a master key must not
  // accept a key it would then store in the clear.
  if (!secretsConfigured()) {
    return { error: "This deployment cannot store API keys yet. SECRETS_ENCRYPTION_KEY is not configured." };
  }

  const apiKey = input.apiKey?.trim();
  if (!apiKey) return { error: "Enter an API key." };
  if (apiKey.length > 500) return { error: "That does not look like an API key." };

  // The probe is an outbound request triggered by user input, so it is rate
  // limited per user — but never at the cost of the action itself.
  if (!(await withinRateLimit(userId))) {
    return { error: "Too many attempts. Wait a minute and try again." };
  }

  const { providers } = await getCatalog();
  const found = findModel(providers, input.providerId, input.model);
  if (!found) return { error: "That provider and model combination is not available. Reload and choose again." };

  const { provider, model } = found;
  // The base URL comes from the catalogue, never from the submission. A URL
  // posted by a browser would let anyone aim this server's outbound request
  // wherever they liked.
  if (!isSafeBaseUrl(provider.baseUrl)) return { error: "That provider's endpoint is not usable from this server." };

  const probe = await probeCredentials(provider.baseUrl, apiKey, model.id);
  if (!probe.ok) return { error: probe.error ?? "The provider could not be reached." };

  const collection = await userSettings();
  const now = new Date();
  await collection.updateOne(
    { userId },
    {
      $set: {
        userId,
        ai: {
          providerId: provider.id,
          baseUrl: provider.baseUrl,
          model: model.id,
          keyCiphertext: encryptSecret(apiKey),
          keyLast4: keyFingerprint(apiKey),
          contextLimit: model.contextLimit,
          maxOutput: model.maxOutput,
          costPerMTokIn: model.costPerMTokIn,
          costPerMTokOut: model.costPerMTokOut,
          verifiedAt: now,
        },
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );

  // A replaced key must not keep using the client built for the old one.
  resetByoClients();
  logger.info({ userId, providerId: provider.id, model: model.id }, "user saved their own AI provider settings");
  revalidatePath("/dashboard/settings");
  return { success: true };
}

/** Removes a user's own provider, putting their reviews back on the platform default. */
export async function clearAiSettings(): Promise<{ error: string } | { success: true }> {
  const session = await auth();
  if (!session?.user?.id) return { error: "Sign in to change these settings." };

  const collection = await userSettings();
  await collection.updateOne(
    { userId: session.user.id },
    { $unset: { ai: "" }, $set: { updatedAt: new Date() } },
  );

  resetByoClients();
  logger.info({ userId: session.user.id }, "user removed their own AI provider settings");
  revalidatePath("/dashboard/settings");
  return { success: true };
}
