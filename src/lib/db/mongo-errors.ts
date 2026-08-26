/** True for a MongoDB duplicate-key error (E11000) — e.g. a unique-index conflict from a race between two inserts. */
export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === 11000
  );
}
