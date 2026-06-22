import { Badge } from '@/components/ui/badge'
import type { BadgeProps } from '@/components/ui/badge'

const STATUS_VARIANT: Record<string, BadgeProps['variant']> = {
  'Shipped':       'success',
  'In Production': 'info',
  'In Stock':      'warning',
  'Returned':      'destructive',
  'Retired':       'gray',
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
