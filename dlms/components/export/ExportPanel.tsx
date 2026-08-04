'use client'

import { useState } from 'react'
import { Download, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * The download control for the full-system export.
 *
 * A PLAIN LINK-STYLE NAVIGATION, not a fetch-and-blob. The archive is streamed by
 * a route handler and can be tens of megabytes; buffering it into memory in the
 * browser to make a blob URL is the kind of thing that works on the developer's
 * seed data and dies on real data. Navigating lets the browser stream it to disk.
 *
 * The button cannot itself verify MFA freshness — only the server can, and it
 * does. This just sets expectations so a refusal is not a surprise.
 */
export function ExportPanel({ maxAgeSeconds }: { maxAgeSeconds: number }) {
  const [started, setStarted] = useState(false)
  const minutes = Math.round(maxAgeSeconds / 60)

  return (
    <section className="rounded-lg border bg-white p-4">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" aria-hidden="true" />
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-slate-700">Build and download</h2>
          <p className="mt-1 text-sm text-slate-600">
            Your two-factor code must have been entered in the last {minutes} minutes.
            If it has been longer, the download is refused — sign in again to refresh
            it, then come back.
          </p>

          <div className="mt-3">
            <Button asChild onClick={() => setStarted(true)}>
              <a href="/admin/export/download" download>
                <Download className="mr-2 h-4 w-4" aria-hidden="true" />
                Build export
              </a>
            </Button>
          </div>

          {started && (
            <p className="mt-3 text-sm text-slate-500" role="status">
              Building. The archive is assembled from a single consistent database
              snapshot, so a large system can take a moment. Your download will start
              when it is ready.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
