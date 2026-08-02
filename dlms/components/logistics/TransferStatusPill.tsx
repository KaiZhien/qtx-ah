import { Badge, type BadgeProps } from '@/components/ui/badge'
import type { StockTransferStatus } from '@/modules/logistics/domain/transferStatus'

// Mirrors DoStatusPill: color is reinforcement only, label text always renders
// (spec §8.1: "no color-only status signaling").
export const TRANSFER_STATUS_LABELS: Record<StockTransferStatus, string> = {
  draft: 'Draft',
  dispatched: 'In transit',
  received: 'Received',
  cancelled: 'Cancelled',
}

const STATUS_VARIANT: Record<StockTransferStatus, BadgeProps['variant']> = {
  draft: 'secondary',
  dispatched: 'info',
  received: 'success',
  cancelled: 'gray',
}

export function TransferStatusPill({ status }: { status: StockTransferStatus }) {
  return (
    <Badge variant={STATUS_VARIANT[status] ?? 'outline'}>
      {TRANSFER_STATUS_LABELS[status] ?? status}
    </Badge>
  )
}
