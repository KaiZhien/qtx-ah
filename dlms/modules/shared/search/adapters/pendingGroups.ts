import type { Tx } from '@/lib/db/tx'
import type { Actor } from '@/modules/shared/authz/catalog'
import type { SearchHit } from '@/modules/shared/search/services/searchService'
import type { Needles } from '@/modules/shared/search/domain/searchQuery'

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
 * Spec §8.4 "FI refs".
 *
 * OWNER: agent ENGINEERING (`failure_investigation`). NOT WIRED — the table does
 * not exist on `main`.
 *
 * TO IMPLEMENT: the ref family. Index the human reference column exactly as
 * 20260803160000_platform_search_indexes.sql does for the other refs —
 * `gin (lower(translate(fi_no, ' -', '')) gin_trgm_ops)` — and query with the
 * same expression, character for character, or the planner will not use it. Gate:
 * `authorize(actor, 'view_records', 'engineering')`.
 */
export async function searchFailureInvestigations(
  _tx: Tx, _actor: Actor, _n: Needles, _limit: number,
): Promise<SearchHit[] | null> {
  return null
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
