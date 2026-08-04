import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import type { Actor } from '@/modules/shared/authz/catalog'
import {
  visibleSections, DASHBOARD_WIDGETS, type DashboardWidgetDef,
} from '@/modules/shared/reporting/domain/widgets'
import { AGING_BUCKETS } from '@/modules/shared/reporting/domain/aging'
import {
  getMyTasksWidget, getMyApprovalsWidget, getRecentActivityWidget,
  getDevicesByStatus, getDevicesByVariant, getImportsAwaitingConfirm,
  getActiveRepairsByState, getRepairsByRootCause, getDeliveriesDueThisWeek,
  getInvoicesPendingApproval, getUnpaidInvoices, getWarrantiesExpiring,
  getUserActivity, getFailedLogins, getJobQueueHealth,
} from '@/modules/shared/reporting/services/dashboardService'

const SECTION_LABELS: Record<string, string> = {
  home: 'Your work',
  manufacturing: 'Manufacturing',
  maintenance: 'Maintenance',
  logisticsFinance: 'Logistics & Finance',
  admin: 'Administration',
}

/**
 * The dashboards (spec §8.5).
 *
 * WIDGETS ARE RESOLVED FROM THE REGISTRY, not written out by hand. `visibleSections`
 * decides what this actor may see, and only those resolvers run — a widget the
 * actor cannot see costs no query, which is both the performance story and the
 * security one. A denied widget is ABSENT; there is no empty-card branch to fall
 * into, by construction.
 *
 * Widgets whose data source does not exist yet render their blocker instead of a
 * zero. A dashboard that says "0 warranties expiring" when the table has not been
 * created is a number an operator would act on.
 */
