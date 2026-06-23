import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { AlertTriangle } from 'lucide-react'
import Link from 'next/link'

interface WarrantyBannerProps {
  count: number
}

export function WarrantyBanner({ count }: WarrantyBannerProps) {
  if (count === 0) return null
  return (
    <Alert variant="warning">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Warranty Expiring Soon</AlertTitle>
      <AlertDescription>
        {count} device{count !== 1 ? 's' : ''} {count !== 1 ? 'have' : 'has'} warranty expiring within the next 7 days.{' '}
        <Link
          href="/devices?sort=warranty_expiry&dir=asc"
          className="underline font-medium hover:opacity-80"
        >
          Sort by expiry date
        </Link>
      </AlertDescription>
    </Alert>
  )
}
