import { Badge, type BadgeProps } from '@/components/ui/badge'
import {
  warrantyStatusLabel, type WarrantyStatus,
} from '@/modules/finance/domain/warrantyStatus'

/**
 * Carries forward the legacy DLMS warranty signal (yellow / red row icons) as a
 * labelled pill. Color is reinforcement ONLY — the label text is always rendered
 * (spec §8.1 accessibility: "no color-only status signaling"), which the legacy
 * icon-only treatment failed.
 */
const STATUS_VARIANT: Record<WarrantyStatus, BadgeProps['variant']> = {
  active: 'success',
  expiring_soon: 'warning',
  expired: 'destructive',
  none: 'gray',
}

export function WarrantyStatusPill({
  status, daysRemaining,
}: { status: WarrantyStatus; daysRemaining?: number | null }) {
  const suffix =
    status === 'expiring_soon' && typeof daysRemaining === 'number'
      ? ` · ${daysRemaining === 0 ? 'today' : `${daysRemaining}d`}`
      : ''
  return <Badge variant={STATUS_VARIANT[status]}>{warrantyStatusLabel(status)}{suffix}</Badge>
}
