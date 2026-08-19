import { Skeleton } from "@/components/skeleton";

export default function DashboardLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl" role="status" aria-live="polite">
      <span className="sr-only">Loading dashboard…</span>

      <Skeleton className="h-2.5 w-32" />
      <Skeleton className="mt-3 h-8 w-56" />

      <div className="mt-7 grid grid-cols-1 overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="border-t border-border px-4 py-4 first:border-t-0 sm:border-t-0 sm:border-l sm:first:border-l-0 sm:px-6">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="mt-3 h-8 w-12" />
          </div>
        ))}
      </div>

      <div className="mt-12 border-b border-border pb-3">
        <Skeleton className="h-5 w-32" />
      </div>
      <div className="mt-5 space-y-3">
        <Skeleton className="h-4 w-40" />
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-16" />
          </div>
        </div>
      </div>
    </div>
  );
}
