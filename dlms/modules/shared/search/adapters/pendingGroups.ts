import type { Tx } from '@/lib/db/tx'
import type { Actor } from '@/modules/shared/authz/catalog'
import type { SearchHit } from '@/modules/shared/search/services/searchService'
import type { Needles } from '@/modules/shared/search/domain/searchQuery'
import { searchHref } from '@/modules/shared/search/domain/searchHref'

/**
 * Search groups spec §8.4 names that have no table on `main` yet.
 *
 * Same contract as the reporting adapters: return `null` for "this source does
 * not exist". `globalSearch` omits a null group entirely — which is also exactly
 * what it does for a group the actor may not see, so an unbuilt group and a
 * denied one are indistinguishable to the client. That is the correct default
 * here rather than an accident.
 *
 * WIRING ONE UP: implement the body, then add the group to SEARCH_GROUPS with its
 * module's own read gate, and a route (or an explicit opt-out) in searchHref.
 * The registry tests will refuse a group that is missing either.
 */

/**
 * Whether a table exists in this database.
 *
 * The pattern this codebase already uses for a committed-but-unapplied migration
 * (agent NOTIFICATIONS' `getQueueHealth` does the same for `outbox`, where
 * `to_regclass('public.outbox') IS NULL` is a live case today). It matters here
 * because global search runs EVERY permitted group in one transaction: a single
 * missing relation would not degrade one group, it would abort the transaction
 * and take the whole palette down for that user.
 */
async function tableExists(tx: Tx, table: string): Promise<boolean> {
  const { rows } = await tx.query<{ reg: string | null }>(
    `SELECT to_regclass($1)::text AS reg`, [`public.${table}`])
  return rows[0]?.reg !== null
}

/**
 * Spec §8.4 "FI refs" — WIRED.
 *
 * Table `failure_investigation`, ref column `fi_no` (`FI-YYYY-NNNN`), confirmed
 * with agent ENGINEERING. Gate is `view_records` + `engineering`, applied by the
 * group registry before this ever runs.
 *
 * GUARDED ON TABLE EXISTENCE because their migration is on a different branch and
 * is not merged yet. Absent table → `null` → the group is omitted, exactly as it
 * is for an actor who may not search it. Once merged, nothing here changes.
 *
 * The trigram index is in 20260803160000_platform_search_indexes.sql and the
 * expression below matches it CHARACTER FOR CHARACTER. ENGINEERING's own
 * `fi_no_lower_idx` is a btree on `lower(fi_no)` serving exact/prefix lookup —
 * a different expression for a different job, so the two do not collide and
 * neither is redundant.
 */
export async function searchFailureInvestigations(
  tx: Tx, _actor: Actor, n: Needles, limit: number,
): Promise<SearchHit[] | null> {
  if (!(await tableExists(tx, 'failure_investigation'))) return null

  const expr = `lower(translate(f.fi_no, ' -', ''))`
  const { rows } = await tx.query<{ id: string; label: string; rank: string }>(
    `SELECT f.id, f.fi_no AS label,
            CASE WHEN ${expr} = $1 THEN 0
                 WHEN ${expr} LIKE $2 ESCAPE '\\' THEN 1
                 ELSE 2 END AS rank
       FROM failure_investigation f
      WHERE f.deleted_at IS NULL
        AND ${expr} LIKE $3 ESCAPE '\\'
      ORDER BY rank, f.created_at DESC, f.id DESC
      LIMIT $4`, [n.exact, n.prefix, n.contains, limit])

  // NO SUBLABEL, deliberately. Only `id`, `fi_no`, `deleted_at`, `created_at` and
  // the status vocabulary were confirmed for this table; a title/summary column
  // was NOT. Selecting a plausible-sounding `f.title` would compile, read well,
  // and fail at runtime on a column that may not exist — which is worse than a
  // row with less context. Add one here once the column list is known, and use
  // `failureStatusLabel()` from modules/engineering/domain/failureStatus.ts if the
  // status is chosen: two of the six codes carry underscores, so capitalising the
  // raw code renders "Root_cause_identified".
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    sublabel: null,
    href: searchHref('failures', r.id),
    rank: Number(r.rank),
  }))
}

/**
 * Spec §8.4 "document titles".
 *
 * NOT WIRED, and blocked on an external decision rather than a peer: the document
 * library is ⏸️ in PROGRESS, waiting on file storage (spec §10 wants S3 presigned
 * uploads; AWS is deferred). There is no `document` table and nothing to search.
 *
 * TO IMPLEMENT when that lands: the NAME family (titles are prose, so word
 * boundaries matter), and note that documents will need row-level filtering like
 * tasks do if they inherit confidentiality from a linked record — a title is
 * exactly the kind of thing that leaks.
 */
export async function searchDocuments(
  _tx: Tx, _actor: Actor, _n: Needles, _limit: number,
): Promise<SearchHit[] | null> {
  return null
}
