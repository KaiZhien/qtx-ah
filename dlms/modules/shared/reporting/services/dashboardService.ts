import { unstable_cache } from 'next/cache'
import { withTransaction, type Tx } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import { can } from '@/modules/shared/authz/policy'
import type { Actor } from '@/modules/shared/authz/catalog'
import { dashboardCacheKey, DASHBOARD_REVALIDATE_SECONDS } from '../domain/cacheKey'
import { daysInState, agingBucket, type AgingBucket } from '../domain/aging'
import { disjointFromCumulative, type DisjointExpiryCounts } from '../domain/expiry'
import {
  ACTIVE_REPAIR_STATUSES, OPEN_DO_STATUSES, UNPAID_INVOICE_STATUSES,
} from '../domain/activeStates'
import { repairStatusLabel } from '@/modules/maintenance/domain/repairStatus'
import {
  fetchWarrantyExpiryCounts, fetchRepairsByRootCause, fetchBackupStatus, fetchQueueHealth,
  type RootCauseCount, type BackupStatus, type QueueHealthView,
} from '../adapters/pendingSources'

/**
 * Dashboard widget queries (spec §8.5).
 *
 * MATERIALIZED-VIEW-FREE, per the spec and per CLAUDE.md's standing house rule:
 * flat selects plus a JS reduce, no DB views and no `.rpc()`. The `stats_daily`
 * pattern stays unported unless one of these proves slow.
 *
 * ── EVERY RESULT IS JSON-SAFE, AND THAT IS NOT A STYLE CHOICE ──────────────
 * `unstable_cache` serialises through the incremental cache, so a `Date` written
 * on a cache MISS comes back as a `string` on the HIT. A widget returning Dates
 * would therefore work perfectly for 60 seconds and then start throwing
 * `x.toLocaleDateString is not a function` — an intermittent bug that reproduces
 * only after the cache warms. So every query below reads timestamps and dates as
 * `::text` and every resolver returns strings, numbers and booleans only. This
 * also lines up with the house rule that date columns are read as `::text`
 * because a `toISOString()` round-trip day-shifted on a UTC+ host once already.
 *
 * ── THE CACHE KEY IS THE SECURITY BOUNDARY ─────────────────────────────────
 * See domain/cacheKey.ts. `withCache` below is the ONLY place a widget is cached,
 * and it always keys on the actor. Adding a cached widget that bypasses it would
 * reintroduce the cross-user read that key exists to prevent.
 */

function withCache<T>(actor: Actor, widgetKey: string, fn: () => Promise<T>): Promise<T> {
  return unstable_cache(fn, dashboardCacheKey(actor, widgetKey), {
    revalidate: DASHBOARD_REVALIDATE_SECONDS,
    tags: [`dashboard:${actor.id}`],
  })()
}

const num = (v: string | number | null) => (v === null ? 0 : Number(v))

// ── Home ────────────────────────────────────────────────────────────────────

export type MyTasksWidget = {
  overdue: number
  open: number
  soonest: { id: string; title: string; dueDate: string | null; status: string }[]
}

export async function getMyTasksWidget(actor: Actor): Promise<MyTasksWidget> {
  authorize(actor, 'view_records', 'tasks')
  return withCache(actor, 'myTasks', () => withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; title: string; due_date: string | null; status: string; overdue: boolean
    }>(
      `SELECT t.id, t.title, t.due_date::text AS due_date, t.status,
              (t.due_date IS NOT NULL AND t.due_date < now()) AS overdue
         FROM task t
        WHERE t.deleted_at IS NULL
          AND t.assignee_id = $1
          AND t.status IN ('open','in_progress','blocked','awaiting_approval')
        ORDER BY t.due_date NULLS LAST, t.created_at DESC
        LIMIT 100`, [actor.id])

    return {
      overdue: rows.filter((r) => r.overdue).length,
      open: rows.length,
      soonest: rows.slice(0, 5).map((r) => ({
        id: r.id, title: r.title, dueDate: r.due_date, status: r.status,
      })),
    }
  }))
}

export type MyApprovalsWidget = {
  pending: number
  rows: { id: string; kind: string; module: string; requestedAt: string }[]
}

