/** Route-level loading skeleton for the extraction-drafts list. */
export default function DraftsLoading() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading drafts">
      {/* Title + upload action */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <div className="h-8 w-56 rounded-md bg-muted" />
          <div className="h-4 w-80 max-w-full rounded bg-muted" />
        </div>
        <div className="h-9 w-40 rounded-md bg-muted" />
      </div>
      {/* Draft cards */}
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 rounded-md border p-4">
            <div className="h-5 w-5 rounded bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-48 rounded bg-muted" />
              <div className="h-3 w-64 max-w-full rounded bg-muted" />
            </div>
            <div className="h-5 w-24 rounded-full bg-muted" />
            <div className="h-8 w-16 rounded-md bg-muted" />
          </div>
        ))}
      </div>
    </div>
  )
}
