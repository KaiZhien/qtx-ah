import type { Tx } from '@/lib/db/tx'
import type { Actor } from '@/modules/shared/authz/catalog'
import type { ExpiryWindow } from '@/modules/shared/reporting/domain/expiry'

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

export type ExpiringWarrantyBucket = { window: ExpiryWindow | 'expired'; count: number }

/**
 * Spec §8.5 "warranties expiring 30/60/90 d".
 *
 * OWNER: agent FINANCE (`warranty`). NOT WIRED — no platform `warranty` table
 * exists on `main`. (`supabase/migrations/20250104000000_warranty.sql` belongs to
 * the LEGACY DLMS project, a different Supabase database entirely; it is not this
 * platform's schema and must not be read here.)
 *
 * TO IMPLEMENT: group live warranties by the bucket
 * `expiryBucket(expires_on::text, today)` returns — that pure function is already
 * built and tested (reporting/domain/expiry.ts), including the rule that the
 * buckets are DISJOINT so nothing is counted in all three windows at once. Read
 * the expiry column as `::text` and pass the ISO string; do not convert it to a
 * JS Date, which is how a previous slice shipped a one-day shift.
 */
export async function fetchExpiringWarranties(
  _tx: Tx, _actor: Actor, _today: string,
): Promise<ExpiringWarrantyBucket[] | null> {
  return null
}

export type RootCauseCount = { rootCause: string; label: string; count: number }

/**
 * Spec §8.5 "repairs by root cause (30/90 d)".
 *
 * OWNER: agent ENGINEERING (failure/RCA records). NOT WIRED — and it is blocked
 * on a MODELLING gap, not just a missing table: `repair` records causes only as
 * free-text `fault_description` / `diagnosis`, which cannot be grouped. This
 * widget needs either a `failure_investigation` row per repair carrying a
 * structured cause, or a `root_cause_option` vocabulary referenced from `repair`.
 *
 * TO IMPLEMENT: group repairs closed within the window by that structured cause,
 * resolving the label FROM THE VOCABULARY TABLE rather than a code list in TS —
 * this is precisely the admin-extensible case CLAUDE.md warns about.
 */
export async function fetchRepairsByRootCause(
  _tx: Tx, _actor: Actor, _windowDays: 30 | 90,
): Promise<RootCauseCount[] | null> {
  return null
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
