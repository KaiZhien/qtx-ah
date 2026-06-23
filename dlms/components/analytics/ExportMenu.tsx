'use client'
import { Button } from '@/components/ui/button'
import type { AnalyticsRange } from '@/lib/types'

export function ExportMenu({ range }: { range: AnalyticsRange }) {
  function download(format: 'xlsx' | 'pdf') {
    window.location.href = `/analytics/export?format=${format}&range=${range}`
  }

  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={() => download('xlsx')}>
        Export Excel
      </Button>
      <Button variant="outline" size="sm" onClick={() => download('pdf')}>
        Export PDF
      </Button>
    </div>
  )
}
