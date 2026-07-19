import { Badge, type BadgeProps } from '@/components/ui/badge'

// Coarse color grouping for the ten-status lifecycle (spec §5.2). Any status
// code this map doesn't recognize — including future admin-added vocabulary —
// falls back to a neutral outline rather than crashing, since status_option is
// admin-editable and this pill must never assume it has seen every code.
const STATUS_VARIANT: Record<string, BadgeProps['variant']> = {
  in_production: 'secondary',
  quality_check: 'secondary',
  in_stock: 'info',
  ready_for_delivery: 'info',
  shipped: 'info',
  delivered: 'success',
  active: 'success',
  under_repair: 'warning',
  returned: 'warning',
  retired: 'gray',
  scrapped: 'gray',
}

/**
 * Device status pill. Color is reinforcement only — the label text is always
 * rendered, so the pill still reads correctly without color (spec §8.1
 * accessibility: "no color-only status signaling").
 */
export function DeviceStatusPill({ status, label }: { status: string; label: string }) {
  return <Badge variant={STATUS_VARIANT[status] ?? 'outline'}>{label}</Badge>
}
