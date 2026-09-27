import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Authenticated encryption for the one class of secret this app stores on
 * behalf of someone else: a user's own provider API key.
 *
 * Every other secret here lives in the environment — the GitHub app key, the
 * webhook secret, the platform's own NVIDIA and OpenRouter keys. Those belong
 * to the operator and never touch the database. A user's key is different: a
 * review runs minutes after a webhook fires, in a worker process, with nobody
 * signed in to supply it, so it has to be readable without the user present.
 * That means at rest, which means encrypted at rest.
 *
 * AES-256-GCM rather than CBC or a bare cipher: GCM authenticates, so a row
 * edited in the database fails to decrypt instead of quietly yielding
 * different bytes. A tampered key that still decrypts would be sent to a
 * third-party endpoint, which is exactly the outcome worth ruling out.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
/** 96 bits, the size GCM is specified for — longer nonces are rehashed and gain nothing. */
const IV_BYTES = 12;
const VERSION = "v1";

export class SecretBoxError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SecretBoxError";
  }
}

/**
 * The master key, decoded and checked.
 *
 * Deliberately not memoised. `vi.stubEnv` and `process.env` assignment are how
 * every other config value in this codebase is exercised in tests, and a
 * module-level cache would make this the one thing that ignores them. The
 * decode is a base64 parse of 32 bytes; it is not worth caching.
 */
function masterKey(): Buffer {
  const raw = process.env.SECRETS_ENCRYPTION_KEY;
  if (raw === undefined || raw.trim() === "") {
    throw new SecretBoxError(
      "SECRETS_ENCRYPTION_KEY is not set. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }

  let key: Buffer;
  try {
    key = Buffer.from(raw.trim(), "base64");
  } catch (cause) {
    throw new SecretBoxError("SECRETS_ENCRYPTION_KEY is not valid base64", { cause });
  }

  // Buffer.from does not throw on malformed base64, it truncates. The length
  // check is what actually catches a mistyped or half-copied value.
  if (key.length !== KEY_BYTES) {
    throw new SecretBoxError(
      `SECRETS_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return key;
}

/**
 * Fails fast when the master key is missing or malformed.
 *
 * Called at worker start and before the settings form writes anything, so a
 * misconfigured deploy is a startup error rather than a review that dies
 * halfway through, or a key that encrypts today and cannot be read back
 * tomorrow.
 */
export function assertSecretsConfigured(): void {
  masterKey();
}

/** True when a master key is present and usable, for feature-gating the UI without throwing. */
export function secretsConfigured(): boolean {
  try {
    masterKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypts to `v1.<iv>.<tag>.<ciphertext>`, each part base64.
 *
 * The version prefix is the part that matters later: rotating the master key
 * or moving to another algorithm needs a way to tell which rows were written
 * under which scheme, and adding that after the fact means guessing.
 */
export function encryptSecret(plaintext: string): string {
  if (plaintext === "") throw new SecretBoxError("Refusing to encrypt an empty secret");

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
}

/**
 * Reverses `encryptSecret`. Throws on a tampered, truncated or foreign envelope
 * rather than returning anything — there is no partial success worth having
 * when the result is about to be sent to a third party as a credential.
 */
export function decryptSecret(envelope: string): string {
  const parts = envelope.split(".");
  if (parts.length !== 4) throw new SecretBoxError("Malformed secret envelope");

  const [version, ivB64, tagB64, ciphertextB64] = parts;
  if (version !== VERSION) throw new SecretBoxError(`Unsupported secret envelope version: ${version}`);

  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_BYTES) throw new SecretBoxError("Malformed secret envelope: bad IV length");

  try {
    const decipher = createDecipheriv(ALGORITHM, masterKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (cause) {
    // Wrong master key and tampered ciphertext are indistinguishable here, by
    // design of GCM. Both mean the same thing to a caller: do not use this.
    throw new SecretBoxError("Could not decrypt secret — wrong key or tampered value", { cause });
  }
}

/**
 * The tail of a key, for showing which one is stored without revealing it.
 *
 * Four characters is what provider dashboards show, and it is short enough to
 * be useless on its own while still letting someone match the row against the
 * key they hold.
 */
export function keyFingerprint(apiKey: string): string {
  return apiKey.slice(-4);
}