/**
 * Scoped by the actor's module access exactly as the /approvals page is — a
 * manager who can enter Finance but not Engineering counts only Finance requests.
 * `super_admin` bypasses the module clause, matching `can()`. The
 * `requested_by <> actor` clause is the "nobody decides their own" rule.
 *
 * ── TWO NOTES FOR WHOEVER TOUCHES THIS NEXT ────────────────────────────────
 *
 * NEVER swap this for `getGoverningApprovalInTx`. Agent APPROVALS added that as
 * an ENFORCEMENT-only read — it takes no actor and runs no `authorize`, because
 * its callers are gates already inside an authorized transaction. It is the
 * obvious-looking helper to reach for here and it would strip the module scoping,
 * leaking Engineering approvals to a Finance-only manager. A dashboard is a
 * DISPLAY read and owes the full scoping.
 *
 * The count itself should move to `countPendingApprovals(actor)` once agent
 * APPROVALS exports it. It is not called here only because it does not exist on
 * this branch's base and importing it would not compile. The SQL below mirrors
 * `listApprovals`' scoping deliberately, but a shared function is better than a
 * faithful copy — module scoping from outside the owning module is exactly the
 * thing that drifts.
 */
export async function getMyApprovalsWidget(actor: Actor): Promise<MyApprovalsWidget> {
  authorize(actor, 'approve_requests')
  const modules = [...actor.moduleAccess]
  const unscoped = actor.roleKey === 'super_admin'

  return withCache(actor, 'myApprovalsPending', () =>
    withTransaction(actor.id, async (tx) => {
      const { rows } = await tx.query<{
        id: string; kind: string; module: string; created_at: string
      }>(
        `SELECT a.id, a.kind, a.module, a.created_at::text AS created_at
           FROM approval a
          WHERE a.deleted_at IS NULL
            AND a.status = 'pending'
            AND a.requested_by <> $1
            AND ($2::boolean OR a.module = ANY($3::text[]))
          ORDER BY a.created_at
          LIMIT 50`, [actor.id, unscoped, modules])

      return {
        pending: rows.length,
        rows: rows.slice(0, 5).map((r) => ({
          id: r.id, kind: r.kind, module: r.module, requestedAt: r.created_at,
        })),
      }
    }))
}

export type RecentActivityWidget = {
  rows: { table: string; action: string; occurredAt: string; rowId: string | null }[]
}

/**
 * "Recent activity on my records" (spec §8.5), read as the actor's OWN audit
 * trail. Narrowed deliberately: `audit_log` is cross-module and holds Finance
 * writes, so returning everything recent would leak the existence of records the
 * reader cannot open. Their own actions are unambiguously theirs to see.
 */
export async function getRecentActivityWidget(actor: Actor): Promise<RecentActivityWidget> {
  authorize(actor, 'view_audit_record')
  return withCache(actor, 'recentActivity', () => withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      table_name: string; action: string; occurred_at: string; row_id: string | null
    }>(
      `SELECT table_name, action, occurred_at::text AS occurred_at, row_id::text AS row_id
         FROM audit_log
        WHERE actor_id = $1
        ORDER BY occurred_at DESC
        LIMIT 10`, [actor.id])

    return {
      rows: rows.map((r) => ({
        table: r.table_name, action: r.action, occurredAt: r.occurred_at, rowId: r.row_id,
      })),
    }
  }))
}

// ── Manufacturing ───────────────────────────────────────────────────────────

export type CountByCode = { code: string; label: string; count: number }

/**
 * The pipeline funnel. Statuses come FROM `status_option` and are ordered by its
 * `sort_order` — never a code list in TypeScript. Device statuses are
 * admin-extensible, prod already drifted from the seed (`In Stock`/`Under Repair`
 * /`Shipped`, not `Stock`/`Repair`), and hardcoding them here is the exact trap
 * CLAUDE.md records as having bitten this project in production. An
 * admin-added status appears in this funnel with no code change.
 */
export async function getDevicesByStatus(actor: Actor): Promise<CountByCode[]> {
  authorize(actor, 'view_records', 'manufacturing')
  return withCache(actor, 'devicesByStatus', () => withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ code: string; label: string; n: string }>(
      `SELECT s.code, s.label_en AS label, count(d.id)::text AS n
         FROM status_option s
         LEFT JOIN device d ON d.status = s.code AND d.deleted_at IS NULL
        GROUP BY s.code, s.label_en, s.sort_order
        ORDER BY s.sort_order`)
    return rows.map((r) => ({ code: r.code, label: r.label, count: num(r.n) }))
  }))
}

export async function getDevicesByVariant(actor: Actor): Promise<CountByCode[]> {
  authorize(actor, 'view_records', 'manufacturing')
  return withCache(actor, 'devicesByVariant', () => withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ code: string; label: string; n: string }>(
      `SELECT v.code, v.name AS label, count(d.id)::text AS n
         FROM device_variant v
         LEFT JOIN device d ON d.variant_id = v.id AND d.deleted_at IS NULL
        WHERE v.active
        GROUP BY v.code, v.name
        ORDER BY v.name`)
    return rows.map((r) => ({ code: r.code, label: r.label, count: num(r.n) }))
  }))
}

