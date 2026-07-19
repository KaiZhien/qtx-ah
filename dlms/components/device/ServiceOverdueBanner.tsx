import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { Wrench } from 'lucide-react'
import Link from 'next/link'

interface ServiceOverdueBannerProps {
  count: number
}

export function ServiceOverdueBanner({ count }: ServiceOverdueBannerProps) {
  if (count === 0) return null
  return (
    <Alert variant="warning">
      <Wrench className="h-4 w-4" />
      <AlertTitle>Service Overdue</AlertTitle>
      <AlertDescription>
        {count} device{count !== 1 ? 's are' : ' is'} overdue for a service event.{' '}
        <Link
          href="/legacy/devices?serviceOverdue=1"
          className="underline font-medium hover:opacity-80"
        >
          View overdue devices
        </Link>
      </AlertDescription>
    </Alert>
  )
}
