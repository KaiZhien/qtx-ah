import { notFound } from 'next/navigation'
import { ArrowRight } from 'lucide-react'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { getStockTransfer } from '@/modules/logistics/services/stockTransferService'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { TransferStatusPill } from '@/components/logistics/TransferStatusPill'
import { TransferStatusChangeControl } from '@/components/logistics/TransferStatusChangeControl'

type PageProps = { params: { id: string } }

function formatDateTime(d: Date | string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * Stock transfer detail, including the receive action.
 *
 * getStockTransfer's null return IS the 404 — unknown/soft-deleted ids and
 * permission denials both resolve to notFound() so neither confirms whether a
 * record exists (spec §7.3).
 */
export default async function StockTransferDetailPage({ params }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'view_records', 'logistics')) notFound()

  const transfer = await getStockTransfer(actor, params.id)
  if (!transfer) notFound()

  const canEdit = can(actor, 'edit_records', 'logistics')

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-900">{transfer.transferNo}</h1>
          <TransferStatusPill status={transfer.status} />
        </div>
        <p className="mt-2 inline-flex items-center gap-2 text-sm text-slate-700">
          <span className="font-medium">{transfer.fromLocationName}</span>
          <span className="text-muted-foreground">({transfer.fromLocationCode})</span>
          <ArrowRight className="h-4 w-4 text-muted-foreground" aria-label="to" />
          <span className="font-medium">{transfer.toLocationName}</span>
          <span className="text-muted-foreground">({transfer.toLocationCode})</span>
        </p>
        {canEdit && (
          <div className="mt-3">
            <TransferStatusChangeControl
              stockTransferId={transfer.id}
              version={transfer.version}
              currentStatus={transfer.status}
              fromLocationName={transfer.fromLocationName}
              toLocationName={transfer.toLocationName}
            />
          </div>
        )}
      </div>

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 rounded-md border p-4 sm:grid-cols-2">
        <Field label="Raised by" value={transfer.initiatedByName ?? '—'} />
        <Field label="Carrier" value={transfer.carrier ?? '—'} />
        <Field label="Dispatched at" value={formatDateTime(transfer.dispatchedAt)} />
        <Field label="Received at" value={formatDateTime(transfer.receivedAt)} />
        <Field label="Reference" value={transfer.reference ?? '—'} />
        <div className="sm:col-span-2">
          <dt className="text-xs font-medium text-muted-foreground">Notes</dt>
          <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-900">{transfer.notes ?? '—'}</dd>
        </div>
      </dl>

      <div>
        <h2 className="mb-2 text-sm font-medium text-slate-900">Lines</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          {transfer.status === 'received'
            ? 'Stock has been posted for these lines.'
            : 'No stock has moved yet — balances change when this transfer is received.'}
        </p>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Component</TableHead>
                <TableHead>Serial</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transfer.lines.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    No line items.
                  </TableCell>
                </TableRow>
              ) : (
                transfer.lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>{l.lineNo}</TableCell>
                    <TableCell>
                      <Badge variant={l.kind === 'serialized' ? 'info' : 'secondary'}>
                        {l.kind === 'serialized' ? 'Serialized' : 'Batch'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="font-medium text-slate-900">{l.componentTypeName ?? '—'}</span>
                      {l.componentTypeCode && (
                        <span className="ml-1.5 text-muted-foreground">{l.componentTypeCode}</span>
                      )}
                    </TableCell>
                    <TableCell>{l.serialNo ?? '—'}</TableCell>
                    <TableCell className="text-right">{l.qty ?? '—'}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{value}</dd>
    </div>
  )
}
