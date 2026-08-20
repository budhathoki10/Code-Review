import { Skeleton } from "@/components/skeleton";

export default function RepositoryReviewsLoading() {
  return (
    <div className="w-full max-w-5xl" role="status" aria-live="polite">
      <span className="sr-only">Loading reviews…</span>

      <Skeleton className="h-8 w-72" />

      <div className="mt-8 space-y-2.5">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-center justify-between gap-4">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-16" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
