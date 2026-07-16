import { Badge } from '@/components/ui/badge'
import type { BadgeProps } from '@/components/ui/badge'

// Keyed by status_option codes — both the seed.sql set (Stock/Repair) and the
// codes actually live in the cloud vocabulary (In Stock/Under Repair/Shipped),
// which drifted from the seed. Admin-added statuses fall back to 'outline'.
const STATUS_VARIANT: Record<string, BadgeProps['variant']> = {
  'Stock':        'warning',
  'In Stock':     'warning',
  'In Use':       'success',
  'Repair':       'info',
  'Under Repair': 'info',
  'Shipped':      'success',
  'Retired':      'gray',
  'Lost':         'destructive',
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
