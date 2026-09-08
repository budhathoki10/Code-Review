import { Bug, CheckCircle2, ChevronRight, FlaskConical, Folder, ShieldAlert, ShieldOff, Sparkles, Zap } from "lucide-react";
import type { FindingDoc, PullRequestDoc, ReviewDoc } from "@/lib/db/collections";
import { toneDotClasses, toneTextClasses, SEVERITY_TONE, type Tone } from "@/lib/ui";
import { STAGE_LABEL, type ReviewStage } from "@/lib/review/stage-types";
import { canSayNoFindings, findingSourceUrl, showsProgress, stageProgress, STAGE_SEQUENCE, verificationTrail } from "@/lib/review/finding-presentation";
import { explanationLines } from "@/lib/review/finding-prose";
import { visibleFindings, groupFindingsBySeverity } from "@/lib/review/review-display";
import { Markdown } from "@/components/markdown";
import { DiffBlock } from "@/components/diff-block";
import { CodeLocationLink } from "@/components/code-location-link";
import { SuggestionBlock } from "@/components/suggestion-block";
import { DeleteReviewButton } from "@/app/dashboard/repos/[repositoryId]/delete-review-button";
import { ReviewFeedback } from "@/components/review-feedback";
import { evidenceLabel } from "@/lib/review/finding-policy";

const CATEGORY_ICON: Record<FindingDoc["category"], typeof Bug> = {
  security: ShieldAlert,
  bug: Bug,
  performance: Zap,
  quality: Sparkles,
  testing: FlaskConical,
};

const VERDICT_TONE: Record<NonNullable<ReviewDoc["verdict"]>, Tone> = {
  approve: "success",
  request_changes: "danger",
  comment: "warning",
};

const VERDICT_LABEL: Record<NonNullable<ReviewDoc["verdict"]>, string> = {
  approve: "Approve",
  request_changes: "Request changes",
  comment: "Comment",
};

const STATUS_TONE: Record<ReviewDoc["status"], Tone> = {
  completed: "neutral",
  pending: "info",
  failed: "danger",
};

const STATUS_LABEL: Record<ReviewDoc["status"], string> = {
  completed: "Completed",
  pending: "Pending",
  failed: "Failed",
};

/**
 * Where a running review has got to.
 *
 * The multi-stage pipeline can take minutes, and "Pending" for all of them
 * tells a waiting reader nothing and looks indistinguishable from stuck. The
 * stage is already written to the row at every transition; this is the half
 * that reads it. Only rendered while the review is actually running — a
 * finished review is described by its findings, not by its progress.
 */
function StageProgress({ stage }: { stage: ReviewStage }) {
  const { step, total } = stageProgress(stage);
  const reached = step - 1;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="text-xs font-medium text-foreground">{STAGE_LABEL[stage]}</span>
      <span className="flex items-center gap-1" aria-hidden="true">
        {STAGE_SEQUENCE.map((step, index) => (
          <span
            key={step}
            className={`h-1 w-5 rounded-full transition-colors ${index <= reached ? "bg-accent" : "bg-border"}`}
          />
        ))}
      </span>
      <span className="text-xs text-subtle">
        step {Math.max(1, step)} of {total}
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: ReviewDoc["status"] }) {
  const tone = STATUS_TONE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${toneTextClasses(tone)}`}>
      <span className={toneDotClasses(tone)} />
      {STATUS_LABEL[status]}
    </span>
  );
}

function VerdictBadge({ verdict }: { verdict: NonNullable<ReviewDoc["verdict"]> }) {
  const tone = VERDICT_TONE[verdict];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${toneTextClasses(tone)}`}>
      <span className={toneDotClasses(tone)} />
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

/**
 * The code location, linked to the exact lines on GitHub when we know enough
 * to build a real URL.
 *
 * Only ever built from values we hold — owner, repo, the commit the review ran
 * against, the validated path and line. If any of them is missing the text is
 * rendered plainly rather than pointed somewhere that may not exist: a link to
 * the wrong line is worse than no link, because it looks authoritative.
 */
function CodeLocation({ finding, repoFullName }: { finding: FindingDoc; repoFullName?: string }) {
  const label = `${finding.file}${finding.line ? `:${finding.line}` : ""}`;
  const href = findingSourceUrl(finding, repoFullName);

  if (!href) {
    return (
      <span className="truncate font-mono text-xs font-medium text-foreground" title={finding.file}>
        {label}
      </span>
    );
  }
  return <CodeLocationLink href={href} label={label} title={`${finding.file} at ${finding.commitSha?.slice(0, 7)}`} />;
}