export type ImportsAwaitingWidget = {
  batches: number
  rowsNeedingReview: number
}

export async function getImportsAwaitingConfirm(actor: Actor): Promise<ImportsAwaitingWidget> {
  authorize(actor, 'import_data', 'manufacturing')
  return withCache(actor, 'importsAwaitingConfirm', () =>
    withTransaction(actor.id, async (tx) => {
      const { rows: batchRows } = await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM import_batch WHERE status = 'draft'`)
      const { rows: rowRows } = await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM import_row r
           JOIN import_batch b ON b.id = r.batch_id
          WHERE b.status = 'draft' AND r.status = 'needs_review'`)
      return {
        batches: num(batchRows[0]?.n ?? '0'),
        rowsNeedingReview: num(rowRows[0]?.n ?? '0'),
      }
    }))
}

// ── Maintenance ─────────────────────────────────────────────────────────────

export type RepairStateAging = {
  status: string
  label: string
  count: number
  /** Days-in-state histogram for the repairs in this state. */
  buckets: Record<AgingBucket, number>
  oldestDays: number
}

/**
 * Active repairs by state, with days-in-state aging.
 *
 * FLAT SELECT + JS REDUCE, per the house rule: one query returns one row per
 * active repair with the instant it entered its CURRENT state, and the histogram
 * is folded in TypeScript by the pure `daysInState`/`agingBucket` pair.
 *
 * `entered_at` falls back to `opened_at` because a repair created in its initial
 * state may have no history row for it yet — without the COALESCE those repairs
 * would silently drop out of a widget whose whole job is to show the backlog.
 *
 * ONE CLOCK for the whole widget: `now` is read once, so two repairs a
 * millisecond apart cannot land in different buckets for that reason alone.
 */
export async function getActiveRepairsByState(actor: Actor): Promise<RepairStateAging[]> {
  authorize(actor, 'view_records', 'maintenance')
  return withCache(actor, 'activeRepairsByState', () =>
    withTransaction(actor.id, async (tx) => {
      const { rows } = await tx.query<{ status: string; entered_at: string }>(
        `SELECT r.status,
                coalesce(max(h.changed_at), r.opened_at)::text AS entered_at
           FROM repair r
           LEFT JOIN repair_status_history h
             ON h.repair_id = r.id AND h.to_status = r.status
          WHERE r.deleted_at IS NULL
            AND r.status = ANY($1::text[])
          GROUP BY r.id, r.status, r.opened_at`, [[...ACTIVE_REPAIR_STATUSES]])

      const now = new Date()
      const byStatus = new Map<string, RepairStateAging>()
      for (const s of ACTIVE_REPAIR_STATUSES) {
        byStatus.set(s, {
          status: s, label: repairStatusLabel(s), count: 0,
          buckets: { '0-3': 0, '4-7': 0, '8-14': 0, '15+': 0 }, oldestDays: 0,
        })
      }
      for (const r of rows) {
        const entry = byStatus.get(r.status)
        if (!entry) continue
        const days = daysInState(new Date(r.entered_at), now)
        entry.count += 1
        entry.buckets[agingBucket(days)] += 1
        if (days > entry.oldestDays) entry.oldestDays = days
      }
      return [...byStatus.values()]
    }))
}

/** NOT WIRED — see adapters/pendingSources.ts. Returns null until a cause exists. */
export async function getRepairsByRootCause(
  actor: Actor, windowDays: 30 | 90 = 30,
): Promise<RootCauseCount[] | null> {
  authorize(actor, 'view_records', 'maintenance')
  return withCache(actor, `repairsByRootCause:${windowDays}`, () =>
    withTransaction(actor.id, (tx) => fetchRepairsByRootCause(tx, actor, windowDays)))
}

// ── Logistics / Finance ─────────────────────────────────────────────────────

export type DeliveriesDueWidget = {
  dueThisWeek: number
  overdue: number
  rows: { id: string; doNo: string; shipDate: string | null; status: string }[]
}

/**
 * Deliveries due this week. The window is computed in SQL against `current_date`
 * so the database's clock decides, not the rendering host's — and `ship_date` is
 * a `date`, compared to a date, with no timezone in the picture at all.
 */
