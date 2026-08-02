import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import {
  listDeviceUsage, listUsageLoggableDevices,
} from '@/modules/maintenance/services/usageService'
import { daysSinceLastReading } from '@/modules/maintenance/domain/usageReadings'
import { LogUsageForm } from './LogUsageForm'
import { UsageResetBadge } from './UsageResetBadge'

type Props = {
  deviceId: string
}

function formatDate(d: string | null): string {
  if (!d) return '—'
  // Parsed at UTC noon rather than midnight: `new Date('2026-08-01')` is UTC
  // midnight, which formats as July 31 anywhere west of Greenwich. Noon is far
  // enough from both boundaries that the calendar date survives any offset.
  return new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

/**
 * Device profile Usage tab (spec §6.3).
 *
 * THE GATE IS THE SAME TRAP THE COMPONENTS PANEL CARRIES, POINTING THE OTHER
 * WAY. The device profile's own gate is `view_records` on MANUFACTURING, but
 * everything below reads Maintenance's `usage_record` through a service that
 * calls `authorize(actor, 'view_records', 'maintenance')` and THROWS on a
 * denial rather than returning empty. So a manufacturing-only user reaching this
 * tab is a 500, not a hidden section — hence the explicit check here, before any
 * service call. Manufacturing access does not imply Maintenance access, exactly
 * as Maintenance access does not imply Manufacturing access on the repair page.
 */
export async function DeviceUsageTab({ deviceId }: Props) {
  const actor = await requireActor()
  if (!can(actor, 'view_records', 'maintenance')) {
    return (
      <p className="rounded-md border p-4 text-sm text-muted-foreground">
        Usage records are part of Maintenance, which you don&apos;t have access to.
      </p>
    )
  }

  const usage = await listDeviceUsage(actor, deviceId)
  if (!usage) {
    return (
      <p className="rounded-md border p-4 text-sm text-muted-foreground">
        No usage records for this device.
      </p>
    )
  }

  const { items, summary } = usage
  const canLog = can(actor, 'log_usage_service', 'maintenance')
  const today = new Date()
  const todayIso = today.toISOString().slice(0, 10)
  const age = daysSinceLastReading(summary.latestRecordedOn, today)
  const devices = canLog ? await listUsageLoggableDevices(actor) : []

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-2 gap-x-8 gap-y-4 rounded-md border p-4 sm:grid-cols-4">
        <Stat
          label="Counter now"
          value={summary.currentCounter?.toLocaleString() ?? '—'}
          hint={summary.latestRecordedOn
            ? `read ${formatDate(summary.latestRecordedOn)}${age !== null ? ` · ${age}d ago` : ''}`
            : 'never read'}
        />
        <Stat
          label="Since last reset"
          value={summary.hasReset ? summary.sessionsSinceReset.toLocaleString() : '—'}
          hint={summary.hasReset ? 'on the current counter' : 'counter never reset'}
        />
        <Stat
          // "At least" is not hedging — a reset makes the sessions between the
          // last pre-reset reading and zero unknowable, so this is a lower bound.
          label={summary.hasReset ? 'Lifetime (at least)' : 'Lifetime sessions'}
          value={summary.totalSessions.toLocaleString()}
          hint={summary.hasReset
            ? `${summary.resetCount} reset${summary.resetCount === 1 ? '' : 's'} — sessions lost at each`
            : 'measured end to end'}
        />
        <Stat label="Readings" value={String(summary.readingCount)} hint="append-only" />
      </dl>

      {summary.hasReset && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="font-medium">Counter reset detected.</span>{' '}
          This device&apos;s counter went backwards {summary.resetCount}{' '}
          time{summary.resetCount === 1 ? '' : 's'}. Lifetime sessions are a lower bound: the
          sessions run between the last reading before each reset and the counter reaching zero
          were never observed.
        </p>
      )}

      {canLog && (
        <details className="rounded-md border p-4">
          <summary className="cursor-pointer text-sm font-medium text-slate-900">
            Log a reading
          </summary>
          <div className="mt-4">
            <LogUsageForm devices={devices} presetDeviceId={deviceId} todayIso={todayIso} />
          </div>
        </details>
      )}

      {items.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          No readings recorded for this device yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Read on</th>
                <th className="p-3 font-medium">Counter</th>
                <th className="p-3 font-medium">Change</th>
                <th className="p-3 font-medium">Source</th>
                <th className="p-3 font-medium">Entered by</th>
                <th className="p-3 font-medium">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((u) => (
                <tr key={u.id} className="hover:bg-muted/50">
                  <td className="whitespace-nowrap p-3">{formatDate(u.recordedOn)}</td>
                  <td className="p-3 font-medium text-slate-900">
                    {u.cumulativeSessions.toLocaleString()}
                  </td>
                  <td className="p-3">
                    {u.isReset
                      ? <UsageResetBadge />
                      : <span className="text-slate-700">{u.delta > 0 ? `+${u.delta.toLocaleString()}` : '—'}</span>}
                  </td>
                  <td className="p-3 text-slate-700">{u.source}</td>
                  <td className="p-3 text-slate-700">{u.enteredByName ?? '—'}</td>
                  <td className="max-w-xs truncate p-3 text-slate-700">{u.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold text-slate-900">{value}</dd>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}
