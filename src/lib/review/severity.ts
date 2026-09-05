import type { FindingDoc } from "@/lib/db/collections";

/**
 * Every severity, worst-first.
 *
 * Kept in its own module rather than in db/collections so the dashboard, the
 * server action, the pipeline and the tests all share one list without
 * dragging the Mongo layer in — the pipeline tests mock that module wholesale,
 * and a pure constant living behind a mock is a constant that silently
 * disappears.
 */
export const REVIEW_SEVERITIES: FindingDoc["severity"][] = ["critical", "high", "medium", "low", "info"];

/**
 * Drops an all-off severity list.
 *
 * Every severity switched off would leave no findings at all while still
 * paying for a model call on every PR, which is never what someone means —
 * they mean "stop reviewing this repo", which is uninstalling.
 *
 * Applied at every boundary that produces or consumes the list, because the
 * guard is only as good as its earliest application: the review prompt is
 * built from this list too, and a model instructed to omit every severity
 * returns nothing for a later filter to rescue.
 */
export function normalizeDisabledSeverities(
  disabled: FindingDoc["severity"][] | undefined,
): FindingDoc["severity"][] {
  if (!disabled?.length) return [];
  const unique = new Set(disabled);
  return unique.size >= REVIEW_SEVERITIES.length ? [] : [...unique];
}
