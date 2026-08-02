import { ShieldCheck } from 'lucide-react'
import { WarrantyStatusPill } from '@/components/finance/WarrantyStatusPill'
import { WarrantyDialog } from '@/components/finance/WarrantyDialog'
import { RemoveWarrantyButton } from '@/components/finance/RemoveWarrantyButton'
import type { WarrantyRecord } from '@/modules/finance/services/warrantyService'

type Props = {
  deviceId: string
  /** The one live warranty, or null when the device has none. */
  warranty: WarrantyRecord | null
  /** Superseded rows, newest first — empty unless the warranty has been renewed. */
  history: WarrantyRecord[]
  canManage: boolean
}

/** 'YYYY-MM-DD' -> '01 Jan 2026'. Sliced, never round-tripped through a Date. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function formatIso(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  return m ? `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso
}

function coverSentence(w: WarrantyRecord): string {
  if (w.status === 'expired') {
    return `Expired ${formatIso(w.endDate)} (${Math.abs(w.daysRemaining)} days ago).`
  }
  if (!w.inForce) return `Cover starts ${formatIso(w.startDate)} — not yet in force.`
  if (w.daysRemaining === 0) return 'Last day of cover — a claim opened today is still covered.'
  return `${w.daysRemaining} days of cover remaining.`
}

/**
 * The device profile's warranty panel (spec §8.2 Post-sales tab).
 *
 * Server component: the status it renders is DERIVED at read time by
 * warrantyService against the database's clock, so this renders the answer, it
 * does not compute one. Do not memoize or cache this across a day boundary — see
 * the migration header on why there is no stored status.
 *
 * A device with no warranty row shows "No warranty", NOT an inferred window. The
 * legacy DLMS derived `ship_date + 2 years` for every shipped device; carrying
 * that forward would put a commitment nobody made on a customer's record.
 */
export function DeviceWarrantyPanel({ deviceId, warranty, history, canManage }: Props) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <ShieldCheck className="h-5 w-5 text-slate-400" aria-hidden="true" />
        <h3 className="text-base font-semibold text-slate-900">Warranty</h3>
        <WarrantyStatusPill
          status={warranty?.status ?? 'none'}
          daysRemaining={warranty?.daysRemaining ?? null}
        />
        {canManage && (
          <div className="ml-auto flex gap-2">
            {warranty ? (
              <>
                <WarrantyDialog mode="edit" deviceId={deviceId} warranty={warranty} />
                <WarrantyDialog mode="renew" deviceId={deviceId} warranty={warranty} />
                <RemoveWarrantyButton
                  deviceId={deviceId} warrantyId={warranty.id} version={warranty.version} />
              </>
            ) : (
              <WarrantyDialog mode="create" deviceId={deviceId} />
            )}
          </div>
        )}
      </div>

      {warranty ? (
        <>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 rounded-md border p-4 sm:grid-cols-3">
            <Field label="Start date" value={formatIso(warranty.startDate)} />
            <Field label="End date" value={formatIso(warranty.endDate)} />
            <Field label="Cover" value={coverSentence(warranty)} />
            <div className="sm:col-span-3">
              <dt className="text-xs font-medium text-muted-foreground">Terms</dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-900">
                {warranty.terms ?? '—'}
              </dd>
            </div>
          </dl>

          {history.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-medium text-muted-foreground">
                Superseded warranties
              </h4>
              <ul className="space-y-1 rounded-md border p-3 text-sm text-slate-600">
                {history.map((h) => (
                  <li key={h.id} className="flex flex-wrap gap-x-3">
                    <span>{formatIso(h.startDate)} → {formatIso(h.endDate)}</span>
                    {h.terms && <span className="text-muted-foreground">· {h.terms}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          No warranty is recorded for this device. Nothing is inferred from the ship date —
          if this device is covered, register the warranty so the dates are on the record.
        </p>
      )}
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
