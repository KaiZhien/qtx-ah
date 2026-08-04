import type { Tx } from '@/lib/db/tx'
import type { Actor } from '@/modules/shared/authz/catalog'
import type { CumulativeExpiryCounts } from '@/modules/shared/reporting/domain/expiry'

/**
 * ── THE SEAM FOR TABLES THIS BRANCH DOES NOT OWN ────────────────────────────
 *
 * Global search and the dashboards read from every module, and several modules
 * were being built in parallel with this one. Rather than GUESS a peer's schema
 * and code against the guess — which produces something that compiles, passes its
 * own mocked tests, and is wrong — each unavailable source gets one narrow,
 * named, fully-typed adapter here.
 *
 * Every function below returns `null`, meaning "this source does not exist yet".
 * The widget resolvers treat `null` as `status: 'pending'` and the UI renders the
 * blocker instead of a fake zero — a widget reading "0 warranties expiring" when
 * the table does not exist is a lie a user would act on.
 *
 * WIRING ONE UP is deliberately a ONE-FILE change:
 *   1. implement the body here against the peer's real table;
 *   2. flip that widget's `status` to 'live' in reporting/domain/widgets.ts.
 * Nothing else in the reporting module needs to change — the resolver, the cache
 * key, the permission gate and the page are already in place and already tested.
 *
 * The `Tx` parameter is threaded through so an implementation runs on the SAME
 * transaction and connection as the rest of the dashboard, and inherits the
 * `app.actor_id` GUC that fn_audit reads.
 */

/**
 * Spec §8.5 "warranties expiring 30/60/90 d".
 *
 * OWNER: agent FINANCE (`warranty`). NOT WIRED — their migration is not on this
 * branch's base, so `modules/finance/services/warrantyService` does not exist in
 * this worktree. (`supabase/migrations/20250104000000_warranty.sql` is the LEGACY
 * DLMS project's table, a different Supabase database entirely; it is not this
 * platform's schema and must never be read here.)
 *
 * TO IMPLEMENT — one call, no per-window round trips:
 *
 *     const counts = await getWarrantyExpiryCounts(actor)   // finance/services/warrantyService
 *     return disjointFromCumulative(counts)
 *
 * FOUR THINGS THAT ARE EASY TO GET WRONG HERE, all confirmed with FINANCE:
 *
 *   1. THEIR WINDOWS ARE CUMULATIVE (30 ⊆ 60 ⊆ 90); this dashboard renders
 *      DISJOINT ones. `disjointFromCumulative` (reporting/domain/expiry.ts) is the
 *      conversion and it is unit-tested, including the clamp. Rendering the raw
 *      nested numbers under "30 / 60 / 90" triples the apparent backlog while
 *      every individual number stays correct — which is why it is never caught.
 *   2. Their windows all EXCLUDE already-expired rows; `expired` is its own count.
 *   3. Dates are 'YYYY-MM-DD' TEXT, never `Date`. Keep them strings end to end.
 *   4. THERE IS NO `status` COLUMN — status is derived from dates, and an
 *      integration test on their side asserts its absence. Do not group on one.
 *
 * Also: a renewal mints a NEW row and soft-deletes the old, so `warrantyId` is
 * NOT stable across a renewal and must not be used as a durable key.
 */
export async function fetchWarrantyExpiryCounts(
  _tx: Tx, _actor: Actor,
): Promise<CumulativeExpiryCounts | null> {
  return null
}

export type RootCauseCount = { code: string; label: string; count: number }

/** See the note on the search adapter's copy: guards a cross-branch migration. */
async function tableExists(tx: Tx, table: string): Promise<boolean> {
  const { rows } = await tx.query<{ reg: string | null }>(
    `SELECT to_regclass($1)::text AS reg`, [`public.${table}`])
  return rows[0]?.reg !== null
}

