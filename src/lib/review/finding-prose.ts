/**
 * Keeps a finding readable.
 *
 * A review comment is read by someone who is mid-task and deciding whether to
 * care. Length is not thoroughness: a model asked for evidence will happily
 * produce four hundred words restating the control flow it just read, and the
 * one sentence that matters gets buried in the middle of it. Observed on a
 * real review — a single finding ran eleven lines of internal vocabulary
 * ("returns true for 'withdraw' + 'maintain_rejection'…") before saying what
 * would actually go wrong.
 *
 * The prompts ask for brevity, which mostly works. This is the part that does
 * not depend on asking: a deterministic trim at a sentence boundary, so a
 * model having a verbose day still produces something a person will read.
 * Trimming at a sentence rather than a character count is the whole point —
 * a cut mid-clause reads as a bug in the tool.
 */

/** Splits on sentence ends, keeping the punctuation, and ignoring decimals and common abbreviations. */
function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z`'"([])/)
    .filter((part) => part.trim().length > 0);
}

/**
 * The first `maxSentences` sentences, and never more than `maxChars`.
 *
 * Returns whole sentences only. If even the first sentence is over the
 * character budget it is returned intact rather than cut: one long sentence
 * is still readable, half a sentence is not.
 */
export function tighten(text: string | undefined, maxSentences: number, maxChars: number): string {
  if (!text) return "";
  const parts = sentences(text);
  if (parts.length === 0) return "";

  const kept: string[] = [];
  let used = 0;
  for (const part of parts.slice(0, maxSentences)) {
    if (kept.length > 0 && used + part.length + 1 > maxChars) break;
    kept.push(part);
    used += part.length + 1;
  }
  return kept.join(" ").trim();
}

/** Sentence budgets per field. Small on purpose — see the note above. */
export const PROSE_BUDGET = {
  /** What the code does wrong. */
  problem: { sentences: 2, chars: 320 },
  /** What goes wrong as a result. */
  impact: { sentences: 2, chars: 320 },
  /** The input or state that reaches it. */
  trigger: { sentences: 1, chars: 200 },
} as const;

/**
 * The explanation a reader sees, as separate paragraphs.
 *
 * Returned as an array rather than a joined string because the two are not
 * interchangeable: the caller used to join with blank lines and the renderer
 * put the result in a single <p>, which collapses every break into a space.
 * Three tidy paragraphs became one unbroken block, which is exactly the wall
 * this module exists to prevent — the text was fine, the markup ate it.
 */
export function explanationParagraphs(finding: {
  problem?: string;
  whyItIsABug?: string;
  triggerScenario?: string;
}): string[] {
  return [
    tighten(finding.problem, PROSE_BUDGET.problem.sentences, PROSE_BUDGET.problem.chars),
    tighten(finding.whyItIsABug, PROSE_BUDGET.impact.sentences, PROSE_BUDGET.impact.chars),
    tighten(finding.triggerScenario, PROSE_BUDGET.trigger.sentences, PROSE_BUDGET.trigger.chars),
  ].filter((part) => part.length > 0);
}

/**
 * Splits a stored explanation back into its paragraphs for rendering.
 *
 * Lives here rather than in the component so there is one definition of what
 * a paragraph break is, on both the writing and the reading side. A renderer
 * that puts the whole string in a single element collapses those breaks into
 * spaces, which is how three tidy paragraphs arrived as one unbroken block.
 */
export function explanationLines(explanation: string | undefined): string[] {
  if (!explanation) return [];
  return explanation
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
