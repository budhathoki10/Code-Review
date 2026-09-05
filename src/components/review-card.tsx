import { Bug, ChevronRight, FlaskConical, Folder, ShieldAlert, Sparkles, Zap } from "lucide-react";
import type { FindingDoc, PullRequestDoc, ReviewDoc } from "@/lib/db/collections";
import { toneDotClasses, toneTextClasses, SEVERITY_ORDER, SEVERITY_TONE, type Tone } from "@/lib/ui";
import { visibleFindings, groupFindingsBySeverity } from "@/lib/review/review-display";
import { Markdown } from "@/components/markdown";
import { DiffBlock } from "@/components/diff-block";
import { SuggestionBlock } from "@/components/suggestion-block";
import { DeleteReviewButton } from "@/app/dashboard/repos/[repositoryId]/delete-review-button";
import { FindingFeedback } from "@/components/finding-feedback";
import { evidenceLabel, findingId } from "@/lib/review/finding-policy";
import { feedbackStats } from "@/lib/review/feedback";

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

/** One finding, numbered within its severity group. `file`/`line` are shown here now — no longer implied by a per-file group header, since the grouping key is severity. */
function FindingItem({ finding, number, reviewId, repositoryId }: { finding: FindingDoc; number: number; reviewId?: string; repositoryId?: string }) {
  const CategoryIcon = CATEGORY_ICON[finding.category];
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="shrink-0 text-xs font-semibold tabular-nums text-subtle">{number})</span>
        <span className="inline-flex items-center gap-1 text-xs text-subtle">
          <CategoryIcon className="h-3 w-3" aria-hidden="true" />
          {finding.category}
        </span>
        <span className="truncate font-mono text-xs text-subtle" title={finding.file}>
          {finding.file}
          {finding.line ? `:${finding.line}` : ""}
        </span>
      </div>
      <p className="mt-1.5 text-sm font-medium text-foreground">
        {finding.title}
        {finding.source === "static-analysis" && (
          <span className="ml-2 border border-border px-1.5 py-0.5 align-middle text-[10px] font-medium tracking-wide text-subtle uppercase">
            Static analysis
          </span>
        )}
      </p>
      <p className="mt-2 text-sm leading-relaxed text-muted">{finding.explanation}</p>
      <p className="mt-2 text-xs text-subtle">{evidenceLabel(finding)}</p>
      {finding.verification?.status === "accepted" && <p className="mt-1 text-xs text-muted">Assessment: {finding.verification.reason}</p>}
      {finding.verification?.evidence.map((evidence, index) => <p key={index} className="mt-1 break-words font-mono text-xs text-muted">{evidence.file}:{evidence.line} — {evidence.quote}</p>)}
      {finding.proof && <details className="mt-2 text-xs text-muted"><summary className="cursor-pointer">Regression test: {finding.proof.status}</summary>
        <p className="mt-1">{finding.proof.reason}</p>
        <pre className="mt-1 overflow-x-auto">{JSON.stringify({ base: finding.proof.baseSha, head: finding.proof.headSha, ...finding.proof.test }, null, 2)}</pre>
      </details>}
      {reviewId && repositoryId && <FindingFeedback reviewId={reviewId} repositoryId={repositoryId} findingId={findingId(finding)} value={finding.feedback?.label} />}
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
    </li>
  );
}

/**
 * One severity's findings behind a native disclosure — a "folder" for High,
 * Medium, and so on. Closed by default, no exceptions: a review with two
 * dozen findings across five severities should land as five compact rows,
 * not everything already unfurled.
 */
function SeverityGroup({ severity, findings, reviewId, repositoryId }: { severity: FindingDoc["severity"]; findings: FindingDoc[]; reviewId?: string; repositoryId?: string }) {
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
            <FindingItem key={i} finding={finding} number={i + 1} reviewId={reviewId} repositoryId={repositoryId} />
          ))}
        </ul>
      </details>
    </li>
  );
}

/** Per-severity counts as compact text, e.g. "2 critical · 1 high · 3 medium" — lets a developer triage a review without reading every finding. */
function SeverityStrip({ findings }: { findings: FindingDoc[] }) {
  if (findings.length === 0) return null;

  const counts = SEVERITY_ORDER.map((severity) => ({
    severity,
    count: findings.filter((f) => f.severity === severity).length,
  })).filter((entry) => entry.count > 0);

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      {counts.map(({ severity, count }) => (
        <span
          key={severity}
          className={`inline-flex items-center gap-1.5 text-xs font-medium ${toneTextClasses(SEVERITY_TONE[severity])}`}
        >
          <span className={toneDotClasses(SEVERITY_TONE[severity])} />
          {count} {severity}
        </span>
      ))}
    </div>
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

export function ReviewCard({
  review,
  pullRequest,
  defaultOpen,
  accordionName,
  repositoryId,
}: {
  review: ReviewDoc;
  pullRequest: PullRequestDoc | undefined;
  defaultOpen: boolean;
  /** Cards with the same name behave as an exclusive native accordion. */
  accordionName?: string;
  /** Omit to hide the delete action (e.g. contexts without ownership scoping already established). */
  repositoryId?: string;
}) {
  const findings = visibleFindings(review);
  const feedback = feedbackStats(findings);
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
          <SeverityStrip findings={findings} />

          {!hasReviewDetails && (
            <p className="py-5 text-sm leading-6 text-muted">
              {review.status === "pending"
                ? "This review is still being processed. Results will appear here when it completes."
                : "This review completed without additional findings or summary details."}
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

          {severityGroups.length > 0 && (
            <ul className="mt-4 divide-y divide-border border-t border-border">
              {severityGroups.map((group) => (
                <SeverityGroup key={group.severity} severity={group.severity} findings={group.findings} reviewId={String(review._id)} repositoryId={repositoryId} />
              ))}
            </ul>
          )}

          {review.metrics && <MetricsStrip metrics={review.metrics} />}
          {(feedback.assessed > 0 || feedback.duplicate > 0) && <p className="mt-3 text-xs text-muted">
            Rated findings: {feedback.correct} correct · {feedback.falsePositive} false positives · {feedback.duplicate} duplicates.
            {feedback.falsePositiveRate !== null && ` False-positive rate in this rated sample: ${Math.round(feedback.falsePositiveRate * 100)}% (${feedback.assessed} assessed).`}
          </p>}
          {review.verificationCheckpoint && <p className="mt-3 text-xs text-subtle">
            Verification: {review.verificationCheckpoint.candidates} candidates · {review.verificationCheckpoint.usage.calls} extra calls · {review.verificationCheckpoint.usage.totalTokens} reported tokens · {review.verificationCheckpoint.rejected.length} rejected.
          </p>}
          {!!review.verificationCheckpoint?.rejected.length && <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer">Rejected findings ({review.verificationCheckpoint.rejected.length})</summary>
            <ul className="mt-2 space-y-2">{review.verificationCheckpoint.rejected.map((finding, index) => <li key={index}>{finding.file}: {finding.title} — {finding.verification?.reason}</li>)}</ul>
          </details>}
          {!!review.riskFiles?.length && <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer">Sensitive changes prioritized ({review.riskFiles.length})</summary>
            <ul className="mt-2 space-y-1">{review.riskFiles.map((risk) => <li key={risk.file}>{risk.file}: {risk.reasons.join(", ")}</li>)}</ul>
          </details>}
        </div>
      </details>
    </li>
  );
}
