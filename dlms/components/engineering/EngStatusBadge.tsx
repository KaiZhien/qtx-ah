import { Badge } from '@/components/ui/badge'

// Shared status colouring across ECR / ECO / firmware. All engineering statuses
// are single words, so the label is just the capitalized code. No colour-only
// signalling — the word is always present (spec §8.1 accessibility intent).
const VARIANT: Record<string, 'outline' | 'secondary' | 'success' | 'destructive' | 'info'> = {
  draft: 'outline',
  submitted: 'info',
  accepted: 'success',
  approved: 'success',
  implemented: 'success',
  released: 'success',
  rejected: 'destructive',
  withdrawn: 'destructive',
}

export function EngStatusBadge({ status }: { status: string }) {
  const label = status.charAt(0).toUpperCase() + status.slice(1)
  return <Badge variant={VARIANT[status] ?? 'outline'}>{label}</Badge>
}

const PRIORITY_VARIANT: Record<string, 'gray' | 'secondary' | 'warning' | 'destructive'> = {
  low: 'gray',
  normal: 'secondary',
  high: 'warning',
  urgent: 'destructive',
}

export function PriorityBadge({ priority }: { priority: string }) {
  const label = priority.charAt(0).toUpperCase() + priority.slice(1)
  return <Badge variant={PRIORITY_VARIANT[priority] ?? 'secondary'}>{label}</Badge>
}
