import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ShieldCheck } from 'lucide-react'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import {
  getExpiringWarranties, getWarrantyExpiryCounts, EXPIRY_WINDOWS, type ExpiryWindow,
} from '@/modules/finance/services/warrantyService'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { WarrantyStatusPill } from '@/components/finance/WarrantyStatusPill'

type PageProps = { searchParams: { within?: string } }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** 'YYYY-MM-DD' -> '01 Jan 2026', sliced. Never round-tripped through a Date. */
function formatIso(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  return m ? `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso
}

function parseWindow(raw: string | undefined): ExpiryWindow {
  const n = Number(raw)
  return (EXPIRY_WINDOWS as readonly number[]).includes(n) ? (n as ExpiryWindow) : 30
}

/**
 * The warranty expiry radar (spec §8.5 "warranties expiring 30/60/90 d"),
 * carrying forward the legacy DLMS yellow/red expiry signal as a real screen.
 *
 * Gated on view_records within the finance module, matching warrantyService's
 * read gate — NOT on view_finance, which is the money gate. A Viewer with
 * Finance access can see which warranties are running out; they still cannot see
 * an invoice.
 */
export default async function WarrantiesPage({ searchParams }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'view_records', 'finance')) notFound()

  const within = parseWindow(searchParams.within)
  const [counts, items] = await Promise.all([
    getWarrantyExpiryCounts(actor),
    getExpiringWarranties(actor, { withinDays: within, limit: 200 }),
  ])
  const countFor: Record<ExpiryWindow, number> = {
    30: counts.within30, 60: counts.within60, 90: counts.within90,
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <ShieldCheck className="h-7 w-7 text-slate-400" aria-hidden="true" />
        <h1 className="text-2xl font-semibold text-slate-900">Warranty expiry</h1>
      </div>
      <p className="text-slate-600">
        Warranty status is derived from the recorded dates every time this page loads — nothing is
        stored, so nothing here can be stale. Devices with no warranty record are absent by design;
        no cover is inferred from a ship date.
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {EXPIRY_WINDOWS.map((w) => (
          <Link
            key={w}
            href={`/finance/warranties?within=${w}`}
            aria-current={w === within ? 'page' : undefined}
            className={`rounded-md border p-4 hover:bg-slate-50 ${
              w === within ? 'border-slate-900 ring-1 ring-slate-900' : ''}`}
          >
            <p className="text-2xl font-semibold text-slate-900">{countFor[w]}</p>
            <p className="text-xs text-muted-foreground">Expiring within {w} days</p>
          </Link>
        ))}
        <div className="rounded-md border p-4">
          <p className="text-2xl font-semibold text-slate-900">{counts.expired}</p>
          <p className="text-xs text-muted-foreground">Already expired</p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        The three windows are cumulative — the 90-day count includes the 30- and 60-day ones. All
        three exclude warranties that have already expired.
      </p>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Device</TableHead>
              <TableHead>Cover</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead className="text-right">Days left</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                  No warranties expire in the next {within} days.
                </TableCell>
              </TableRow>
            ) : items.map((w) => (
              <TableRow key={w.warrantyId}>
                <TableCell>
                  <Link href={`/manufacturing/devices/${w.deviceId}`} className="hover:underline">
                    {w.deviceSn ?? w.deviceId}
                  </Link>
                </TableCell>
                <TableCell className="text-sm text-slate-600">
                  {formatIso(w.startDate)} → {formatIso(w.endDate)}
                </TableCell>
                <TableCell>{formatIso(w.endDate)}</TableCell>
                <TableCell className="text-right">{w.daysRemaining}</TableCell>
                <TableCell>
                  <WarrantyStatusPill status={w.status} daysRemaining={w.daysRemaining} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
