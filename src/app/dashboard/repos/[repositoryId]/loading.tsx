export default function RepositoryReviewsLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl" role="status" aria-live="polite">
      <span className="sr-only">Loading reviews…</span>
      <div className="animate-pulse">
        <div className="h-4 w-24 rounded bg-border" />
        <div className="mt-3 h-6 w-64 rounded bg-border" />

        <div className="mt-6 space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-border p-5">
              <div className="flex items-center justify-between gap-4">
                <div className="h-4 w-1/2 rounded bg-border" />
                <div className="h-4 w-16 rounded bg-border" />
              </div>
              <div className="mt-4 space-y-2 border-t border-border pt-3">
                <div className="h-3 w-full rounded bg-border" />
                <div className="h-3 w-5/6 rounded bg-border" />
                <div className="h-3 w-2/3 rounded bg-border" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
