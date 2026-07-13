/** Route-level loading skeleton for component traceability (dimension selector + rollup groups). */
export default function TraceabilityLoading() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading traceability">
      {/* Title + subtitle */}
      <div className="space-y-2">
        <div className="h-8 w-64 rounded-md bg-muted" />
        <div className="h-4 w-96 max-w-full rounded bg-muted" />
      </div>
      {/* Dimension selector */}
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-9 w-32 rounded-md bg-muted" />
        ))}
      </div>
      {/* Rollup group cards */}
      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 rounded-md border p-4">
            <div className="h-4 w-32 rounded bg-muted" />
            <div className="h-4 w-16 rounded bg-muted" />
            <div className="ml-auto h-8 w-24 rounded-md bg-muted" />
          </div>
        ))}
      </div>
    </div>
  )
}