export async function getDeliveriesDueThisWeek(actor: Actor): Promise<DeliveriesDueWidget> {
  authorize(actor, 'view_records', 'logistics')
  return withCache(actor, 'deliveriesDueThisWeek', () =>
    withTransaction(actor.id, async (tx) => {
      const { rows } = await tx.query<{
        id: string; do_no: string; ship_date: string | null; status: string; overdue: boolean
      }>(
        `SELECT o.id, o.do_no, o.ship_date::text AS ship_date, o.status,
                (o.ship_date < current_date) AS overdue
           FROM delivery_order o
          WHERE o.deleted_at IS NULL
            AND o.status = ANY($1::text[])
            AND o.ship_date IS NOT NULL
            AND o.ship_date < current_date + 7
          ORDER BY o.ship_date
          LIMIT 100`, [[...OPEN_DO_STATUSES]])

      return {
        dueThisWeek: rows.filter((r) => !r.overdue).length,
        overdue: rows.filter((r) => r.overdue).length,
        rows: rows.slice(0, 5).map((r) => ({
          id: r.id, doNo: r.do_no, shipDate: r.ship_date, status: r.status,
        })),
      }
    }))
}

/**
 * NOT WIRED — see adapters/pendingSources.ts (agent FINANCE owns `warranty`).
 *
 * GATED ON `view_records` + `finance`, NOT `view_finance`, matching FINANCE's own
 * `warrantyService`. That looks like a copy-paste slip beside the two invoice
 * widgets above and is not one: a warranty date is a SERVICE ENTITLEMENT, not
 * money, and the payload deliberately carries no buyer identity. Tightening this
 * to `view_finance` would hide service information from the maintenance-side
 * users it exists for.
 *
 * Returns the DISJOINT cut of FINANCE's cumulative windows — see
 * `disjointFromCumulative` for why the raw nested counts must not be rendered.
 */
export async function getWarrantiesExpiring(
  actor: Actor,
): Promise<DisjointExpiryCounts | null> {
  authorize(actor, 'view_records', 'finance')
  return withCache(actor, 'warrantiesExpiring', () =>
    withTransaction(actor.id, async (tx) => {
      const counts = await fetchWarrantyExpiryCounts(tx, actor)
      return counts === null ? null : disjointFromCumulative(counts)
    }))
}

export type InvoicesPendingApprovalWidget = {
  pending: number
  rows: { id: string; invoiceNo: string; totalSgd: string | null; requestedAt: string }[]
}

/**
 * Invoices waiting on the AP1 threshold gate. Reads the `approval` table directly
 * — the same source the /approvals page uses — rather than inferring from invoice
 * status, because an invoice stays `draft` while its approval is pending.
 */
export async function getInvoicesPendingApproval(
  actor: Actor,
): Promise<InvoicesPendingApprovalWidget> {
  authorize(actor, 'view_finance', 'finance')
  return withCache(actor, 'invoicesPendingApproval', () =>
    withTransaction(actor.id, async (tx) => {
      const { rows } = await tx.query<{
        id: string; invoice_no: string; total_sgd: string | null; created_at: string
      }>(
        `SELECT a.id, i.invoice_no, i.total_sgd::text AS total_sgd,
                a.created_at::text AS created_at
           FROM approval a
           JOIN sales_invoice i ON i.id = a.entity_id
          WHERE a.deleted_at IS NULL
            AND a.status = 'pending'
            AND a.entity_type = 'sales_invoice'
            AND i.deleted_at IS NULL
          ORDER BY a.created_at
          LIMIT 50`)

      return {
        pending: rows.length,
        rows: rows.slice(0, 5).map((r) => ({
          id: r.id, invoiceNo: r.invoice_no, totalSgd: r.total_sgd, requestedAt: r.created_at,
        })),
      }
    }))
}

export type UnpaidInvoicesWidget = {
  count: number
  totalSgd: string
  overdue: number
  rows: { id: string; invoiceNo: string; dueDate: string | null; totalSgd: string | null }[]
}

/**
 * Unpaid invoices. The money is summed IN SQL as `numeric`, never by adding
 * JS floats — the same reason the AP1 threshold comparison happens in Postgres.
 */
