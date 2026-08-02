import { Badge } from '@/components/ui/badge'
import { failureStatusLabel } from '@/modules/engineering/domain/failureStatus'

/**
 * FI status pill. Deliberately NOT EngStatusBadge: that component labels a
 * status by capitalizing its first character, which is correct for the
 * single-word ECR/ECO/firmware vocabularies but renders
 * "Root_cause_identified" for this one. The label always comes from the domain
 * (failureStatusLabel), and the word is always present — no colour-only status
 * signalling (spec §8.1).
 */
const STATUS_VARIANT: Record<string, 'outline' | 'info' | 'warning' | 'success' | 'gray'> = {
  open: 'outline',
  investigating: 'info',
  root_cause_identified: 'warning',
  corrective_action: 'warning',
  closed: 'success',
  cancelled: 'gray',
}

export function FailureStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={STATUS_VARIANT[status] ?? 'outline'}>{failureStatusLabel(status)}</Badge>
  )
}

const SEVERITY_VARIANT: Record<string, 'gray' | 'secondary' | 'warning' | 'destructive'> = {
  low: 'gray',
  normal: 'secondary',
  high: 'warning',
  critical: 'destructive',
}

export function SeverityBadge({ severity }: { severity: string }) {
  const label = severity.charAt(0).toUpperCase() + severity.slice(1)
  return <Badge variant={SEVERITY_VARIANT[severity] ?? 'secondary'}>{label}</Badge>
}
