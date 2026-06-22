import { GROUP_LABELS, FIELD_LABELS } from '@/lib/i18n/fields'
import type { DeviceRow } from '@/lib/types'

interface DeviceGroupSectionProps {
  groupKey: string
  device: DeviceRow
  showEmpty?: boolean
}

function formatValue(value: unknown): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return String(value)
}

export function DeviceGroupSection({ groupKey, device, showEmpty = true }: DeviceGroupSectionProps) {
  const group = GROUP_LABELS.find((g) => g.key === groupKey)
  if (!group) return null

  const rows = group.fields
    .map((fieldKey) => ({
      fieldKey,
      label: FIELD_LABELS[fieldKey],
      value: (device as Record<string, unknown>)[fieldKey],
    }))
    .filter((row) => showEmpty || (row.value != null && row.value !== ''))

  return (
    <div className="space-y-3">
      <div className="border-b pb-1">
        <h3 className="font-semibold text-sm">{group.en}</h3>
        <p className="text-xs text-muted-foreground">{group.zh}</p>
      </div>
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {rows.map(({ fieldKey, label, value }) => (
          <div key={fieldKey} className="flex flex-col gap-0.5">
            <dt className="text-xs font-medium text-foreground">{label?.en ?? fieldKey}</dt>
            <dt className="text-xs text-muted-foreground/70">{label?.zh}</dt>
            <dd className="text-sm mt-0.5 whitespace-pre-wrap break-words">{formatValue(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
