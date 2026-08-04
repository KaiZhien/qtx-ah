import type { Tx } from '@/lib/db/tx'
import type { Actor } from '@/modules/shared/authz/catalog'

/**
 * ── THE SEAM FOR TABLES THIS BRANCH DID NOT OWN ─────────────────────────────
 *
 * Global search and the dashboards read from every module, and several modules
 * were being built in parallel with this one. Rather than GUESS a peer's schema
 * and code against the guess — which produces something that compiles, passes its
 * own mocked tests, and is wrong — each unavailable source got one narrow, named,
 * fully-typed adapter here, returning `null` for "this source does not exist
 * yet". The widget resolvers treat `null` as `status: 'pending'` and the UI
 * renders the blocker instead of a fake zero — a widget reading "0 warranties
 * expiring" when the table does not exist is a lie a user would act on.
 *
 * MOST OF THOSE PEERS HAVE NOW LANDED, and a wired source does NOT stay here:
 * queue health, root cause and warranty expiry each moved to a direct call on
 * the owning module's own read service. That is the point of the seam — it is
 * scaffolding to be removed, not a permanent indirection layer, and leaving a
 * pass-through wrapper behind would be a second place for a peer's contract to
 * be restated and drift.
 *
 * What remains below is genuinely unavailable, for reasons that are not "a peer
 * is late".
 *
 * The `Tx` parameter is threaded through so an implementation runs on the SAME
 * transaction and connection as the rest of the dashboard, and inherits the
 * `app.actor_id` GUC that fn_audit reads.
 */

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

/**
 * ── THE STOCK SEAM WAS REMOVED RATHER THAN WIRED, DELIBERATELY ─────────────
 *
 * `fetchStockSummary` used to sit here, returning null, waiting on agent
 * LOGISTICS. Their module has landed — and it is precisely BECAUSE it landed that
 * this adapter was deleted instead of implemented:
 *
 *   1. IT IS NOT A SPEC §8.5 WIDGET. There is no entry in DASHBOARD_WIDGETS, no
 *      permission gate, no cache key and no renderer for it — the adapter was the
 *      only part that ever existed. Wiring it is adding a feature, which is not
 *      what a defect-fix pass is for, and a dead adapter that reads as "one flip
 *      away from working" is worse than no adapter at all.
 *   2. ITS TYPE'S PREMISE IS NOW KNOWN TO BE WRONG. It declared
 *      `byLocation[].batchQty`, a summed quantity per location. LOGISTICS
 *      deliberately does NOT expose one: `getStockByLocation` returns a count of
 *      distinct component TYPES, because summing quantities across component
 *      types adds incommensurable units — five screws plus three boards is not
 *      "eight" of anything. So this could not have been wired as written; it
 *      would have had to be redesigned first.
 *
 * The correctness rule it carried is NOT lost: `stock_level` holds BATCH
 * quantities only while a SERIALIZED unit's location lives on
 * `component_unit.location_id`, and the two must never be unioned into one "stock
 * on hand" figure. That rule lives with the data — in LOGISTICS's own carried
 * findings, in `fn_stock_level_batch_only`, and in the `stock_level` entry of the
 * full-system export registry, which is where the next person to add these
 * numbers together will actually be reading.
 */
