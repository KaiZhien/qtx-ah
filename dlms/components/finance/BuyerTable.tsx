'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { loadMoreBuyersAction } from '@/app/(platform)/finance/buyers/actions'
import { callFailed } from '@/components/platform/callFailed'
import type { BuyerFilter, BuyerListItem } from '@/modules/finance/services/buyerService'

type BuyerTableProps = {
  initialItems: BuyerListItem[]
  initialCursor: string | null
  filter: BuyerFilter
}

/**
 * The buyer list table. "Load more" accumulates pages client-side by calling
 * back through the same keyset cursor listBuyers used server-side — same
 * convention as manufacturing/DeviceTable.tsx.
 */
export function BuyerTable({ initialItems, initialCursor, filter }: BuyerTableProps) {
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
        const res = await loadMoreBuyersAction({ ...filter, cursor })
        if ('error' in res) {
          setError(res.error)
          return
        }
        setItems((prev) => [...prev, ...res.items])
        setCursor(res.nextCursor)
      } catch (err) {
        setError(callFailed('buyer load-more', err))
      }
    })
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Country</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Phone</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  No buyers match this search.
                </TableCell>
              </TableRow>
            ) : (
              items.map((b) => (
                <TableRow key={b.id}>
                  <TableCell>
                    <Link href={`/finance/buyers/${b.id}`} className="font-medium text-slate-900 hover:underline">
                      {b.name}
                    </Link>
                  </TableCell>
                  <TableCell>{b.country ?? '—'}</TableCell>
                  <TableCell>{b.contactName ?? '—'}</TableCell>
                  <TableCell>{b.contactEmail ?? '—'}</TableCell>
                  <TableCell>{b.contactPhone ?? '—'}</TableCell>
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
