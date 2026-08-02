import { Badge, type BadgeProps } from '@/components/ui/badge'
import { modificationStatusLabel } from '@/modules/maintenance/domain/modificationStatus'

// Coarse colour grouping for the five-state modification lifecycle (spec §6.3).
// Colour is reinforcement only — the label text is always rendered, so the pill
// still reads correctly without colour (spec §8.1: "no colour-only status
// signaling"). Mirrors RepairStatusPill, including `completed` taking the same
// "waiting on a human" warning tone repair gives awaiting_sign_off: they are the
// same position in their respective graphs.
const STATUS_VARIANT: Record<string, BadgeProps['variant']> = {
  requested: 'secondary',
  approved: 'info',
  completed: 'warning',
  closed: 'success',
  cancelled: 'gray',
}

export function ModificationStatusPill({ status }: { status: string }) {
  return <Badge variant={STATUS_VARIANT[status] ?? 'outline'}>{modificationStatusLabel(status)}</Badge>
}