/**
 * How a finding was settled, in one line.
 *
 * Deliberately terse and free of any model reasoning. What a reader needs is
 * whether two reviewers looked at this and whether they had to be reconciled;
 * the argument itself is internal and showing it would invite the reader to
 * relitigate a decision the pipeline already made on evidence.
 */
function VerificationTrail({ stage }: { stage: NonNullable<FindingDoc["stage"]> }) {
  const parts = verificationTrail(stage);
  if (parts.length === 0) return null;
  return <p className="mt-2 text-xs text-subtle">{parts.join(" · ")}</p>;
}

/**
 * One finding, numbered within its severity group, and collapsible in its own
 * right.
 *
 * Two levels, not one: the severity folder groups, and each finding opens and
 * closes on top of that — so a review with a dozen findings can be skimmed as
 * a list of titles and code locations, then read one at a time. Both start
 * open, because a finding nobody can see is the same as a finding nobody
 * found.
 *
 * The code location leads the header and is set in the foreground rather than
 * the subtle tone: on a code review the first question is always "where", and
 * it was previously the faintest text in the row.
 */
function FindingItem({ finding, number, repoFullName }: { finding: FindingDoc; number: number; repoFullName?: string }) {
  const CategoryIcon = CATEGORY_ICON[finding.category];
  return (
    <li className="first:pt-0 last:pb-0">
      <details open className="group/finding">
        <summary className="flex cursor-pointer list-none items-start gap-2 py-4 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
          <ChevronRight
            className="mt-0.5 h-3 w-3 shrink-0 text-subtle transition-transform duration-200 group-open/finding:rotate-90"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="shrink-0 text-xs font-semibold tabular-nums text-subtle">{number})</span>
              <span className="inline-flex items-center gap-1 text-xs text-subtle">
                <CategoryIcon className="h-3 w-3" aria-hidden="true" />
                {finding.category}
              </span>
              <CodeLocation finding={finding} repoFullName={repoFullName} />
            </span>
            <span className="mt-1.5 block text-sm font-medium text-foreground">
              {finding.title}
              {finding.source === "static-analysis" && (
                <span className="ml-2 border border-border px-1.5 py-0.5 align-middle text-[10px] font-medium tracking-wide text-subtle uppercase">
                  Static analysis
                </span>
              )}
            </span>
          </span>
        </summary>
        <div className="pb-4 pl-5">
      {/* One paragraph per part. Rendering the whole explanation in a single
          <p> collapsed its blank lines into spaces, so "what is wrong", "what
          breaks" and "how it is reached" arrived as one unbroken block — the
          text was fine, the markup ate it. */}
      {explanationLines(finding.explanation).map((part, index) => (
        <p key={index} className={`text-sm leading-relaxed text-muted${index > 0 ? " mt-2" : ""}`}>{part}</p>
      ))}
      {finding.stage && <VerificationTrail stage={finding.stage} />}
      <p className="mt-2 text-xs text-subtle">{evidenceLabel(finding)}</p>
      {finding.verification?.status === "accepted" && <p className="mt-1 text-xs text-muted">Assessment: {finding.verification.reason}</p>}
      {finding.verification?.evidence.map((evidence, index) => <p key={index} className="mt-1 break-words font-mono text-xs text-muted">{evidence.file}:{evidence.line} — {evidence.quote}</p>)}
      {finding.proof && <details className="mt-2 text-xs text-muted"><summary className="cursor-pointer">Regression test: {finding.proof.status}</summary>
        <p className="mt-1">{finding.proof.reason}</p>
        <pre className="mt-1 overflow-x-auto">{JSON.stringify({ base: finding.proof.baseSha, head: finding.proof.headSha, ...finding.proof.test }, null, 2)}</pre>
      </details>}
      {/* Both halves present means this is a committable one-line replacement,
          so it's shown before/after like GitHub's suggestion widget. Prose
          suggestions and older findings have no originalLine and keep the
          single-column rendering. The `line` check is what the pipeline
          already guarantees when it sets originalLine, restated here because
          the stored type can't express the pairing. */}
      {finding.suggestion &&
        (finding.originalLine !== undefined && finding.line !== undefined ? (
          <SuggestionBlock
            line={finding.line}
            originalLine={finding.originalLine}
            originalContext={finding.originalContext}
            suggestion={finding.suggestion}
            file={finding.file}
            className="mt-3"
          />
        ) : (
          <DiffBlock diff={finding.suggestion} file={finding.file} className="mt-3" />
        ))}
        </div>
      </details>
    </li>
  );
}

