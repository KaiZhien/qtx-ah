import { Badge, type BadgeProps } from '@/components/ui/badge'
import type { InvoiceStatus } from '@/modules/finance/domain/invoiceStatus'

// Coarse color grouping for the 4-state invoice flow (modules/finance/domain/
// invoiceStatus.ts), same convention as manufacturing/StatusPill.tsx.
const STATUS_VARIANT: Record<InvoiceStatus, BadgeProps['variant']> = {
  draft: 'secondary',
  issued: 'info',
  paid: 'success',
  void: 'gray',
}

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: 'Draft', issued: 'Issued', paid: 'Paid', void: 'Void',
}

/**
 * Invoice status pill. Color is reinforcement only — the label text is always
 * rendered (spec §8.1 accessibility: "no color-only status signaling").
 */
export function InvoiceStatusPill({ status }: { status: InvoiceStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>
}
