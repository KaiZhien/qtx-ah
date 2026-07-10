/** Route-level loading skeleton for the device detail page (title, badges, tabs, group cards). */
export default function DeviceDetailLoading() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading device">
      {/* Title + status badges + actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-8 w-56 rounded-md bg-muted" />
          <div className="h-6 w-20 rounded-full bg-muted" />
          <div className="h-6 w-20 rounded-full bg-muted" />
        </div>
        <div className="flex gap-2">
          <div className="h-9 w-20 rounded-md bg-muted" />
          <div className="h-9 w-20 rounded-md bg-muted" />
        </div>
      </div>
      {/* Tabs */}
      <div className="flex gap-2">
        <div className="h-9 w-24 rounded-md bg-muted" />
        <div className="h-9 w-28 rounded-md bg-muted" />
        <div className="h-9 w-28 rounded-md bg-muted" />
        <div className="h-9 w-24 rounded-md bg-muted" />
      </div>
      {/* Field-group cards */}
      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-3 rounded-lg border p-6">
            <div className="h-5 w-36 rounded bg-muted" />
            <div className="h-4 w-full rounded bg-muted" />
            <div className="h-4 w-3/4 rounded bg-muted" />
            <div className="h-4 w-1/2 rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  )
}
