/** Route-level loading skeleton for the draft-review detail page (two field cards). */
export default function DraftDetailLoading() {
  return (
    <div className="space-y-6 max-w-4xl animate-pulse" aria-busy="true" aria-label="Loading draft">
      {/* Title + status badge */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <div className="h-7 w-40 rounded-md bg-muted" />
          <div className="h-4 w-64 max-w-full rounded bg-muted" />
        </div>
        <div className="h-6 w-24 rounded-full bg-muted" />
      </div>
      {/* Extracted fields + source quotes cards */}
      <div className="grid grid-cols-2 gap-6">
        {Array.from({ length: 2 }).map((_, c) => (
          <div key={c} className="space-y-4 rounded-lg border p-6">
            <div className="h-5 w-36 rounded bg-muted" />
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="h-3 w-24 rounded bg-muted" />
                <div className="h-4 w-40 max-w-full rounded bg-muted" />
              </div>
            ))}
          </div>
        ))}
      </div>
      {/* Action buttons */}
      <div className="flex items-center gap-3">
        <div className="h-9 w-28 rounded-md bg-muted" />
        <div className="h-9 w-28 rounded-md bg-muted" />
      </div>
    </div>
  )
}
