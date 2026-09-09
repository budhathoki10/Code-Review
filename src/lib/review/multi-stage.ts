import type { Logger } from "pino";
import type { PullRequestFile } from "@/lib/github/diff";
import type { RepoContext } from "@/lib/ai/review";
import { getFileContent } from "@/lib/github/file-content";
import { addUsage, EMPTY_USAGE, type TokenUsage } from "@/lib/db/usage";
import { buildReviewContext, type PrMetadata } from "@/lib/review/context-builder";
import { runPrimaryReview } from "@/lib/ai/primary-review";
import { runSecondaryReview } from "@/lib/ai/secondary-review";
import { reconcile } from "@/lib/review/reconciliation";
import { runDebate } from "@/lib/review/debate";
import { runArbitration } from "@/lib/review/arbitration";
import { isPresentable, validateLocation } from "@/lib/review/location-validation";
import { needsFocusedConfirmation, runFocusedConfirmation } from "@/lib/review/focused-confirmation";
import { buildTraceBlock, importCandidates } from "@/lib/review/symbol-trace";
import { renderRejectionExamples, suppressLearnedRejections } from "@/lib/review/learned-rejections";
import { ReviewStageError, toFindingDoc, type CandidateFinding, type ReviewStage } from "@/lib/review/stage-types";
import type { FindingDoc, FindingFeedbackDoc } from "@/lib/db/collections";

/**
 * Runs the whole pipeline: context, primary review, independent verification,
 * reconciliation, debate, arbitration, deterministic validation.
 *
 * Two properties hold at every step and are the reason it is shaped this way.
 * Findings travel as whole objects — nothing is ever reduced to a count and
 * rebuilt — and a stage that fails throws rather than returning an empty
 * list, so "the provider timed out" can never be rendered as "your code is
 * clean". The only stages allowed to fail softly are the ones that can only
 * narrow the result: if debate or arbitration cannot run, their findings stay
 * disputed and are reported as unresolved rather than promoted.
 */

export interface MultiStageOptions {
  files: PullRequestFile[];
  repo: RepoContext;
  meta: PrMetadata;
  deadlineAt: number;
  log: Logger;
  onStage?: (stage: ReviewStage) => void | Promise<void>;
  /** Reserve for arbitration and validation so the last stages are not starved by the first. */
  reserveMs?: number;
  /**
   * Phase 1 output from an earlier attempt at this same commit.
   *
   * The primary review is by far the most expensive call in the pipeline, and
   * a BullMQ retry re-runs everything from the top. Without this, a Mongo blip
   * after Phase 1 costs its entire budget a second and third time for a
   * byte-identical diff.
   */
  resumePrimary?: CandidateFinding[];
  /** Called the moment Phase 1 returns, before anything that can fail. */
  onPrimaryFindings?: (findings: CandidateFinding[]) => void | Promise<void>;
  /**
   * Findings a maintainer of this repository already said were not bugs.
   *
   * Applied twice: matching findings are dropped before they cost a
   * verification round, and the rest are shown to the verifier as this
   * repository's own judgement. Absent for a repository nobody has rated,
   * which is every repository until someone clicks.
   */
  learnedRejections?: FindingFeedbackDoc[];
}

export interface MultiStageResult {
  /** Defects to report. Every one is confirmed and passed deterministic validation. */
  findings: FindingDoc[];
  /** Could not be established either way. Shown apart, never as defects. */
  unresolved: FindingDoc[];
  /** Dismissed, with the reason. Kept for the audit trail. */
  rejected: FindingDoc[];
  usage: TokenUsage;
  stage: ReviewStage;
  stats: {
    primary: number;
    secondaryNew: number;
    agreed: number;
    disputed: number;
    debated: number;
    arbitrated: number;
    focusedConfirmations: number;
    invalidLocation: number;
    resumedPrimary: boolean;
    suppressedByFeedback: number;
  };
}

/**
 * First-party modules pulled in purely so a trace can follow a symbol across
 * an import. Bounded because this is depth for the findings already in hand,
 * not a second attempt at reading the repository.
 */
