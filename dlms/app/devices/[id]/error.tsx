'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { AlertTriangle } from 'lucide-react'

export default function DeviceDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('Device detail route error:', error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-md border py-16 text-center">
      <AlertTriangle className="h-8 w-8 text-muted-foreground" />
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Couldn&apos;t load this device</h2>
        <p className="text-sm text-muted-foreground">
          Something went wrong while loading the device record. Your data is safe.
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => reset()}>
          Try again
        </Button>
        <Button variant="ghost" asChild>
          <Link href="/devices">Back to devices</Link>
        </Button>
      </div>
    </div>
  )
}