/**
 * Spec §8.5 "repairs by root cause (30/90 d)" — WIRED.
 *
 * THE JOIN IS NOT THE OBVIOUS ONE, and this is the note worth reading. `repair`
 * has no `root_cause` column — it never did, despite spec §6.3 listing one for
 * that table. The structured cause lives on the failure investigation:
 *
 *     repair → failure_investigation.repair_id
 *            → failure_investigation.root_cause_id
 *            → root_cause_option.code
 *
 * Anyone "simplifying" this to `repair.root_cause` will find no such column;
 * anyone adding one will split the truth across two places.
 *
 * FOUR RULES THIS QUERY KEEPS:
 *
 *   1. COUNT CLASSIFIED ROWS ONLY. An investigation can sit `open`/`investigating`
 *      with `root_cause_id` NULL, and an unclassified failure is not a root cause
 *      called "none" — it is a row that has not been diagnosed. The WHERE clause
 *      matches agent ENGINEERING's partial index `fi_root_cause_idx` predicate
 *      exactly (`deleted_at IS NULL AND root_cause_id IS NOT NULL`) so the index
 *      is actually used.
 *   2. NOTHING BRANCHES ON A CODE. Labels come from `root_cause_option` and the
 *      ordering from its `sort`, so the ten seeded causes, any admin-added
 *      eleventh, and prod drift all work with no code change. This is the trap
 *      CLAUDE.md records as having bitten this project in production.
 *   3. THE WINDOW IS ON `opened_at`, matching the index's second key, and is
 *      computed in SQL against `now()` so the database's clock decides.
 *   4. GUARDED ON TABLE EXISTENCE — their migration is on another branch.
 *
 * The classification has teeth on their side: reaching `root_cause_identified` or
 * `closed` REQUIRES a `root_cause_id`, not prose. So every closed investigation is
 * countable and this widget cannot be defeated by someone typing a paragraph.
 */
export async function fetchRepairsByRootCause(
  tx: Tx, _actor: Actor, windowDays: 30 | 90,
): Promise<RootCauseCount[] | null> {
  if (!(await tableExists(tx, 'failure_investigation'))) return null
  if (!(await tableExists(tx, 'root_cause_option'))) return null

  const { rows } = await tx.query<{ code: string; label: string; n: string }>(
    `SELECT o.code, o.name AS label, count(f.id)::text AS n
       FROM failure_investigation f
       JOIN root_cause_option o ON o.id = f.root_cause_id
      WHERE f.deleted_at IS NULL
        AND f.root_cause_id IS NOT NULL
        AND f.opened_at > now() - ($1 || ' days')::interval
      GROUP BY o.code, o.name, o.sort
      ORDER BY count(f.id) DESC, o.sort`, [String(windowDays)])

  return rows.map((r) => ({ code: r.code, label: r.label, count: Number(r.n) }))
}

export type BackupStatus = {
  lastSucceededAt: string | null
  lastVerifiedAt: string | null
  healthy: boolean
}

/**
 * Spec §8.5 Admin "backup status".
 *
 * NOT WIRED, and NOT because a peer is late: spec §12 puts nightly `pg_dump` →
 * `s3://qtx-ops-backups/` with Object Lock on the worker, and there is no AWS
 * account (PROGRESS item 6, deferred). There is no `backup_verification` table to
 * read and nothing that writes one. Supabase PITR is running underneath and is
 * not queryable from here.
 *
 * This one should stay `null` until the AWS decision is made. Reporting "healthy"
 * from an app that cannot see the backups would be worse than reporting nothing.
 */
export async function fetchBackupStatus(_tx: Tx, _actor: Actor): Promise<BackupStatus | null> {
  return null
}

export type StockSummary = {
  /**
   * BATCH-tracked quantities only, per location. Deliberately NOT a
   * "stock on hand" total — see the correctness rule below.
   */
  byLocation: { locationCode: string; locationName: string; batchQty: number }[]
  transfersByStatus: { status: string; count: number }[]
}

/**
 * Not a spec §8.5 widget — offered because a Logistics dashboard with no stock on
 * it is thin, and agent LOGISTICS has built `stock_level`/`stock_transfer`.
 *
 * OWNER: agent LOGISTICS. NOT WIRED HERE — their migration
 * (`20260803130000_platform_logistics_stock.sql`) is not on this branch's base,
 * so `modules/logistics/services/stock*` does not exist in this worktree and
 * importing it would not compile. The controller wires this at integration.
 *
 * TO IMPLEMENT: call their read services rather than re-querying —
 * `getStockByLocation(actor)` and `getTransferStatusCounts(actor)`.
 *
 * ── A CORRECTNESS RULE THAT SURVIVES THE WIRING ────────────────────────────
 * `stock_level` tracks BATCH component types ONLY; a SERIALIZED unit's location
 * lives on `component_unit.location_id`. They are two different sources of truth,
 * and a database function (`fn_stock_level_batch_only`) enforces the split.
 *
 * NEVER UNION THEM INTO ONE "stock on hand" FIGURE — it double-counts, and it is
 * agent LOGISTICS's own top carried finding. That is why the type above says
 * `batchQty` rather than `units`: a field named "units" is an invitation for the
 * next person to add the serialized count into it, and the name is the only thing
 * standing between this widget and a number that is quietly wrong. If a combined
 * view is ever wanted, it needs two separately-labelled figures, not a sum.
 */
export async function fetchStockSummary(
  _tx: Tx, _actor: Actor,
): Promise<StockSummary | null> {
  return null
}