const MAX_TRACE_HOPS = 10;

export async function runMultiStageReview(options: MultiStageOptions): Promise<MultiStageResult> {
  const { files, repo, meta, deadlineAt, log } = options;
  const reserveMs = options.reserveMs ?? 60_000;
  let usage = EMPTY_USAGE;

  const mark = async (stage: ReviewStage) => {
    log.info({ stage }, "review stage");
    await options.onStage?.(stage);
  };

  /** Adds paths to the shared source map, ignoring the ones that do not exist. */
  const fetchInto = async (paths: string[]) => {
    const wanted = [...new Set(paths)].filter((path) => !context.sources.has(path));
    if (wanted.length === 0) return 0;
    let added = 0;
    await Promise.all(wanted.map(async (path) => {
      const content = await getFileContent(repo.installationId, repo.owner, repo.repo, path, repo.ref, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadlineAt - Date.now()))),
      }).catch(() => undefined);
      if (content !== undefined) {
        context.sources.set(path, content);
        added += 1;
      }
    }));
    return added;
  };

  /**
   * A stage prompt with the symbol traces for the findings it is judging.
   *
   * Appended to the context rather than replacing anything: the traces are
   * evidence about the findings, and the reviewer still needs the code they
   * came from to read them against.
   */
  const withTraces = (findings: CandidateFinding[]) =>
    `${context.text}${buildTraceBlock(findings, context.sources)}${renderRejectionExamples(options.learnedRejections ?? [])}`;

  await mark("context_building");
  const context = await buildReviewContext(files, repo, meta, Math.min(deadlineAt, Date.now() + 90_000));
  if (context.filesIncluded.length === 0) {
    // No source at the reviewed commit means nothing downstream can be
    // grounded. That is a failure, not a clean review.
    throw new ReviewStageError("context_building", "No file content could be read at the reviewed commit");
  }
  log.info({ files: context.filesIncluded.length, related: context.relatedIncluded.length, chars: context.chars }, "context built");

  let primaryFindings: CandidateFinding[];
  const resumed = Boolean(options.resumePrimary);
  if (options.resumePrimary) {
    // Same commit, same diff, already paid for. Re-running it would buy an
    // identical answer at full price.
    primaryFindings = options.resumePrimary;
    await mark("phase1_completed");
    log.info({ findings: primaryFindings.length }, "reusing primary review from an earlier attempt");
  } else {
    await mark("phase1_running");
    const primary = await runPrimaryReview(context.text, deadlineAt - reserveMs);
    usage = addUsage(usage, primary.usage);
    primaryFindings = primary.findings;
    // Persisted before anything downstream can fail, so a retry resumes here.
    await options.onPrimaryFindings?.(primaryFindings);
    await mark("phase1_completed");
    log.info({ findings: primaryFindings.length, attempts: primary.attempts }, "primary review completed");
  }

  // A maintainer already ruled on some of these. Dropping them here rather
  // than after verification means a finding this repository has explicitly
  // rejected never costs a verification round, a debate or an arbitration
  // call — and, more to the point, never gets reported again after someone
  // took the trouble to say it was wrong.
  const learned = options.learnedRejections ?? [];
  const { kept: keptFindings, suppressed } = suppressLearnedRejections(primaryFindings, learned);
  if (suppressed.length > 0) {
    log.info(
      { count: suppressed.length, findings: suppressed.map((s) => `${s.finding.file}:${s.finding.startLine} (${s.because.title})`) },
      "dropped findings a maintainer already marked as not a bug",
    );
    primaryFindings = keptFindings;
  }

  // Traces are only as good as the files they can see, and the context builder
  // stops at a file budget that a real pull request exceeds. Before anything
  // judges these findings, pull in the files they name and the first-party
  // modules those files import — one hop, which is where the reviewers' worst
  // misses live: a claim about what a value does, contradicted by the consumer
  // sitting one import away.
  const traceTargets = [...new Set(primaryFindings.map((f) => f.file))];
  const fetchedForTrace = await fetchInto(traceTargets);
  const hopTargets = traceTargets.flatMap((path) => {
    const source = context.sources.get(path);
    return source ? importCandidates(source, path) : [];
  });
  const fetchedHops = await fetchInto(hopTargets.slice(0, MAX_TRACE_HOPS));
  if (fetchedForTrace + fetchedHops > 0) {
    log.info({ findingFiles: fetchedForTrace, imported: fetchedHops }, "fetched extra source so symbol traces can follow it");
  }

  await mark("phase2_running");
  const secondary = await runSecondaryReview(withTraces(primaryFindings), primaryFindings, deadlineAt - reserveMs);
  usage = addUsage(usage, secondary.usage);
  await mark("phase2_completed");
  log.info(
    { verifications: secondary.verifications.length, newFindings: secondary.newFindings.length },
    "independent verification completed",
  );

  await mark("reconciling");
  const reconciled = reconcile(primaryFindings, secondary.verifications, secondary.newFindings);
  log.info(
    { tracked: reconciled.tracked.length, rejected: reconciled.rejected.length, disputed: reconciled.disputedCount },
    "reconciliation completed",
  );

  // Severe findings only the verifier saw earn a dedicated confirmation before
  // anything else looks at them. Discarding them because the primary reviewer
  // missed them would throw away the recall this stage exists to add;
  // promoting them unexamined would put an unreviewed CRITICAL in front of an
  // author.
  let tracked = reconciled.tracked;
  let focusedCount = 0;
  const needsFocus = needsFocusedConfirmation(tracked);
  if (needsFocus.length > 0 && Date.now() < deadlineAt - reserveMs) {
    try {
      const focused = await runFocusedConfirmation(withTraces(needsFocus.map((t) => t.candidate)), needsFocus, deadlineAt - reserveMs);
      usage = addUsage(usage, focused.usage);
      focusedCount = needsFocus.length;
      const byId = new Map(focused.resolved.map((r) => [r.candidate.id, r]));
      tracked = tracked.map((t) => byId.get(t.candidate.id) ?? t);
    } catch (error) {
      // Only narrows, so losing it leaves them unconfirmed rather than failing
      // the review — and unconfirmed is the safe direction for a claim only
      // one reviewer made.
      log.warn({ err: error, count: needsFocus.length }, "focused confirmation unavailable; severe verifier findings remain unresolved");
      const ids = new Set(needsFocus.map((t) => t.candidate.id));
      tracked = tracked.map((t) => (ids.has(t.candidate.id) ? { ...t, status: "uncertain" as const } : t));
    }
  }

  let settled = tracked.filter((t) => t.status !== "disputed");
  const disputed = tracked.filter((t) => t.status === "disputed");
  let debatedCount = 0;
  let arbitratedCount = 0;

  if (disputed.length > 0 && Date.now() < deadlineAt - reserveMs) {
    await mark("debate_running");
    try {
      const debate = await runDebate(withTraces(disputed.map((t) => t.candidate)), disputed, deadlineAt - reserveMs / 2);
      usage = addUsage(usage, debate.usage);
      debatedCount = disputed.length;
      settled = [...settled, ...debate.resolved];

      if (debate.unresolved.length > 0) {
        await mark("arbitration_running");
        try {
          const arbitration = await runArbitration(withTraces(debate.unresolved.map((t) => t.candidate)), debate.unresolved, deadlineAt);
          usage = addUsage(usage, arbitration.usage);
          arbitratedCount = debate.unresolved.length;
          settled = [...settled, ...arbitration.resolved];
        } catch (error) {
          // Arbitration can only narrow. Losing it leaves these unresolved,
          // which is the honest state, so the review continues degraded
          // rather than failing outright.
          log.warn({ err: error, count: debate.unresolved.length }, "arbitration unavailable; findings remain unresolved");
          settled = [...settled, ...debate.unresolved.map((t) => ({ ...t, status: "uncertain" as const }))];
        }
      }
    } catch (error) {
      log.warn({ err: error, count: disputed.length }, "debate unavailable; disputed findings remain unresolved");
      settled = [...settled, ...disputed.map((t) => ({ ...t, status: "uncertain" as const }))];
    }
  } else if (disputed.length > 0) {
    log.warn({ count: disputed.length }, "no time budget for debate; disputed findings remain unresolved");
    settled = [...settled, ...disputed.map((t) => ({ ...t, status: "uncertain" as const }))];
  }

  await mark("validating");
  // The context builder stops at a file budget, and a pull request can change
  // more files than that. Without this, a finding in file thirteen of
  // twenty-two failed validation because we never fetched it — discarded for
  // our own budget rather than for being wrong, which was four of five
  // findings on the first real run. Only files a surviving finding actually
  // names are fetched, so the cost is proportional to the findings and not to
  // the diff.
  const missing = [...new Set(settled.map((t) => t.candidate.file))].filter((path) => !context.sources.has(path));
  if (missing.length > 0) {
    log.info({ files: missing.length }, "fetching source for findings outside the context budget");
    await Promise.all(missing.map(async (path) => {
      const content = await getFileContent(repo.installationId, repo.owner, repo.repo, path, repo.ref, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadlineAt - Date.now()))),
      }).catch(() => undefined);
      if (content !== undefined) context.sources.set(path, content);
    }));
  }
  const validationInput = { sources: context.sources, files, commitSha: meta.headSha };
  const validated = settled.map((t) => validateLocation(t, validationInput));
  const invalid = validated.filter((t) => !isPresentable(t));
  if (invalid.length > 0) {
    log.warn(
      { count: invalid.length, findings: invalid.map((t) => `${t.candidate.file}:${t.candidate.startLine}`) },
      "findings failed deterministic location validation",
    );
  }

  // A finding is a defect only if a reviewer concluded it is one AND the
  // repository agrees the location is real. Everything else that survived is
  // unresolved, which is reported separately rather than silently dropped.
  const presentable = validated.filter(isPresentable);
  const confirmed = presentable.filter((t) => t.status === "confirmed" || t.status === "agreed" || t.status === "modified");
  const unresolved = [
    ...presentable.filter((t) => t.status === "uncertain" || t.status === "candidate"),
    ...invalid,
  ];
  // Debate and arbitration concluded these are not real defects, after a
  // proposer tried to disprove its own claim and a challenger tried to
  // disprove its own rejection — the strongest process this pipeline has for
  // deciding a finding is wrong. That conclusion is still worth showing: it
  // is folded into the results at low severity, with the reasoning attached,
  // rather than dropped into an unreviewed pile the author never sees. Only
  // reconciled.rejected (exact duplicates of a finding already tracked
  // elsewhere) is left out — that is dedup, not a correctness verdict.
  const debatedAway: FindingDoc[] = presentable
    .filter((t) => t.status === "rejected")
    .map((t) => {
      const doc = toFindingDoc(t, meta.headSha);
      return {
        ...doc,
        severity: "low" as const,
        verification: {
          evidence: doc.verification?.evidence ?? [],
          status: "downgraded" as const,
          reason: `Debate concluded this is not a defect, shown rather than dropped: ${doc.verification?.reason ?? ""}`,
        },
      };
    });

  await mark("completed");
  return {
    findings: [...confirmed.map((t) => toFindingDoc(t, meta.headSha)), ...debatedAway],
    unresolved: unresolved.map((t) => toFindingDoc(t, meta.headSha)),
    rejected: [],
    usage,
    stage: "completed",
    stats: {
      primary: primaryFindings.length,
      secondaryNew: secondary.newFindings.length,
      agreed: reconciled.tracked.length - reconciled.disputedCount,
      disputed: reconciled.disputedCount,
      debated: debatedCount,
      arbitrated: arbitratedCount,
      focusedConfirmations: focusedCount,
      invalidLocation: invalid.length,
      resumedPrimary: resumed,
      suppressedByFeedback: suppressed.length,
    },
  };
}

/** Findings sorted for display: worst first, then by file and line. */
export function orderForDisplay(findings: FindingDoc[]): FindingDoc[] {
  const rank: Record<FindingDoc["severity"], number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return [...findings].sort(
    (a, b) => rank[a.severity] - rank[b.severity] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0),
  );
}