/**
 * One severity's findings behind a native disclosure — a "folder" for High,
 * Medium, and so on.
 *
 * Closed by default, so a card opens as a scannable index — one row per
 * severity — rather than as a wall of findings the reader scrolls past to
 * reach the next review.
 *
 * This was open for a while, for a real reason: closed groups once meant the
 * card showed "MEDIUM 1 / LOW 2 / INFO 1" and nothing else, and every reader
 * concluded the review had produced counts and no content. A review whose
 * findings are invisible is indistinguishable from one that found nothing.
 * What makes closed safe now is that the card no longer goes silent when the
 * groups do: the header states the outcome in words ("Reviewed 4 file(s) —
 * 3 medium.") and the footer carries duration, file coverage and comment
 * count. The findings read as filed, not missing.
 *
 * If that summary line is ever removed, this has to go back to open.
 */
function SeverityGroup({ severity, findings, repoFullName }: { severity: FindingDoc["severity"]; findings: FindingDoc[]; repoFullName?: string }) {
  const tone = SEVERITY_TONE[severity];
  return (
    <li>
      <details className="group/severity">
        <summary className="flex cursor-pointer list-none items-center gap-2 py-2.5 text-muted transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
          <ChevronRight
            className="h-3 w-3 shrink-0 text-subtle transition-transform duration-200 group-open/severity:rotate-90"
            aria-hidden="true"
          />
          <Folder className={`h-3.5 w-3.5 shrink-0 ${toneTextClasses(tone)}`} aria-hidden="true" />
          <span className={`text-xs font-semibold tracking-wide uppercase ${toneTextClasses(tone)}`}>{severity}</span>
          <span className="shrink-0 text-xs tabular-nums text-subtle">{findings.length}</span>
        </summary>
        <ul className="divide-y divide-border border-t border-border pl-5">
          {findings.map((finding, i) => (
            <FindingItem key={i} finding={finding} number={i + 1} repoFullName={repoFullName} />
          ))}
        </ul>
      </details>
    </li>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

/**
 * How much of the PR this review actually covered, and how long it took.
 * Rendered only when metrics exist, so reviews written before per-review
 * accounting simply don't show the strip rather than showing zeros.
 *
 * Token and call counts are deliberately not shown here — they're internal
 * cost accounting (still recorded in full on the review doc and the global
 * usage counter, see `npm run usage`), not something a reviewer reading a PR
 * needs in front of them.
 */
function MetricsStrip({ metrics }: { metrics: NonNullable<ReviewDoc["metrics"]> }) {
  const cells: { label: string; value: string; title?: string }[] = [
    { label: "Duration", value: formatDuration(metrics.durationMs) },
    {
      label: "Files",
      value: `${metrics.filesReviewed}/${metrics.filesSeen}`,
      title: `${metrics.filesReviewed} reviewed, ${metrics.filesFiltered} filtered out, ${metrics.filesSeen} changed`,
    },
    { label: "Comments", value: String(metrics.commentsPosted) },
  ];

  // Only shown once rates are configured — a $0.0000 cell would look like a
  // measurement rather than an absent setting.
  if (metrics.estimatedCostUsd > 0) {
    cells.push({ label: "Est. cost", value: `$${metrics.estimatedCostUsd.toFixed(4)}` });
  }

  return (
    <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-4 sm:grid-cols-3 lg:grid-cols-6">
      {cells.map((cell) => (
        <div key={cell.label} title={cell.title}>
          <dt className="text-xs text-subtle">{cell.label}</dt>
          <dd className="mt-0.5 text-sm font-medium tabular-nums text-foreground">{cell.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * What a review with nothing to report looks like.
 *
 * Without this the findings area is simply absent, so a clean review and a
 * broken one render identically — an empty card that reads as "the dashboard
 * failed" rather than "there was nothing to raise". For a reviewer whose
 * entire pitch is that it stays quiet, silence has to look deliberate.
 */
function NoFindings({ review, rejected }: { review: ReviewDoc; rejected: number }) {
  const files = review.metrics?.filesReviewed;
  return (
    <div className="mt-4 flex items-start gap-3 border-t border-border pt-4">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-foreground">No findings</p>
        <p className="mt-0.5 text-sm text-muted">
          {files === undefined
            ? "This review raised nothing."
            : `Nothing was raised across ${files} reviewed file${files === 1 ? "" : "s"}.`}
          {rejected > 0 && ` ${rejected} candidate${rejected === 1 ? " was" : "s were"} dropped during assessment — see below.`}
        </p>
      </div>
    </div>
  );
}

/**
 * The findings the assessment pass threw out, and why.
 *
 * Rendered properly rather than as a line of debug text, because on a quiet
 * review this is the only substance on the card — and it is the evidence for
 * the claim the product actually makes. "Three things were considered and
 * rejected, here is the reasoning" is a stronger statement than an empty page,
 * and it is what lets someone judge whether the filter is working or just
 * swallowing everything. Kept closed and visually recessive: this is
 * corroboration, not a to-do list.
 */
function RejectedFindings({ rejected }: { rejected: FindingDoc[] }) {
  return (
    <details className="group/rejected mt-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-2 text-muted transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="h-3 w-3 shrink-0 text-subtle transition-transform duration-200 group-open/rejected:rotate-90"
          aria-hidden="true"
        />
        <ShieldOff className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden="true" />
        <span className="text-xs font-semibold tracking-wide text-subtle uppercase">Rejected in assessment</span>
        <span className="shrink-0 text-xs tabular-nums text-subtle">{rejected.length}</span>
      </summary>
      <ul className="divide-y divide-border border-t border-border pl-5">
        {rejected.map((finding, index) => (
          <li key={index} className="py-3 first:pt-3 last:pb-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${toneTextClasses(SEVERITY_TONE[finding.severity])}`}>
                <span className={toneDotClasses(SEVERITY_TONE[finding.severity])} />
                {finding.severity}
              </span>
              <span className="truncate font-mono text-xs text-subtle" title={finding.file}>
                {finding.file}
                {finding.line ? `:${finding.line}` : ""}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted line-through decoration-subtle/60">{finding.title}</p>
            {finding.verification?.reason && (
              <p className="mt-1.5 text-xs leading-relaxed text-subtle">
                <span className="font-medium">Why it was dropped:</span> {finding.verification.reason}
              </p>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ReviewCard({
  review,
  pullRequest,
  defaultOpen,
  accordionName,
  repositoryId,
  repoFullName,
  notABugIds,
}: {
  review: ReviewDoc;
  pullRequest: PullRequestDoc | undefined;
  defaultOpen: boolean;
  /** Cards with the same name behave as an exclusive native accordion. */
  accordionName?: string;
  /** Omit to hide the delete action (e.g. contexts without ownership scoping already established). */
  repositoryId?: string;
  /** "owner/repo", used to link a finding to its exact lines on GitHub. Omitted renders the location as plain text. */
  repoFullName?: string;
  /** Findings of this review a maintainer has already marked as not a bug. */
  notABugIds?: string[];
}) {
  const findings = visibleFindings(review);
  const severityGroups = groupFindingsBySeverity(findings);
  const hasReviewDetails = Boolean(
    review.summary ||
      severityGroups.length > 0 ||
      (review.status === "failed" && review.error),
  );
  const prLabel = pullRequest ? `#${pullRequest.githubPrNumber}` : "this review";

  return (
    <li>
      <details
        name={accordionName}
        open={defaultOpen}
        className="group overflow-hidden rounded-lg border border-border bg-card transition-[border-color,box-shadow] open:border-foreground/25 open:shadow-[0_8px_28px_rgba(25,24,20,0.05)]"
      >
        <summary className="flex min-h-16 cursor-pointer list-none flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3.5 transition-colors hover:bg-surface-hover/55 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent group-open:bg-surface-hover/35 [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 items-center gap-2">
            <ChevronRight
              className="h-3.5 w-3.5 shrink-0 text-subtle transition-transform duration-200 group-open:rotate-90 group-open:text-foreground"
              aria-hidden="true"
            />
            <span className="truncate text-sm font-medium text-foreground">
              {pullRequest ? `#${pullRequest.githubPrNumber} — ${pullRequest.title}` : "Unknown PR"}
            </span>
          </span>
          <div className="flex shrink-0 items-center gap-3">
            {review.verdict && <VerdictBadge verdict={review.verdict} />}
            <StatusBadge status={review.status} />
            {repositoryId && (
              <DeleteReviewButton
                reviewId={String(review._id)}
                repositoryId={repositoryId}
                prLabel={prLabel}
              />
            )}
          </div>
        </summary>

        <div className="border-t border-border px-5 pb-5">
          {/* No severity strip here: every folder header below already carries
              its own severity and count, so a strip above them states the same
              numbers a second time and pushes the findings further down the
              card. The findings are the content; the counts are a label on
              them. */}

          {showsProgress(review) && review.stage && <StageProgress stage={review.stage} />}

          {/* Pending only. A completed review with nothing to report is handled
              by NoFindings below, which says the same thing with the file count
              and the assessment tally behind it — leaving both in place rendered
              the message twice on exactly the review that has least to show. */}
          {/* Not shown alongside the progress bar: the bar already names the
              stage and its position, so this repeats it in vaguer words and
              pushes the bar further from the heading. */}
          {!hasReviewDetails && review.status !== "completed" && !showsProgress(review) && (
            <p className="py-5 text-sm leading-6 text-muted">
              {review.status === "pending"
                ? "This review is still being processed. Results will appear here when it completes."
                : "This review finished without findings or summary details."}
            </p>
          )}

          {review.summary && (
            <div className="mt-3 pt-1">
              <Markdown content={review.summary} />
            </div>
          )}

          {review.incomplete && (
            <div className="mt-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
              <p className="text-xs font-medium text-warning">
                {review.incomplete.reason === "rate-limited"
                  ? "Paused — GitHub rate limit"
                  : "Not reviewed — pull request too large"}
              </p>
              <p className="mt-0.5 text-xs text-muted">{review.incomplete.detail}</p>
            </div>
          )}

          {review.status === "failed" && review.error && (
            <div className="mt-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2">
              <p className="text-xs font-medium text-danger">
                Failed after {review.error.attempts} attempt{review.error.attempts === 1 ? "" : "s"}
              </p>
              <p className="mt-0.5 font-mono text-xs text-muted">{review.error.message}</p>
            </div>
          )}

          {severityGroups.length > 0 ? (
            <ul className="mt-4 divide-y divide-border border-t border-border">
              {severityGroups.map((group) => (
                <SeverityGroup key={group.severity} severity={group.severity} findings={group.findings} repoFullName={repoFullName} />
              ))}
            </ul>
          ) : canSayNoFindings(review) ? (
            <NoFindings review={review} rejected={review.verificationCheckpoint?.rejected.length ?? 0} />
          ) : (
            /* Nothing confirmed, but the pipeline is holding something it could
               not settle — so "no findings" would be a claim it has not earned.
               The items themselves are deliberately not listed: an unproven
               claim reads as a defect to anyone skimming, and the two that
               reached this state on real reviews were both wrong. One honest
               line, and the detail stays in the stored review for diagnostics. */
            !!review.unresolvedFindings?.length && review.status === "completed" && (
              <p className="mt-4 border-t border-border pt-4 text-sm text-muted">
                Nothing to review. This PR is clean.
              </p>
            )
          )}

          {review.metrics && <MetricsStrip metrics={review.metrics} />}
          {repositoryId && review.status === "completed" && (
            <ReviewFeedback reviewId={String(review._id)} repositoryId={repositoryId} value={review.feedback?.label} findings={findings} notABugIds={notABugIds ?? []} />
          )}
          {review.verificationCheckpoint && <p className="mt-3 text-xs text-subtle">
            Verification: {review.verificationCheckpoint.candidates} candidates · {review.verificationCheckpoint.usage.calls} extra calls · {review.verificationCheckpoint.usage.totalTokens} reported tokens · {review.verificationCheckpoint.rejected.length} rejected.
          </p>}
          {!!review.verificationCheckpoint?.rejected.length && (
            <RejectedFindings rejected={review.verificationCheckpoint.rejected} />
          )}
          {!!review.riskFiles?.length && <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer">Sensitive changes prioritized ({review.riskFiles.length})</summary>
            <ul className="mt-2 space-y-1">{review.riskFiles.map((risk) => <li key={risk.file}>{risk.file}: {risk.reasons.join(", ")}</li>)}</ul>
          </details>}
        </div>
      </details>
    </li>
  );
}
