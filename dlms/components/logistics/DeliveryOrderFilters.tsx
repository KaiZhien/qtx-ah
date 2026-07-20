'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { DO_STATUSES } from '@/modules/logistics/domain/doStatus'
import { DO_STATUS_LABELS } from './DoStatusPill'

function parseList(v: string | null): Set<string> {
  return new Set((v ?? '').split(',').filter(Boolean))
}

/**
 * Status multiselect, reflected in the URL's search params — same convention
 * as components/manufacturing/DeviceFilters.tsx, simplified: DO status is a
 * fixed five-value list (modules/logistics/domain/doStatus.ts), not a
 * server-fetched vocabulary, so no options prop is needed.
 */
export function DeliveryOrderFilters() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const selectedStatus = parseList(searchParams.get('status'))

  function toggle(code: string) {
    const next = new Set(selectedStatus)
    if (next.has(code)) next.delete(code)
    else next.add(code)
    const params = new URLSearchParams(searchParams.toString())
    const value = Array.from(next).join(',')
    if (value) params.set('status', value)
    else params.delete('status')
    router.push(`${pathname}?${params.toString()}`)
  }

  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs font-medium text-muted-foreground">Status</legend>
      <div className="flex max-w-md flex-wrap gap-x-3 gap-y-1">
        {DO_STATUSES.map((s) => (
          <label key={s} className="flex items-center gap-1.5 text-sm text-slate-700">
            <input
              type="checkbox"
              className="rounded border-gray-300"
              checked={selectedStatus.has(s)}
              onChange={() => toggle(s)}
            />
            {DO_STATUS_LABELS[s]}
          </label>
        ))}
      </div>
    </fieldset>
  )
}
