'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import type { VocabOption } from '@/modules/manufacturing/services/deviceReadService'

type DeviceFiltersProps = {
  statusOptions: VocabOption[]
  variantOptions: VocabOption[]
}

function parseList(v: string | null): Set<string> {
  return new Set((v ?? '').split(',').filter(Boolean))
}

/**
 * Search box (debounced 300ms) + status/variant multiselect + needs-review
 * toggle, all reflected in the URL's search params — same convention as
 * TaskList (components/tasks/TaskList.tsx) — so every filter combination is a
 * plain server refetch through devices/page.tsx, with no client-side device
 * cache to keep in sync.
 */
export function DeviceFilters({ statusOptions, variantOptions }: DeviceFiltersProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [q, setQ] = useState(searchParams.get('q') ?? '')
  const selectedStatus = parseList(searchParams.get('status'))
  const selectedVariant = parseList(searchParams.get('variant'))
  const needsReview = searchParams.get('review') === '1'

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (value) params.set(key, value)
    else params.delete(key)
    router.push(`${pathname}?${params.toString()}`)
  }

  // Debounce the search box: push to the URL 300ms after typing stops, rather
  // than on every keystroke, so the server list doesn't refetch mid-word.
  useEffect(() => {
    const current = searchParams.get('q') ?? ''
    if (q === current) return
    const handle = setTimeout(() => setParam('q', q), 300)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  function toggle(param: 'status' | 'variant', current: Set<string>, code: string) {
    const next = new Set(current)
    if (next.has(code)) next.delete(code)
    else next.add(code)
    setParam(param, Array.from(next).join(','))
  }

  return (
    <div className="space-y-3">
      <div className="relative max-w-sm">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by serial number…"
          className="pl-9"
          aria-label="Search devices by serial number"
        />
      </div>

      <div className="flex flex-wrap items-start gap-6">
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-muted-foreground">Status</legend>
          <div className="flex max-w-md flex-wrap gap-x-3 gap-y-1">
            {statusOptions.map((s) => (
              <label key={s.code} className="flex items-center gap-1.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="rounded border-gray-300"
                  checked={selectedStatus.has(s.code)}
                  onChange={() => toggle('status', selectedStatus, s.code)}
                />
                {s.label}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-muted-foreground">Variant</legend>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {variantOptions.map((v) => (
              <label key={v.code} className="flex items-center gap-1.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="rounded border-gray-300"
                  checked={selectedVariant.has(v.code)}
                  onChange={() => toggle('variant', selectedVariant, v.code)}
                />
                {v.label}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="flex items-center gap-2 self-center text-sm text-slate-700">
          <input
            type="checkbox"
            className="rounded border-gray-300"
            checked={needsReview}
            onChange={(e) => setParam('review', e.target.checked ? '1' : '')}
          />
          Needs review
        </label>
      </div>
    </div>
  )
}
