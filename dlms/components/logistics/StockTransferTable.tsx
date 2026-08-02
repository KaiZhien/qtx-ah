'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { TransferStatusPill } from './TransferStatusPill'
import { loadMoreStockTransfersAction } from '@/app/(platform)/logistics/transfers/actions'
import type {
  StockTransferFilter, StockTransferListItem,
} from '@/modules/logistics/services/stockTransferService'

type Props = {
  initialItems: StockTransferListItem[]
  initialCursor: string | null
  filter: StockTransferFilter
}

function formatDate(d: Date | string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Same keyset "Load more" shape as DeliveryOrderTable. */
export function StockTransferTable({ initialItems, initialCursor, filter }: Props) {
  const [items, setItems] = useState(initialItems)
  const [cursor, setCursor] = useState(initialCursor)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function loadMore() {
    if (!cursor) return
    setError(null)
    startTransition(async () => {
      const res = await loadMoreStockTransfersAction({ ...filter, cursor })
      if ('error' in res) { setError(res.error); return }
      setItems((prev) => [...prev, ...res.items])
      setCursor(res.nextCursor)
    })
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Transfer</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Route</TableHead>
              <TableHead className="text-right">Lines</TableHead>
              <TableHead>Raised</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  No stock transfers match these filters.
                </TableCell>
              </TableRow>
            ) : (
              items.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <Link
                      href={`/logistics/transfers/${t.id}`}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {t.transferNo}
                    </Link>
                  </TableCell>
                  <TableCell><TransferStatusPill status={t.status} /></TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 text-sm">
                      {t.fromLocationName}
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-label="to" />
                      {t.toLocationName}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">{t.lineCount}</TableCell>
                  <TableCell>{formatDate(t.createdAt)}</TableCell>
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
