/** Route-level loading skeleton for report-subscriber management (list + add form). */
export default function SubscribersLoading() {
  return (
    <div className="space-y-8 max-w-2xl animate-pulse" aria-busy="true" aria-label="Loading subscribers">
      {/* Title + subtitle */}
      <div className="space-y-2">
        <div className="h-8 w-56 rounded-md bg-muted" />
        <div className="h-4 w-80 max-w-full rounded bg-muted" />
      </div>
      {/* Subscriber list */}
      <div className="space-y-3">
        <div className="h-5 w-32 rounded bg-muted border-b" />
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 rounded border p-2">
              <div className="h-4 flex-1 rounded bg-muted" />
              <div className="h-4 w-20 rounded bg-muted" />
              <div className="h-5 w-16 rounded-full bg-muted" />
            </div>
          ))}
        </div>
        <div className="h-9 w-48 rounded-md bg-muted" />
      </div>
    </div>
  )
}
