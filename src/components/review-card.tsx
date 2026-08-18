import { ChevronRight } from "lucide-react";
import type { FindingDoc, PullRequestDoc, ReviewDoc } from "@/lib/db/collections";
import { toneDotClasses, toneTextClasses, SEVERITY_ORDER, SEVERITY_TONE, type Tone } from "@/lib/ui";
import { Markdown } from "@/components/markdown";
import { DiffBlock } from "@/components/diff-block";

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
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={`inline-flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase ${toneTextClasses(tone)}`}
        >
          <span className={toneDotClasses(tone)} />
          {finding.severity}
        </span>
        <span className="text-xs text-subtle">· {finding.category}</span>
      </div>
      <p className="mt-1.5 text-sm font-medium text-foreground">
        {finding.title}
        {finding.source === "static-analysis" && (
          <span className="ml-2 rounded border border-border px-1.5 py-0.5 align-middle text-[10px] font-medium tracking-wide text-subtle uppercase">
            Static analysis
          </span>
        )}
      </p>
      <p className="mt-1 font-mono text-xs text-subtle">
        {finding.file}
        {finding.line ? `:${finding.line}` : ""}
      </p>
      <p className="mt-2 text-sm leading-relaxed text-muted">{finding.explanation}</p>
      {finding.suggestion && <DiffBlock diff={finding.suggestion} className="mt-3" />}
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
}: {
  review: ReviewDoc;
  pullRequest: PullRequestDoc | undefined;
  defaultOpen: boolean;
}) {
  return (
    <li>
      <details open={defaultOpen} className="group rounded-lg border border-border">
        <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-4 [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 items-center gap-2">
            <ChevronRight
              className="h-3.5 w-3.5 shrink-0 text-subtle transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            <span className="truncate text-sm font-medium text-foreground">
              {pullRequest ? `#${pullRequest.githubPrNumber} — ${pullRequest.title}` : "Unknown PR"}
            </span>
          </span>
          <div className="flex shrink-0 items-center gap-4">
            {review.verdict && <VerdictBadge verdict={review.verdict} />}
            <StatusBadge status={review.status} />
          </div>
        </summary>

        <div className="border-t border-border px-5 pb-5">
          <SeverityStrip findings={review.findings} />

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

          {review.findings.length > 0 && (
            <ul className="mt-4 divide-y divide-border border-t border-border">
              {review.findings.map((finding, i) => (
                <FindingItem key={i} finding={finding} />
              ))}
            </ul>
          )}
        </div>
      </details>
    </li>
  );
}
