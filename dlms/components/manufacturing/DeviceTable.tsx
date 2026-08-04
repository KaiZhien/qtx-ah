'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DeviceStatusPill } from './StatusPill'
import { loadMoreDevicesAction } from '@/app/(platform)/manufacturing/devices/actions'
import { callFailed } from '@/components/platform/callFailed'
import type { DeviceFilter, DeviceListItem } from '@/modules/manufacturing/services/deviceReadService'

type DeviceTableProps = {
  initialItems: DeviceListItem[]
  initialCursor: string | null
  filter: DeviceFilter
}

function formatDate(d: Date | string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * The device registry table. Serial column shows device_sn when present;
 * otherwise the legacy PCBA-A serial in muted italic type alongside a "needs
 * review" chip (spec §5.5 risk R-5 — legacy ranged serials are searchable and
 * flagged, never split). "Load more" accumulates pages client-side by calling
 * back through the same keyset cursor listDevices used server-side, so paging
 * never repeats or skips a row even as new devices are created mid-session.
 */
export function DeviceTable({ initialItems, initialCursor, filter }: DeviceTableProps) {
  const [items, setItems] = useState(initialItems)
  const [cursor, setCursor] = useState(initialCursor)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function loadMore() {
    if (!cursor) return
    setError(null)
    // The callback is async, so it must catch its own rejection: the action's
    // own failures come back as `{ error }`, but the INVOCATION can still reject
    // (expired session, dropped connection, stale action id after a redeploy) and
    // React rethrows that into the error boundary, losing every page already
    // accumulated in this table.
    startTransition(async () => {
      try {
        const res = await loadMoreDevicesAction({ ...filter, cursor })
        if ('error' in res) {
          setError(res.error)
          return
        }
        setItems((prev) => [...prev, ...res.items])
        setCursor(res.nextCursor)
      } catch (err) {
        setError(callFailed('device load-more', err))
      }
    })
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Serial number</TableHead>
              <TableHead>Variant</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Build date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No devices match these filters.
                </TableCell>
              </TableRow>
            ) : (
              items.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <Link
                      href={`/manufacturing/devices/${d.id}`}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {d.deviceSn ?? (
                        <span className="italic text-muted-foreground">
                          {d.legacySn ?? 'No serial'}
                        </span>
                      )}
                    </Link>
                    {d.needsDataReview && (
                      <Badge variant="warning" className="ml-2 align-middle text-[10px]">
                        Needs review
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell><Badge variant="outline">{d.variantName}</Badge></TableCell>
                  <TableCell><DeviceStatusPill status={d.status} label={d.statusLabel} /></TableCell>
                  <TableCell>{d.productName ?? '—'}</TableCell>
                  <TableCell>{d.customer ?? '—'}</TableCell>
                  <TableCell>{formatDate(d.buildDate)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {cursor && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={isPending}>
            {isPending ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  )
}