export async function getUnpaidInvoices(actor: Actor): Promise<UnpaidInvoicesWidget> {
  authorize(actor, 'view_finance', 'finance')
  return withCache(actor, 'invoicesUnpaid', () => withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; invoice_no: string; due_date: string | null
      total_sgd: string | null; overdue: boolean
    }>(
      `SELECT i.id, i.invoice_no, i.due_date::text AS due_date, i.total_sgd::text AS total_sgd,
              (i.due_date IS NOT NULL AND i.due_date < current_date) AS overdue
         FROM sales_invoice i
        WHERE i.deleted_at IS NULL
          AND i.status = ANY($1::text[])
        ORDER BY i.due_date NULLS LAST
        LIMIT 200`, [[...UNPAID_INVOICE_STATUSES]])

    const { rows: sum } = await tx.query<{ total: string | null }>(
      `SELECT coalesce(sum(i.total_sgd), 0)::text AS total
         FROM sales_invoice i
        WHERE i.deleted_at IS NULL AND i.status = ANY($1::text[])`,
      [[...UNPAID_INVOICE_STATUSES]])

    return {
      count: rows.length,
      totalSgd: sum[0]?.total ?? '0',
      overdue: rows.filter((r) => r.overdue).length,
      rows: rows.slice(0, 5).map((r) => ({
        id: r.id, invoiceNo: r.invoice_no, dueDate: r.due_date, totalSgd: r.total_sgd,
      })),
    }
  }))
}

// ── Admin ───────────────────────────────────────────────────────────────────

export type UserActivityWidget = {
  activeUsers: number
  neverLoggedIn: number
  rows: { id: string; name: string; lastLoginAt: string | null }[]
}

export async function getUserActivity(actor: Actor): Promise<UserActivityWidget> {
  authorize(actor, 'manage_users', 'admin')
  return withCache(actor, 'userActivity', () => withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; full_name: string; last_login_at: string | null; active: boolean
    }>(
      `SELECT id, full_name, last_login_at::text AS last_login_at, active
         FROM app_user
        WHERE deleted_at IS NULL
        ORDER BY last_login_at DESC NULLS LAST
        LIMIT 200`)

    return {
      activeUsers: rows.filter((r) => r.active).length,
      neverLoggedIn: rows.filter((r) => r.last_login_at === null).length,
      rows: rows.slice(0, 5).map((r) => ({
        id: r.id, name: r.full_name, lastLoginAt: r.last_login_at,
      })),
    }
  }))
}

export type FailedLoginsWidget = {
  last24h: number
  last7d: number
  rows: { email: string | null; occurredAt: string }[]
}

export async function getFailedLogins(actor: Actor): Promise<FailedLoginsWidget> {
  authorize(actor, 'manage_users', 'admin')
  return withCache(actor, 'failedLogins', () => withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      email: string | null; occurred_at: string; within_24h: boolean
    }>(
      `SELECT email, occurred_at::text AS occurred_at,
              (occurred_at > now() - interval '24 hours') AS within_24h
         FROM auth_event
        WHERE event_type = 'login_failure'
          AND occurred_at > now() - interval '7 days'
        ORDER BY occurred_at DESC
        LIMIT 200`)

    return {
      last24h: rows.filter((r) => r.within_24h).length,
      last7d: rows.length,
      rows: rows.slice(0, 5).map((r) => ({ email: r.email, occurredAt: r.occurred_at })),
    }
  }))
}

/**
 * Job-queue health (spec §8.5 Admin, §13).
 *
 * NOT WIRED — delegates to the adapter, which will call agent NOTIFICATIONS'
 * `getQueueHealth()`. `/api/health` calls that same function, so the dashboard and
 * the health check cannot report different numbers.
 *
 * An earlier draft of this service computed the depth from the `outbox` table
 * here, with its own literal `5` for the attempt cap. That was DELETED rather
 * than kept as a fallback: two implementations of one number is the defect, and a
 * hardcoded cap goes stale silently the day the drain's `MAX_ATTEMPTS` moves.
 *
 * `null` propagates as UNKNOWN and the widget says "unavailable" — never "0".
 */
export async function getJobQueueHealth(actor: Actor): Promise<QueueHealthView | null> {
  authorize(actor, 'manage_settings', 'admin')
  return withCache(actor, 'jobQueueHealth', () =>
    withTransaction(actor.id, (tx) => fetchQueueHealth(tx, actor)))
}

/** NOT WIRED — spec §12 backups live on the deferred AWS worker. */
export async function getBackupStatus(actor: Actor): Promise<BackupStatus | null> {
  authorize(actor, 'manage_settings', 'admin')
  return withCache(actor, 'backupStatus', () =>
    withTransaction(actor.id, (tx) => fetchBackupStatus(tx, actor)))
}

/**
 * Whether this actor may see a widget at all — the same `can()` the registry
 * uses, re-exported so a page never has to reconstruct the rule.
 */
export function actorCanSeeWidget(
  actor: Actor, permission: Parameters<typeof can>[1], module?: Parameters<typeof can>[2],
): boolean {
  return can(actor, permission, module)
}

export type { Tx }
