/**
 * The two ways a configured AI credential can fail, as error types with no
 * dependencies of their own.
 *
 * Deliberately not in `provider.ts` or `credentials.ts`, for the same reason
 * `review/severity.ts` keeps its constants out of `db/collections`: tests mock
 * those modules wholesale, and a class behind a `vi.mock` factory that does
 * not list it is `undefined` at runtime — so `error instanceof ByoProviderError`
 * throws a TypeError instead of narrowing. A leaf module nobody needs to mock
 * cannot disappear that way.
 *
 * Keeping them dependency-free also means the retry logic in `stage-call.ts`
 * can tell a rejected key from a provider outage without importing the
 * database layer to do it.
 */

/**
 * A user has configured a key that cannot be used at all — disabled after an
 * earlier rejection, or undecryptable.
 *
 * Distinct from a provider being down: no retry and no failover helps, and the
 * person who has to act is the user, not the operator.
 */
export class AiCredentialsError extends Error {
  constructor(message: string, readonly userFacing: string) {
    super(message);
    this.name = "AiCredentialsError";
  }
}

/**
 * A user's own provider refused the request.
 *
 * Carries the owning user so a rejected key can be disabled, and `authFailure`
 * so the caller can tell "this key is wrong" (retrying is pointless and rude
 * to their provider) from "this provider is having a bad minute" (retrying is
 * exactly right).
 */
export class ByoProviderError extends Error {
  constructor(
    message: string,
    readonly ownerUserId: string | undefined,
    readonly status: number | undefined,
    readonly authFailure: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ByoProviderError";
  }
}

/**
 * Finds a credential failure anywhere in an error's cause chain.
 *
 * Nothing that raises these errors is what finally catches them. `callStage`
 * wraps whatever failed in a `ReviewStageError`, and the single-model path
 * wraps it in a `FindingsLoopError` — both of which record the original under
 * a different property name. Testing `instanceof` on the error that arrives
 * at the top of the pipeline therefore never matches, which would leave a
 * rejected key enabled and the author reading "phase1_running failed" instead
 * of "your API key was rejected".
 *
 * Walks `cause` (the standard link, set by `ReviewStageError` and the
 * provider) and `originalError` (what `FindingsLoopError` calls it), with a
 * depth bound so a self-referential chain cannot spin.
 */
export function findCredentialError(error: unknown): AiCredentialsError | ByoProviderError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current !== undefined && current !== null; depth++) {
    if (current instanceof AiCredentialsError || current instanceof ByoProviderError) return current;
    const next = current as { cause?: unknown; originalError?: unknown };
    current = next.cause ?? next.originalError;
  }
  return undefined;
}
