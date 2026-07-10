/** Route-level loading skeleton for the analytics dashboard (metric tiles + charts). */
export default function AnalyticsLoading() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading analytics">
      {/* Title + range selector */}
      <div className="flex items-center justify-between">
        <div className="h-8 w-40 rounded-md bg-muted" />
        <div className="h-9 w-48 rounded-md bg-muted" />
      </div>
      {/* Metric tiles */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-3 rounded-lg border p-6">
            <div className="h-4 w-24 rounded bg-muted" />
            <div className="h-8 w-16 rounded bg-muted" />
          </div>
        ))}
      </div>
      {/* Chart panels */}
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="space-y-4 rounded-lg border p-6">
            <div className="h-5 w-40 rounded bg-muted" />
            <div className="h-64 w-full rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  )
}
