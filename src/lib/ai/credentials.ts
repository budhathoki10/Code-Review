import { ObjectId } from "mongodb";
import { installations, userSettings, type RepositoryDoc } from "@/lib/db/collections";
import { getUserIdForGithubAccount } from "@/lib/github/account";
import { decryptSecret, SecretBoxError } from "@/lib/crypto/secret-box";
import { DEFAULT_MODEL } from "@/lib/ai/models";
import { logger } from "@/lib/logger";
import { AiCredentialsError } from "@/lib/ai/credential-errors";

export { AiCredentialsError, ByoProviderError } from "@/lib/ai/credential-errors";

/**
 * Which provider, model and key one review runs on.
 *
 * Resolved once per review and threaded down, rather than read from the
 * environment at each call site. The environment can only describe a single
 * global model; this can describe a different one per user, which is the
 * whole point.
 */
export interface AiCredentials {
  /** Absent for the platform path, which keeps reading NVIDIA_BASE_URL as it always has. */
  baseUrl?: string;
  /** Absent for the platform path, which keeps reading NVIDIA_API_KEY. */
  apiKey?: string;
  model: string;
  /**
   * "byo" changes two behaviours: no failover to the operator's OpenRouter
   * account, and a provider failure is reported as the user's key failing.
   */
  source: "byo" | "platform";
  /** Set for "byo", so a rejected key can be disabled on the owner's record. */
  ownerUserId?: string;
  /** USD per million tokens, snapshotted from models.dev when the user chose the model. */
  costPerMTokIn?: number;
  costPerMTokOut?: number;
  /** The model's own output ceiling, so a stage budget cannot exceed what the model allows. */
  maxOutput?: number;
}

/** What every review falls back to: the operator's configured NVIDIA deployment. */
export function platformCredentials(): AiCredentials {
  return { model: process.env.NVIDIA_MODEL ?? DEFAULT_MODEL, source: "platform" };
}

/**
 * The AI credentials for a repository's owner, or the platform default.
 *
 * Takes the repository document the pipeline has already loaded rather than
 * an id, because that lookup happens anyway — see `loadRepositoryContext`.
 * The two hops left are installation -> GitHub account -> Auth.js user, which
 * no existing query covers.
 *
 * Every failure mode short of "the user's key is unusable" resolves to the
 * platform default. A repo whose owner never set anything, an installation
 * row that has gone missing, an Auth.js user that was deleted — none of those
 * are reasons to refuse to review a pull request.
 */
export async function resolveAiCredentials(
  repositoryDoc: Pick<RepositoryDoc, "installationId"> | undefined,
): Promise<AiCredentials> {
  const fallback = platformCredentials();
  if (!repositoryDoc?.installationId || !ObjectId.isValid(repositoryDoc.installationId)) return fallback;

  const installationDoc = await (await installations()).findOne({
    _id: new ObjectId(repositoryDoc.installationId) as unknown as string,
  });
  if (!installationDoc?.githubUserId) return fallback;

  const userId = await getUserIdForGithubAccount(installationDoc.githubUserId);
  if (!userId) return fallback;

  const settings = await (await userSettings()).findOne({ userId });
  const ai = settings?.ai;
  if (!ai) return fallback;

  if (ai.disabledAt) {
    throw new AiCredentialsError(
      `AI key for user ${userId} is disabled since ${ai.disabledAt.toISOString()}`,
      `Your ${ai.providerId} API key was rejected and has been disabled. Update it in dashboard settings to resume reviews.`,
    );
  }

  let apiKey: string;
  try {
    apiKey = decryptSecret(ai.keyCiphertext);
  } catch (error) {
    // A key that cannot be decrypted is a deployment problem (rotated or
    // missing SECRETS_ENCRYPTION_KEY), not a bad key. Say so plainly rather
    // than silently billing the operator for a review the user expected to
    // pay for themselves.
    logger.error(
      { userId, providerId: ai.providerId, err: error instanceof SecretBoxError ? error.message : String(error) },
      "stored AI key could not be decrypted",
    );
    throw new AiCredentialsError(
      `Could not decrypt stored AI key for user ${userId}`,
      "Your stored API key could not be read. Re-enter it in dashboard settings.",
    );
  }

  return {
    baseUrl: ai.baseUrl,
    apiKey,
    model: ai.model,
    source: "byo",
    ownerUserId: userId,
    costPerMTokIn: ai.costPerMTokIn,
    costPerMTokOut: ai.costPerMTokOut,
    maxOutput: ai.maxOutput,
  };
}

/**
 * Marks a user's key as rejected, so the next push fails immediately instead
 * of sending another doomed request to their provider.
 *
 * Only ever called for 401/403. A 429 or a 500 is the provider having a bad
 * minute and says nothing about whether the key is valid.
 */
export async function disableCredentials(userId: string, message: string): Promise<void> {
  const collection = await userSettings();
  await collection.updateOne(
    { userId },
    { $set: { "ai.disabledAt": new Date(), "ai.lastError": { message, at: new Date() }, updatedAt: new Date() } },
  );
  logger.warn({ userId }, "disabled user AI key after an authentication failure");
}
