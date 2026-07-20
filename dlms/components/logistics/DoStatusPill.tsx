import { Badge, type BadgeProps } from '@/components/ui/badge'
import type { DoStatus } from '@/modules/logistics/domain/doStatus'

// Mirrors components/manufacturing/StatusPill.tsx: color is reinforcement
// only, label text always renders (spec §8.1: "no color-only status
// signaling").
export const DO_STATUS_LABELS: Record<DoStatus, string> = {
  draft: 'Draft',
  prepared: 'Prepared',
  dispatched: 'Dispatched',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
}

const STATUS_VARIANT: Record<DoStatus, BadgeProps['variant']> = {
  draft: 'secondary',
  prepared: 'info',
  dispatched: 'info',
  delivered: 'success',
  cancelled: 'gray',
}

export function DoStatusPill({ status }: { status: DoStatus }) {
  return <Badge variant={STATUS_VARIANT[status] ?? 'outline'}>{DO_STATUS_LABELS[status] ?? status}</Badge>
}
