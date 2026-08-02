import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listStockLevels, getStockByLocation } from '@/modules/logistics/services/stockLevelService'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'

type PageProps = { searchParams: { location?: string; includeZero?: string } }

/**
 * Stock levels by location (spec §6.3).
 *
 * Batch-tracked component types ONLY. A serialized unit's whereabouts is
 * component_unit.location_id and is shown on the component itself, not here —
 * the two are separate on purpose so there is exactly one source of truth for
 * each kind of part.
 */
export default async function StockLevelsPage({ searchParams }: PageProps) {
  const actor = await requireActor()
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, 'view_records', 'logistics')) notFound()

  const includeZero = searchParams.includeZero === '1'
  const [byLocation, levels] = await Promise.all([
    getStockByLocation(actor),
    listStockLevels(actor, { locationId: searchParams.location, includeZero }),
  ])

  const selected = searchParams.location
  /** Rebuilds the whole query string from the two filters — no string surgery. */
  const hrefWith = (next: { location?: string; includeZero?: boolean }) => {
    const p = new URLSearchParams()
    const loc = 'location' in next ? next.location : selected
    const zero = 'includeZero' in next ? next.includeZero : includeZero
    if (loc) p.set('location', loc)
    if (zero) p.set('includeZero', '1')
    const q = p.toString()
    return `/logistics/stock${q ? `?${q}` : ''}`
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Stock levels</h1>
          <p className="mt-1 text-slate-600">
            Quantities of batch-tracked components held at each location.
          </p>
        </div>
        <Link href="/logistics/transfers" className="text-sm font-medium text-primary hover:underline">
          Stock transfers →
        </Link>
      </div>

      <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        Serialized components are not counted here — each one&rsquo;s location is recorded on the
        unit itself, so a part is never counted in two places.
      </p>

      <div className="rounded-md border">
        <div className="border-b p-4">
          <p className="text-sm font-medium text-slate-900">By location</p>
        </div>
        {byLocation.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No stock recorded at any location yet.</p>
        ) : (
          <div className="grid grid-cols-1 divide-x divide-y sm:grid-cols-2 lg:grid-cols-4">
            {byLocation.map((l) => (
              <Link
                key={l.locationId}
                href={`/logistics/stock?location=${l.locationId}`}
                className={`p-4 transition-colors hover:bg-muted/50 ${
                  selected === l.locationId ? 'bg-muted/60' : ''}`}
              >
                <p className="text-2xl font-semibold text-slate-900">{l.totalQty}</p>
                <p className="text-sm text-muted-foreground">{l.locationName}</p>
                <p className="text-xs text-muted-foreground">
                  {l.componentTypeCount} component type{l.componentTypeCount === 1 ? '' : 's'}
                </p>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        {selected && (
          <Link href={hrefWith({ location: undefined })} className="font-medium text-primary hover:underline">
            Clear location filter
          </Link>
        )}
        <Link href={hrefWith({ includeZero: !includeZero })} className="font-medium text-primary hover:underline">
          {includeZero ? 'Hide zero balances' : 'Show zero balances'}
        </Link>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Location</TableHead>
              <TableHead>Component type</TableHead>
              <TableHead>Code</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {levels.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  No stock levels to show.
                </TableCell>
              </TableRow>
            ) : (
              levels.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>{l.locationName}</TableCell>
                  <TableCell className="font-medium text-slate-900">{l.componentTypeName}</TableCell>
                  <TableCell className="text-muted-foreground">{l.componentTypeCode}</TableCell>
                  <TableCell className="text-right">{l.qty}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
