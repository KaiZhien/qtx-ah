/** Route-level loading skeleton for the CSV/Excel import page (upload card). */
export default function ImportLoading() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading import">
      {/* Title */}
      <div className="space-y-2">
        <div className="h-8 w-48 rounded-md bg-muted" />
        <div className="h-4 w-80 max-w-full rounded bg-muted" />
      </div>
      {/* Upload dropzone card */}
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
        <div className="h-8 w-8 rounded bg-muted" />
        <div className="h-4 w-56 rounded bg-muted" />
        <div className="h-9 w-32 rounded-md bg-muted" />
      </div>
    </div>
  )
}
