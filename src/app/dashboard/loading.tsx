export default function DashboardLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl" role="status" aria-live="polite">
      <span className="sr-only">Loading repositories…</span>
      <div className="animate-pulse">
        <div className="flex items-center justify-between gap-4">
          <div className="h-6 w-48 rounded bg-border" />
          <div className="h-10 w-40 rounded-md bg-border" />
        </div>

        <div className="mt-6 divide-y divide-border rounded-lg border border-border">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between gap-4 px-4 py-3.5">
              <div className="h-4 w-1/3 rounded bg-border" />
              <div className="h-4 w-4 rounded bg-border" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
