import { getExpiringWarrantyCount } from '@/lib/services/deviceService'
import { getPendingDraftCount } from '@/lib/services/draftService'
import { getUpcomingServiceCount } from '@/lib/services/serviceScheduleService'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertTriangle, FileSearch, Wrench } from 'lucide-react'
import Link from 'next/link'

export async function NotificationBanners() {
  const [warrantyCount, draftCount, serviceCount] = await Promise.all([
    getExpiringWarrantyCount(),
    getPendingDraftCount(),
    getUpcomingServiceCount(7),
  ])

  if (warrantyCount === 0 && draftCount === 0 && serviceCount === 0) return null

  return (
    <div className="space-y-2 mb-4">
      {warrantyCount > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <strong>{warrantyCount}</strong> device{warrantyCount !== 1 ? 's have' : ' has'} warranty
            expiring within 7 days.{' '}
            <Link href="/legacy/devices?sort=ship_date&dir=asc" className="underline font-medium">
              View devices →
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {serviceCount > 0 && (
        <Alert className="border-orange-400 text-orange-700 bg-orange-50">
          <Wrench className="h-4 w-4" />
          <AlertDescription>
            <strong>{serviceCount}</strong> device{serviceCount !== 1 ? 's are' : ' is'} due for
            service within 7 days.{' '}
            <Link href="/legacy/devices" className="underline font-medium">
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
            <Link href="/legacy/drafts" className="underline font-medium">
              Review drafts →
            </Link>
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}
