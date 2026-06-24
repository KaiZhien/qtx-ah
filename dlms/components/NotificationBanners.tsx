import { getExpiringWarrantyCount } from '@/lib/services/deviceService'
import { getPendingDraftCount } from '@/lib/services/draftService'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertTriangle, FileSearch } from 'lucide-react'
import Link from 'next/link'

export async function NotificationBanners() {
  const [warrantyCount, draftCount] = await Promise.all([
    getExpiringWarrantyCount(),
    getPendingDraftCount(),
  ])

  if (warrantyCount === 0 && draftCount === 0) return null

  return (
    <div className="space-y-2 mb-4">
      {warrantyCount > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <strong>{warrantyCount}</strong> device{warrantyCount !== 1 ? 's have' : ' has'} warranty
            expiring within 7 days.{' '}
            <Link href="/devices?sort=ship_date&dir=asc" className="underline font-medium">
              View devices →
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {draftCount > 0 && (
        <Alert>
          <FileSearch className="h-4 w-4" />
          <AlertDescription>
            <strong>{draftCount}</strong> draft{draftCount !== 1 ? 's are' : ' is'} pending review.{' '}
            <Link href="/drafts" className="underline font-medium">
              Review drafts →
            </Link>
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}
