import type { Tx } from '@/lib/db/tx'
import type { Actor } from '@/modules/shared/authz/catalog'
import type { SearchHit } from '@/modules/shared/search/services/searchService'
import type { Needles } from '@/modules/shared/search/domain/searchQuery'
import { searchHref } from '@/modules/shared/search/domain/searchHref'
import { failureStatusLabel } from '@/modules/engineering/domain/failureStatus'

/**
 * Search groups owned by another module's tables.
 *
 * Contract: return `null` for "this source does not exist in this database".
 * `globalSearch` omits a null group entirely — which is also exactly what it does
 * for a group the actor may not see, so an unbuilt group and a denied one are
 * indistinguishable to the client. That is the correct default rather than an
 * accident.
 *
 * WIRING ONE UP: implement the body, then add the group to SEARCH_GROUPS with its
 * module's own read gate, and a route (or an explicit opt-out) in searchHref.
 * The registry tests refuse a group that is missing either.
 */

/**
 * Whether a table exists in this database.
 *
 * KEPT EVEN THOUGH `failure_investigation` IS NOW ON `main`, because being on
 * `main` is not the same as being APPLIED: several platform migrations are
 * committed and not yet applied to cloud, and that gap is precisely when a deploy
 * happens. `getQueueHealth` guards `outbox` the same way and for the same reason.
 *
 * It matters more here than there: global search runs EVERY permitted group in
 * ONE transaction, so a single missing relation does not degrade one group — it
 * aborts the transaction and takes the whole palette down for that user.
 *
 * A SEPARATE STATEMENT, not a `CASE WHEN to_regclass(...)` wrapper around the
 * query. `to_regclass` runs at execution time but `FROM failure_investigation` is
 * resolved at PARSE-ANALYSIS, so the guard would never run and the missing table
 * would raise anyway. Agent NOTIFICATIONS hit exactly that bug in `getQueueHealth`
 * and documented it there; the two-statement form is the fix.
 */
async function tableExists(tx: Tx, table: string): Promise<boolean> {
  const { rows } = await tx.query<{ reg: string | null }>(
    `SELECT to_regclass($1)::text AS reg`, [`public.${table}`])
  return rows[0]?.reg !== null
}

/**
 * Spec §8.4 "FI refs" — WIRED.
 *
 * Table `failure_investigation`, ref column `fi_no` (`FI-YYYY-NNNN`). Gate is
 * `view_records` + `engineering`, applied by the group registry before this runs.
 *
 * The trigram index is in 20260803160000_platform_search_indexes.sql and the
 * expression below matches it CHARACTER FOR CHARACTER. ENGINEERING's own
 * `fi_no_lower_idx` is a btree on `lower(fi_no)` serving exact/prefix lookup — a
 * different expression for a different job, so the two do not collide and neither
 * makes the other redundant.
 *
 * Queried here rather than through `listFailures` because that service opens its
 * own `withTransaction` and would throw `PermissionError` on a denied module,
 * turning a partial-visibility search into an error instead of a smaller result.
 * Every group in this service is read the same way, on one connection.
 */
export async function searchFailureInvestigations(
  tx: Tx, _actor: Actor, n: Needles, limit: number,
): Promise<SearchHit[] | null> {
  if (!(await tableExists(tx, 'failure_investigation'))) return null

  const expr = `lower(translate(f.fi_no, ' -', ''))`
  const { rows } = await tx.query<{
    id: string; label: string; title: string; status: string; rank: string
  }>(
    `SELECT f.id, f.fi_no AS label, f.title, f.status,
            CASE WHEN ${expr} = $1 THEN 0
                 WHEN ${expr} LIKE $2 ESCAPE '\\' THEN 1
                 ELSE 2 END AS rank
       FROM failure_investigation f
      WHERE f.deleted_at IS NULL
        AND ${expr} LIKE $3 ESCAPE '\\'
      ORDER BY rank, f.created_at DESC, f.id DESC
      LIMIT $4`, [n.exact, n.prefix, n.contains, limit])

  // The status goes through failureStatusLabel(), never a capitalize-the-code
  // renderer: two of the six codes carry underscores, so the raw value renders as
  // "Root_cause_identified" in a palette a person is reading at speed.
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    sublabel: `${r.title} · ${failureStatusLabel(r.status)}`,
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
