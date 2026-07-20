import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { getDeliveryOrder } from '@/modules/logistics/services/deliveryOrderService'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { DoStatusPill } from '@/components/logistics/DoStatusPill'
import { DoStatusChangeControl } from '@/components/logistics/DoStatusChangeControl'
import { DeliveryOrderEditDialog } from '@/components/logistics/DeliveryOrderEditDialog'

type PageProps = { params: { id: string } }

function formatDate(d: Date | string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatDateTime(d: Date | string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * Delivery order detail (Basic Logistics scope). getDeliveryOrder's null
 * return IS the 404 — unknown or soft-deleted ids and permission denials
 * both resolve to notFound() so neither confirms whether a record exists
 * (spec §7.3) — same pattern as manufacturing/devices/[id]/page.tsx.
 */
export default async function DeliveryOrderDetailPage({ params }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'view_records', 'logistics')) notFound()

  const deliveryOrder = await getDeliveryOrder(actor, params.id)
  if (!deliveryOrder) notFound()

  const canEdit = can(actor, 'edit_records', 'logistics')

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-900">{deliveryOrder.doNo}</h1>
          <DoStatusPill status={deliveryOrder.status} />
          {canEdit && (
            <div className="ml-auto">
              <DeliveryOrderEditDialog key={deliveryOrder.version} deliveryOrder={deliveryOrder} />
            </div>
          )}
        </div>
        {canEdit && (
          <div className="mt-3">
            <DoStatusChangeControl
              deliveryOrderId={deliveryOrder.id}
              version={deliveryOrder.version}
              currentStatus={deliveryOrder.status}
            />
          </div>
        )}
      </div>

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 rounded-md border p-4 sm:grid-cols-2">
        <Field label="Customer" value={deliveryOrder.customer ?? '—'} />
        <Field label="Destination" value={deliveryOrder.destination ?? '—'} />
        <Field label="Carrier" value={deliveryOrder.carrier ?? '—'} />
        <Field label="Import/export doc ref" value={deliveryOrder.importExportRef ?? '—'} />
        <Field label="Ship date" value={formatDate(deliveryOrder.shipDate)} />
        <Field label="Delivered date" value={formatDate(deliveryOrder.deliveredDate)} />
        <div className="sm:col-span-2">
          <dt className="text-xs font-medium text-muted-foreground">Notes</dt>
          <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-900">
            {deliveryOrder.notes ?? '—'}
          </dd>
        </div>
      </dl>

      <div className="rounded-md border p-4">
        <h2 className="text-sm font-medium text-slate-900">Proof of delivery</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Reference fields only — POD documents are not uploaded in this build.
        </p>
        <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
          <Field label="POD reference" value={deliveryOrder.podReference ?? '—'} />
          <Field label="POD received at" value={formatDateTime(deliveryOrder.podReceivedAt)} />
        </dl>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium text-slate-900">Lines</h2>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Device</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveryOrder.lines.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                    No line items.
                  </TableCell>
                </TableRow>
              ) : (
                deliveryOrder.lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>{l.lineNo}</TableCell>
                    <TableCell>{l.description ?? '—'}</TableCell>
                    <TableCell>{l.deviceSn ?? '—'}</TableCell>
                    <TableCell className="text-right">{l.quantity}</TableCell>
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
