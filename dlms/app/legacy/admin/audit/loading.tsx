/** Route-level loading skeleton for the audit-log table. */
export default function AuditLoading() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading audit log">
      {/* Title + subtitle */}
      <div className="space-y-2">
        <div className="h-8 w-40 rounded-md bg-muted" />
        <div className="h-4 w-56 rounded bg-muted" />
      </div>
      {/* Table */}
      <div className="rounded-md border">
        <div className="h-10 border-b bg-muted/50" />
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b px-4 py-3 last:border-0">
            <div className="h-4 w-36 rounded bg-muted" />
            <div className="h-4 w-40 rounded bg-muted" />
            <div className="h-4 w-16 rounded bg-muted" />
            <div className="h-4 w-24 rounded bg-muted" />
            <div className="h-4 w-20 rounded bg-muted" />
            <div className="h-4 w-28 rounded bg-muted" />
          </div>
        ))}
      </div>
      {/* Pagination */}
      <div className="flex items-center justify-between">
        <div className="h-4 w-48 rounded bg-muted" />
        <div className="flex items-center gap-2">
          <div className="h-10 w-10 rounded-md bg-muted" />
          <div className="h-4 w-24 rounded bg-muted" />
          <div className="h-10 w-10 rounded-md bg-muted" />
        </div>
      </div>
    </div>
  )
}
