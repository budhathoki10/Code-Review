import { Skeleton } from "@/components/skeleton";

export default function RepositoriesLoading() {
  return (
    <div className="w-full max-w-5xl" role="status" aria-live="polite">
      <span className="sr-only">Loading repositories…</span>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-10 w-full sm:w-64" />
      </div>

      <div className="mt-6 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3.5">
            <Skeleton className="h-9 w-9 shrink-0" />
            <div className="min-w-0 flex-1">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="mt-2 h-3 w-1/4" />
            </div>
            <Skeleton className="h-4 w-16 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}
