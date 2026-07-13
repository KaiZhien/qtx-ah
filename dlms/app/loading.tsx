/** Root loading skeleton for the dashboard (metric tiles + charts + recent activity). */
export default function DashboardLoading() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading dashboard">
      {/* Title */}
      <div className="space-y-2">
        <div className="h-8 w-40 rounded-md bg-muted" />
        <div className="h-4 w-64 rounded bg-muted" />
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
      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="space-y-4 rounded-lg border p-6">
            <div className="h-5 w-32 rounded bg-muted" />
            <div className="h-48 w-full rounded bg-muted" />
          </div>
        ))}
      </div>
      {/* Recent activity */}
      <div className="space-y-3 rounded-lg border p-6">
        <div className="h-5 w-36 rounded bg-muted" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-4 w-full rounded bg-muted" />
        ))}
      </div>
    </div>
  )
}
