/**
 * Reads a numeric environment variable, falling back on anything that is not a
 * real number.
 *
 * `Number(process.env.X ?? fallback)` — the shape this replaces — only falls
 * back when the variable is ABSENT. A variable that is present but
 * unparseable ("8s", "25 ", an empty string, a value quoted wrong in
 * render.yaml) yields NaN, and NaN then loses every comparison it takes part
 * in without raising anything. That failure is silent and always in the wrong
 * direction:
 *
 *   - `MAX_INLINE_COMMENTS` — `length <= NaN` is false and `slice(0, NaN)` is
 *     empty, so a typo posts ZERO inline comments and logs nothing.
 *   - `REVIEW_MAX_BISECT_ATTEMPTS` — `remaining <= 0` is false forever, so the
 *     budget stops existing and a provider outage walks the whole split tree.
 *   - `REVIEW_PROVIDER_FAILURE_THRESHOLD` — `failures >= NaN` is false forever,
 *     so an outage is never recognised.
 *   - `STATIC_ANALYSIS_CONTEXT_TIMEOUT_MS` — `setTimeout(fn, NaN)` fires
 *     immediately, so the model silently never sees a static finding.
 *
 * `Number.isFinite` rejects NaN, Infinity and -Infinity alike. "0" is handled
 * deliberately: it is a truthy string but a falsy number, so the emptiness
 * check is on the raw string, letting a configured zero mean zero.
 */
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
