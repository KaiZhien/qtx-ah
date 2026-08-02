import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import {
  listDeviceUsageSummaries, listUsageLoggableDevices, getUsageOverview,
} from '@/modules/maintenance/services/usageService'
import { LogUsageForm } from '@/components/maintenance/LogUsageForm'
import { UsageResetBadge } from '@/components/maintenance/UsageResetBadge'

type PageProps = { searchParams: { resets?: string } }

function formatDate(d: string | null): string {
  if (!d) return '—'
  // UTC noon, not midnight — see DeviceUsageTab.formatDate for why.
  return new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

/**
 * The usage register (spec §6.3): one row per device that has ever been read,
 * most recently read first, with the derived counter-reset warning and the
 * cumulative-since-reset total visible without opening anything.
 *
 * Every number on this page is DERIVED at read time from the append-only
 * `usage_record` rows — nothing here is a stored aggregate. See
 * modules/maintenance/domain/usageReadings.ts for why that is not an
 * optimisation waiting to happen.
 */
export default async function UsagePage({ searchParams }: PageProps) {
  const actor = await requireActor()
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, 'view_records', 'maintenance')) notFound()

  const resetsOnly = searchParams.resets === '1'
  const canLog = can(actor, 'log_usage_service', 'maintenance')
  const today = new Date()

  const [summaries, overview, devices] = await Promise.all([
    listDeviceUsageSummaries(actor, { resetsOnly }, today),
    getUsageOverview(actor),
    canLog ? listUsageLoggableDevices(actor) : Promise.resolve([]),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Usage</h1>
        <p className="mt-1 text-slate-600">
          Device session-counter readings — append-only, and non-monotonic where a counter was reset.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Tile label="Devices with readings" value={overview.deviceCount} />
        <Tile label="Readings recorded" value={overview.readingCount} />
        <Tile label="Devices with a counter reset" value={overview.devicesWithResets} />
      </div>

      <div className="flex flex-wrap gap-2">
        <FilterChip label="All devices" href="/maintenance/usage" active={!resetsOnly} />
        <FilterChip label="Counter reset detected" href="/maintenance/usage?resets=1" active={resetsOnly} />
      </div>

      {canLog && (
        <details className="rounded-md border p-4">
          <summary className="cursor-pointer text-sm font-medium text-slate-900">
            Log a reading
          </summary>
          <div className="mt-4">
            <LogUsageForm devices={devices} todayIso={today.toISOString().slice(0, 10)} />
          </div>
        </details>
      )}

      {summaries.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          {resetsOnly
            ? 'No device has a counter reset on record.'
            : 'No usage readings recorded yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Device</th>
                <th className="p-3 font-medium">Counter now</th>
                <th className="p-3 font-medium">Since last reset</th>
                <th className="p-3 font-medium">Lifetime</th>
                <th className="p-3 font-medium">Last read</th>
                <th className="p-3 font-medium">Readings</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {summaries.map((s) => (
                <tr key={s.deviceId} className="hover:bg-muted/50">
                  <td className="p-3">
                    <Link
                      href={`/manufacturing/devices/${s.deviceId}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {s.deviceSn ?? 'No serial'}
                    </Link>
                    {s.hasReset && <span className="ml-2 inline-block align-middle"><UsageResetBadge /></span>}
                  </td>
                  <td className="p-3 font-medium text-slate-900">
                    {s.currentCounter?.toLocaleString() ?? '—'}
                  </td>
                  <td className="p-3 text-slate-700">
                    {s.hasReset ? s.sessionsSinceReset.toLocaleString() : '—'}
                  </td>
                  <td className="p-3 text-slate-700">
                    {/* "≥" because a reset makes the true lifetime unknowable. */}
                    {s.hasReset ? '≥ ' : ''}{s.totalSessions.toLocaleString()}
                  </td>
                  <td className="whitespace-nowrap p-3 text-slate-700">
                    {formatDate(s.latestRecordedOn)}
                    {s.daysSinceLastReading !== null && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({s.daysSinceLastReading}d)
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-slate-700">{s.readingCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-4">
      <p className="text-2xl font-semibold text-slate-900">{value}</p>
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  )
}

function FilterChip({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-3 py-1 text-sm transition-colors ${
        active ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted'
      }`}
    >
      {label}
    </Link>
  )
}
