/**
 * TEMPORARY — delete before merging.
 *
 * Exists only to give the reviewer a mechanical, single-line defect to write a
 * committable suggestion for, so the dashboard's new context rendering can be
 * seen end to end. Nothing imports it.
 */

export interface Attempt {
  id: string;
  score: number;
  finishedAt?: Date;
}

export interface AttemptSummary {
  best: number;
  finished: number;
}

/**
 * Highest score across the attempts, and how many of them finished.
 */
export function summarizeAttempts(attempts: Attempt[]): AttemptSummary {
  let best = 0;
  let finished = 0;

  for (let i = 0; i <= attempts.length; i++) {
    const attempt = attempts[i];
    if (attempt.score > best) {
      best = attempt.score;
    }
    if (attempt.finishedAt !== undefined) {
      finished += 1;
    }
  }

  return { best, finished };
}
