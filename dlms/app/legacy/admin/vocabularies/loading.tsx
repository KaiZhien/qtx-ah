/** Route-level loading skeleton for vocabulary management (Status/Phase sections). */
export default function VocabulariesLoading() {
  return (
    <div className="space-y-8 max-w-2xl animate-pulse" aria-busy="true" aria-label="Loading vocabularies">
      {/* Title + subtitle */}
      <div className="space-y-2">
        <div className="h-8 w-64 rounded-md bg-muted" />
        <div className="h-4 w-96 max-w-full rounded bg-muted" />
      </div>
      {/* Status + Phase sections */}
      {Array.from({ length: 2 }).map((_, s) => (
        <div key={s} className="space-y-3">
          <div className="h-5 w-32 rounded bg-muted border-b" />
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 rounded border p-2">
                <div className="h-4 w-32 rounded bg-muted" />
                <div className="h-4 w-24 rounded bg-muted" />
                <div className="ml-auto h-5 w-16 rounded-full bg-muted" />
              </div>
            ))}
          </div>
          <div className="h-9 w-40 rounded-md bg-muted" />
        </div>
      ))}
    </div>
  )
}
