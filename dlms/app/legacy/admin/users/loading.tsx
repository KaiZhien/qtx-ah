/** Route-level loading skeleton for the user-management table. */
export default function UsersLoading() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading users">
      {/* Title */}
      <div className="h-8 w-56 rounded-md bg-muted" />
      {/* Table */}
      <div className="rounded-md border">
        <div className="h-10 border-b bg-muted/50" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b px-4 py-3 last:border-0">
            <div className="h-4 w-56 rounded bg-muted" />
            <div className="h-4 w-20 rounded bg-muted" />
            <div className="h-4 w-16 rounded bg-muted" />
            <div className="h-4 w-24 rounded bg-muted" />
            <div className="ml-auto h-4 w-16 rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  )
}
