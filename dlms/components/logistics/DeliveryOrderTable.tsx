'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { DoStatusPill } from './DoStatusPill'
import { loadMoreDeliveryOrdersAction } from '@/app/(platform)/logistics/delivery-orders/actions'
import { callFailed } from '@/components/platform/callFailed'
import type {
  DeliveryOrderFilter, DeliveryOrderListItem,
} from '@/modules/logistics/services/deliveryOrderService'

type DeliveryOrderTableProps = {
  initialItems: DeliveryOrderListItem[]
  initialCursor: string | null
  filter: DeliveryOrderFilter
}

function formatDate(d: Date | string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * The delivery order list table. "Load more" accumulates pages client-side
 * through the same keyset cursor listDeliveryOrders used server-side — same
 * shape as components/manufacturing/DeviceTable.tsx.
 */
export function DeliveryOrderTable({ initialItems, initialCursor, filter }: DeliveryOrderTableProps) {
  const [items, setItems] = useState(initialItems)
  const [cursor, setCursor] = useState(initialCursor)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function loadMore() {
    if (!cursor) return
    setError(null)
    // The callback is async, so it must catch its own rejection — see
    // components/platform/callFailed.ts. Without it a transport failure escalates
    // to the error boundary and every accumulated page is lost.
    startTransition(async () => {
      try {
        const res = await loadMoreDeliveryOrdersAction({ ...filter, cursor })
        if ('error' in res) {
          setError(res.error)
          return
        }
        setItems((prev) => [...prev, ...res.items])
        setCursor(res.nextCursor)
      } catch (err) {
        setError(callFailed('delivery order load-more', err))
      }
    })
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>DO number</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Destination</TableHead>
              <TableHead>Ship date</TableHead>
              <TableHead>Carrier</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No delivery orders match these filters.
                </TableCell>
              </TableRow>
            ) : (
              items.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <Link
                      href={`/logistics/delivery-orders/${d.id}`}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {d.doNo}
                    </Link>
                  </TableCell>
                  <TableCell><DoStatusPill status={d.status} /></TableCell>
                  <TableCell>{d.customer ?? '—'}</TableCell>
                  <TableCell>{d.destination ?? '—'}</TableCell>
                  <TableCell>{formatDate(d.shipDate)}</TableCell>
                  <TableCell>{d.carrier ?? '—'}</TableCell>
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
