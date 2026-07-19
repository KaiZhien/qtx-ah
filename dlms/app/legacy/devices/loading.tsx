/** Route-level loading skeleton for the device list (§ mirrors DeviceTable layout). */
export default function DevicesLoading() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading devices">
      {/* Title */}
      <div className="h-8 w-40 rounded-md bg-muted" />
      {/* Filter bar */}
      <div className="flex flex-wrap gap-2">
        <div className="h-9 w-64 rounded-md bg-muted" />
        <div className="h-9 w-32 rounded-md bg-muted" />
        <div className="h-9 w-32 rounded-md bg-muted" />
        <div className="h-9 w-32 rounded-md bg-muted" />
      </div>
      {/* Table */}
      <div className="rounded-md border">
        <div className="h-10 border-b bg-muted/50" />
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b px-4 py-3 last:border-0">
            <div className="h-4 w-28 rounded bg-muted" />
            <div className="h-4 w-40 rounded bg-muted" />
            <div className="h-4 w-24 rounded bg-muted" />
            <div className="h-4 w-16 rounded bg-muted" />
            <div className="h-4 w-20 rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  )
}
