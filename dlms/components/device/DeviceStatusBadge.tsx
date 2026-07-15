import { Badge } from '@/components/ui/badge'
import type { BadgeProps } from '@/components/ui/badge'

// Keyed by the real seeded status_option codes. Admin-added statuses fall back
// to 'outline' via the ?? in StatusBadge.
const STATUS_VARIANT: Record<string, BadgeProps['variant']> = {
  'Stock':   'warning',
  'In Use':  'success',
  'Repair':  'info',
  'Retired': 'gray',
  'Lost':    'destructive',
}

const PHASE_VARIANT: Record<string, BadgeProps['variant']> = {
  'MP':  'default',
  'EVT': 'outline',
  'DVT': 'outline',
  'PVT': 'secondary',
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={STATUS_VARIANT[status] ?? 'outline'}>
      {status}
    </Badge>
  )
}

export function PhaseBadge({ phase }: { phase: string }) {
  return (
    <Badge variant={PHASE_VARIANT[phase] ?? 'outline'}>
      {phase}
    </Badge>
  )
}
