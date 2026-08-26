import type { CSSProperties } from "react";
import { Bug, ChevronRight, FlaskConical, ShieldAlert, Sparkles, Zap } from "lucide-react";
import type { FindingDoc, PullRequestDoc, ReviewDoc } from "@/lib/db/collections";
import { toneDotClasses, toneTextClasses, SEVERITY_ORDER, SEVERITY_TONE, type Tone } from "@/lib/ui";
import { visibleFindings, groupFindingsByFile } from "@/lib/review/review-display";
import { Markdown } from "@/components/markdown";
import { DiffBlock } from "@/components/diff-block";
import { DeleteReviewButton } from "@/app/dashboard/repos/[repositoryId]/delete-review-button";

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

function FindingItem({ finding }: { finding: FindingDoc }) {
  const tone = SEVERITY_TONE[finding.severity];
  const CategoryIcon = CATEGORY_ICON[finding.category];
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={`inline-flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase ${toneTextClasses(tone)}`}
        >
          <span className={toneDotClasses(tone)} />
          {finding.severity}
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-subtle">
          <CategoryIcon className="h-3 w-3" aria-hidden="true" />
          {finding.category}
        </span>
        {finding.line && <span className="font-mono text-xs text-subtle">· line {finding.line}</span>}
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
      {finding.suggestion && <DiffBlock diff={finding.suggestion} file={finding.file} className="mt-3" />}
    </li>
  );
}

/** A file this round reviewed and found nothing in — same row shape as FindingGroup below, minus the disclosure (there's nothing to expand into). */
function CleanFileRow({ file, index }: { file: string; index: number }) {
  return (
    <li className="stagger-in" style={{ "--index": index } as CSSProperties}>
      <div className="flex items-center gap-2 py-2.5 text-muted">
        <span className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className={toneDotClasses("success")} aria-hidden="true" />
        <span className="truncate font-mono text-xs text-foreground" title={file}>
          {file}
        </span>
        <span className="shrink-0 text-xs text-subtle">No issues</span>
      </div>
    </li>
  );
}

/** One file's findings behind a native disclosure — open by default only when it contains a critical/high finding, so a large review still lands scannable. */
function FindingGroup({
  file,
  findings,
  defaultOpen,
  index,
}: {
  file: string;
  findings: FindingDoc[];
  defaultOpen: boolean;
  index: number;
}) {
  if (findings.length === 0) return <CleanFileRow file={file} index={index} />;

  const worstTone = SEVERITY_TONE[findings[0].severity];
  return (
    <li className="stagger-in" style={{ "--index": index } as CSSProperties}>
      <details open={defaultOpen} className="group/file">
        <summary className="flex cursor-pointer list-none items-center gap-2 py-2.5 text-muted transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
          <ChevronRight
            className="h-3 w-3 shrink-0 text-subtle transition-transform duration-200 group-open/file:rotate-90"
            aria-hidden="true"
          />
          <span className={toneDotClasses(worstTone)} aria-hidden="true" />
          <span className="truncate font-mono text-xs text-foreground" title={file}>
            {file}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-subtle">{findings.length}</span>
        </summary>
        <ul className="divide-y divide-border border-t border-border pl-5">
          {findings.map((finding, i) => (
            <FindingItem key={i} finding={finding} />
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
  const fileGroups = groupFindingsByFile(findings, review.touchedFiles);
  const hasReviewDetails = Boolean(
    review.summary ||
      fileGroups.length > 0 ||
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

          {review.status === "failed" && review.error && (
            <div className="mt-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2">
              <p className="text-xs font-medium text-danger">
                Failed after {review.error.attempts} attempt{review.error.attempts === 1 ? "" : "s"}
              </p>
              <p className="mt-0.5 font-mono text-xs text-muted">{review.error.message}</p>
            </div>
          )}

          {fileGroups.length > 0 && (
            <ul className="mt-4 divide-y divide-border border-t border-border">
              {fileGroups.map((group, i) => (
                <FindingGroup
                  key={group.file}
                  file={group.file}
                  findings={group.findings}
                  defaultOpen={group.worst <= 1}
                  index={i}
                />
              ))}
            </ul>
          )}
        </div>
      </details>
    </li>
  );
}