export default async function DashboardPage() {
  const actor = await requireActor()
  const sections = visibleSections(actor)

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
        <p className="mt-1 text-slate-600">
          Live counts across every section you can enter. Figures refresh at most
          once a minute.
        </p>
      </div>

      {sections.length === 0 && (
        <p className="text-sm text-slate-500">
          No sections are enabled for your account yet. Contact your Super Admin.
        </p>
      )}

      {sections.map((s) => (
        <section key={s.section}>
          <h2 className="text-lg font-semibold text-slate-900">
            {SECTION_LABELS[s.section] ?? s.section}
          </h2>
          <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {s.widgets.map((w) => (
              <Widget key={w.key} actor={actor} def={w} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function Card({ title, href, children }: {
  title: string; href?: string; children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border bg-white p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
        {href && (
          <Link href={href} className="text-xs text-blue-600 hover:underline">View</Link>
        )}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  )
}

const Big = ({ n, label }: { n: number | string; label: string }) => (
  <div>
    <p className="text-3xl font-semibold text-slate-900">{n}</p>
    <p className="text-xs text-slate-500">{label}</p>
  </div>
)

/** The honest placeholder for a widget whose data source does not exist yet. */
function Pending({ def }: { def: DashboardWidgetDef }) {
  return (
    <div className="rounded-md border border-dashed bg-slate-50 p-3">
      <p className="text-xs font-medium text-slate-600">Not available yet</p>
      <p className="mt-1 text-xs text-slate-500">{def.pendingOn}</p>
    </div>
  )
}

async function Widget({ actor, def }: { actor: Actor; def: DashboardWidgetDef }) {
  if (def.status === 'pending') {
    return <Card title={def.label}><Pending def={def} /></Card>
  }

  switch (def.key) {
    case 'myTasks': {
      const d = await getMyTasksWidget(actor)
      // `capped` is the ONE count in this dashboard that cannot be a SQL
      // COUNT(*) — the two-gate visibility rule is a pure TS function, so the
      // rows are scanned and filtered in JS. When the scan comes back full these
      // are floors, and the card says so with a "+" rather than asserting a
      // number it cannot stand behind.
      const suffix = d.capped ? '+' : ''
      return (
        <Card title={def.label} href="/tasks">
          <div className="flex gap-8">
            <Big n={`${d.overdue}${suffix}`} label="overdue" />
            <Big n={`${d.open}${suffix}`} label="open" />
          </div>
          <ul className="mt-3 space-y-1">
            {d.soonest.map((t) => (
              <li key={t.id} className="truncate text-sm">
                <Link href={`/tasks/${t.id}`} className="hover:underline">{t.title}</Link>
              </li>
            ))}
          </ul>
        </Card>
      )
    }

    case 'myApprovalsPending': {
      const d = await getMyApprovalsWidget(actor)
      return (
        <Card title={def.label} href="/approvals">
          <Big n={d.pending} label="waiting on you" />
        </Card>
      )
    }

    case 'recentActivity': {
      const d = await getRecentActivityWidget(actor)
      return (
        <Card title={def.label}>
          {d.rows.length === 0
            ? <p className="text-sm text-slate-500">Nothing recent.</p>
            : (
              <ul className="space-y-1 text-sm text-slate-600">
                {d.rows.slice(0, 5).map((r, i) => (
                  <li key={i} className="truncate">
                    {r.action} on {r.table.replace(/_/g, ' ')}
                  </li>
                ))}
              </ul>
            )}
        </Card>
      )
    }

    case 'devicesByStatus':
    case 'devicesByVariant': {
      const d = def.key === 'devicesByStatus'
        ? await getDevicesByStatus(actor)
        : await getDevicesByVariant(actor)
      const max = Math.max(1, ...d.map((r) => r.count))
      return (
        <Card title={def.label} href="/manufacturing/devices">
          <ul className="space-y-1">
            {d.map((r) => (
              <li key={r.code} className="flex items-center gap-2 text-sm">
                <span className="w-32 shrink-0 truncate text-slate-600">{r.label}</span>
                <span className="h-2 rounded bg-slate-300"
                  style={{ width: `${(r.count / max) * 60}%` }} aria-hidden="true" />
                <span className="tabular-nums text-slate-900">{r.count}</span>
              </li>
            ))}
          </ul>
        </Card>
      )
    }

    case 'importsAwaitingConfirm': {
      const d = await getImportsAwaitingConfirm(actor)
      return (
        <Card title={def.label} href="/manufacturing/import">
          <div className="flex gap-8">
            <Big n={d.batches} label="batches" />
            <Big n={d.rowsNeedingReview} label="rows need review" />
          </div>
        </Card>
      )
    }

    case 'activeRepairsByState': {
      const d = await getActiveRepairsByState(actor)
      return (
        <Card title={def.label} href="/maintenance/repairs">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500">
                <th className="text-left font-medium">State</th>
                {AGING_BUCKETS.map((b) => (
                  <th key={b} className="text-right font-medium">{b}d</th>
                ))}
                <th className="text-right font-medium">Oldest</th>
              </tr>
            </thead>
            <tbody>
              {d.map((r) => (
                <tr key={r.status}>
                  <td className="truncate text-slate-700">{r.label}</td>
                  {AGING_BUCKETS.map((b) => (
                    <td key={b} className="text-right tabular-nums text-slate-600">
                      {r.buckets[b] || '·'}
                    </td>
                  ))}
                  <td className="text-right tabular-nums text-slate-900">
                    {r.count > 0 ? `${r.oldestDays}d` : '·'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )
    }

    case 'repairsByRootCause': {
      const d = await getRepairsByRootCause(actor, 90)
      if (d === null) {
        return (
          <Card title={def.label}>
            <div className="rounded-md border border-dashed bg-slate-50 p-3">
              <p className="text-xs text-slate-500">
                Waiting on the Engineering failure/RCA tables.
              </p>
            </div>
          </Card>
        )
      }
      return (
        <Card title={def.label} href="/engineering/failures">
          {d.length === 0
            ? <p className="text-sm text-slate-500">Nothing classified in the last 90 days.</p>
            : (
              <ul className="space-y-1">
                {d.slice(0, 6).map((r) => (
                  <li key={r.code} className="flex justify-between gap-2 text-sm">
                    <span className="truncate text-slate-600">{r.label}</span>
                    <span className="tabular-nums text-slate-900">{r.count}</span>
                  </li>
                ))}
              </ul>
            )}
        </Card>
      )
    }

    case 'deliveriesDueThisWeek': {
      const d = await getDeliveriesDueThisWeek(actor)
      return (
        <Card title={def.label} href="/logistics/delivery-orders">
          <div className="flex gap-8">
            <Big n={d.dueThisWeek} label="due this week" />
            <Big n={d.overdue} label="overdue" />
          </div>
        </Card>
      )
    }

    case 'warrantiesExpiring': {
      const d = await getWarrantiesExpiring(actor)
      if (d === null) return <Card title={def.label}><Pending def={def} /></Card>
      // DISJOINT buckets, and the labels say so. FINANCE's windows are cumulative
      // (a warranty expiring in 20 days is in all three of theirs); rendering
      // those raw under "30 / 60 / 90" triples the apparent backlog while every
      // individual number stays correct, which is why it never gets caught.
      return (
        <Card title={def.label} href="/finance/warranties">
          <div className="flex gap-6">
            <Big n={d.days0to30} label="0–30 d" />
            <Big n={d.days31to60} label="31–60 d" />
            <Big n={d.days61to90} label="61–90 d" />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {d.expired} already expired · {d.beyond90} beyond 90 days
          </p>
        </Card>
      )
    }

    case 'invoicesPendingApproval': {
      const d = await getInvoicesPendingApproval(actor)
      return (
        <Card title={def.label} href="/approvals">
          <Big n={d.pending} label="awaiting a decision" />
        </Card>
      )
    }

    case 'invoicesUnpaid': {
      const d = await getUnpaidInvoices(actor)
      return (
        <Card title={def.label} href="/finance/invoices">
          <div className="flex gap-8">
            <Big n={d.count} label="unpaid" />
            <Big n={d.overdue} label="overdue" />
          </div>
          <p className="mt-2 text-sm text-slate-600">SGD {d.totalSgd} outstanding</p>
        </Card>
      )
    }

    case 'userActivity': {
      const d = await getUserActivity(actor)
      return (
        <Card title={def.label} href="/admin/users">
          <div className="flex gap-8">
            <Big n={d.activeUsers} label="active" />
            <Big n={d.neverLoggedIn} label="never signed in" />
          </div>
        </Card>
      )
    }

    case 'failedLogins': {
      const d = await getFailedLogins(actor)
      return (
        <Card title={def.label}>
          <div className="flex gap-8">
            <Big n={d.last24h} label="last 24h" />
            <Big n={d.last7d} label="last 7 days" />
          </div>
        </Card>
      )
    }

    case 'jobQueueHealth': {
      const d = await getJobQueueHealth(actor)
      if (d === null) {
        // null is UNKNOWN, never zero — the outbox table is absent. Zero is the
        // reading an operator stands down on, and it would be false.
        return (
          <Card title={def.label}>
            <p className="text-sm text-slate-500">
              Unavailable — the outbox table is not present in this database.
            </p>
          </Card>
        )
      }
      return (
        <Card title={def.label}>
          <Big n={d.unprocessed} label="unprocessed events" />
          {/* Nested, not adjacent: parked is a SUBSET of unprocessed, and two
              totals side by side read as though the backlog were their sum. */}
          <p className="mt-1 text-xs text-slate-500">of which {d.parked} parked</p>
          <p className="mt-2 text-sm text-slate-600">
            {d.oldestUnprocessedAt
              ? `Oldest queued ${new Date(d.oldestUnprocessedAt).toLocaleString()}`
              : 'Queue empty'}
          </p>
        </Card>
      )
    }

    // Every 'live' widget above has a case. This catches a registry entry added
    // without a renderer: it shows the blocker rather than a blank card, so the
    // gap is visible instead of silently rendering nothing.
    default:
      return <Card title={def.label}><Pending def={def} /></Card>
  }
}
