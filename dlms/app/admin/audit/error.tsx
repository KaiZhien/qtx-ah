'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { AlertTriangle } from 'lucide-react'

export default function AuditError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('Audit route error:', error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-md border py-16 text-center">
      <AlertTriangle className="h-8 w-8 text-muted-foreground" />
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Couldn&apos;t load the audit log</h2>
        <p className="text-sm text-muted-foreground">
          Something went wrong while loading the audit entries. Your data is safe.
        </p>
      </div>
      <Button variant="outline" onClick={() => reset()}>
        Try again
      </Button>
    </div>
  )
}
