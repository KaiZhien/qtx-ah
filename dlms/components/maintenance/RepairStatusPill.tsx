import { Badge, type BadgeProps } from '@/components/ui/badge'
import { repairStatusLabel } from '@/modules/maintenance/domain/repairStatus'

// Coarse colour grouping for the six-state repair workflow (spec §5.3). Colour is
// reinforcement only — the label text is always rendered, so the pill still reads
// correctly without colour (spec §8.1: "no colour-only status signaling").
const STATUS_VARIANT: Record<string, BadgeProps['variant']> = {
  reported: 'secondary',
  in_diagnosis: 'info',
  in_repair: 'warning',
  testing: 'info',
  awaiting_sign_off: 'warning',
  closed: 'success',
  cancelled: 'gray',
}

export function RepairStatusPill({ status }: { status: string }) {
  return <Badge variant={STATUS_VARIANT[status] ?? 'outline'}>{repairStatusLabel(status)}</Badge>
}
