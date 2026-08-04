'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { InvoiceStatusPill } from './InvoiceStatusPill'
import { loadMoreInvoicesAction } from '@/app/(platform)/finance/invoices/actions'
import { callFailed } from '@/components/platform/callFailed'
import type { InvoiceFilter, InvoiceListItem } from '@/modules/finance/services/invoiceService'

type InvoiceTableProps = {
  initialItems: InvoiceListItem[]
  initialCursor: string | null
  filter: InvoiceFilter
}

function formatDate(d: Date | string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * The sales invoice list table. "Load more" accumulates pages client-side by
 * calling back through the same keyset cursor listInvoices used server-side —
 * same convention as manufacturing/DeviceTable.tsx.
 */
export function InvoiceTable({ initialItems, initialCursor, filter }: InvoiceTableProps) {
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
        const res = await loadMoreInvoicesAction({ ...filter, cursor })
        if ('error' in res) {
          setError(res.error)
          return
        }
        setItems((prev) => [...prev, ...res.items])
        setCursor(res.nextCursor)
      } catch (err) {
        setError(callFailed('invoice load-more', err))
      }
    })
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Invoice no.</TableHead>
              <TableHead>Buyer</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Issue date</TableHead>
              <TableHead>Due date</TableHead>
              <TableHead className="text-right">Total (SGD)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No invoices match these filters.
                </TableCell>
              </TableRow>
            ) : (
              items.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>
                    <Link href={`/finance/invoices/${i.id}`} className="font-medium text-slate-900 hover:underline">
                      {i.invoiceNo}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/finance/buyers/${i.buyerId}`} className="hover:underline">{i.buyerName}</Link>
                  </TableCell>
                  <TableCell><InvoiceStatusPill status={i.status} /></TableCell>
                  <TableCell>{formatDate(i.issueDate)}</TableCell>
                  <TableCell>{formatDate(i.dueDate)}</TableCell>
                  <TableCell className="text-right">{i.totalSgd ? `S$${i.totalSgd}` : '—'}</TableCell>
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
