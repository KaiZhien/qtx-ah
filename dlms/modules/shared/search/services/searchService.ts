import { z } from 'zod'
import { withTransaction, type Tx } from '@/lib/db/tx'
import type { Actor, ModuleKey } from '@/modules/shared/authz/catalog'
import { canSeeTask } from '@/modules/shared/tasks/domain/visibility'
import {
  visibleSearchGroups, type SearchGroupDef, type SearchGroupKey,
} from '@/modules/shared/search/domain/searchGroups'
import { searchHref } from '@/modules/shared/search/domain/searchHref'
import {
  buildNeedles, isSearchable, MAX_QUERY_LENGTH, PER_GROUP_LIMIT, type Needles,
} from '@/modules/shared/search/domain/searchQuery'
import {
  searchFailureInvestigations,
} from '@/modules/shared/search/adapters/pendingGroups'

/**
 * Global search (spec §8.4) — the I/O half.
 *
 * THE PERMISSION MODEL IS THE FEATURE, and it is enforced in one place: the
 * `visibleSearchGroups(actor)` call below decides which group queries RUN. A
 * group the actor cannot enter is never queried, so there is no result to filter,
 * no count to leak, and no timing difference to measure. A user without Finance
 * access does not learn that an invoice number exists.
 *
 * That is why this service does NOT call the modules' own read services. Each of
 * them opens its own `withTransaction` and would throw `PermissionError` on the
 * first denied module — turning a partial-visibility search into an error instead
 * of a smaller result. Instead every group's gate is transcribed into
 * SEARCH_GROUPS from that module's own service, and the queries run together on
 * ONE connection. The duplication is deliberate and pinned by the group registry
 * test; see modules/shared/search/domain/searchGroups.ts.
 *
 * ORDERING, per group: rank (0 exact, 1 prefix, 2 contains) then recency. The
 * rank is computed in SQL, before LIMIT — ranking in JS after a capped fetch
 * would rank only whichever five rows the database happened to return.
 *
 * COST CONTROL, because this runs on (debounced) every keystroke:
 *   - `isSearchable` short-circuits anything under two normalized characters, so
 *     "-" never reaches the database;
 *   - every group is capped at PER_GROUP_LIMIT rows;
 *   - a denied group costs nothing at all.
 */

const inputSchema = z.object({
  q: z.string().max(MAX_QUERY_LENGTH),
  limit: z.number().int().min(1).max(PER_GROUP_LIMIT).default(PER_GROUP_LIMIT),
})
export type SearchInput = z.input<typeof inputSchema>

export type SearchHit = {
  id: string
  /** The thing the user was searching for — a serial, a ref, a name. */
  label: string
  /** Context that disambiguates two similar hits. Never load-bearing. */
  sublabel: string | null
  /** null when the group has no detail page — see searchHref. */
  href: string | null
  rank: number
}

export type SearchGroupResult = {
  key: SearchGroupKey
  label: string
  hits: SearchHit[]
}

export type SearchResult = {
  query: string
  /** True when the query was too short/long to run. Lets the UI say so. */
  skipped: boolean
  groups: SearchGroupResult[]
}

type RankedRow = { id: string; label: string; sublabel: string | null; rank: string | number }

/**
 * The `ref` family SQL fragment: `expr` is the normalized column or expression,
 * and it must match the index in 20260803160000_platform_search_indexes.sql
 * character for character or the planner falls back to a sequential scan.
 */
const refRank = (expr: string, p: (v: unknown) => string, n: Needles) =>
  `CASE WHEN ${expr} = ${p(n.exact)} THEN 0
        WHEN ${expr} LIKE ${p(n.prefix)} ESCAPE '\\' THEN 1
        ELSE 2 END`

const nameRank = (expr: string, p: (v: unknown) => string, n: Needles) =>
  `CASE WHEN lower(${expr}) = ${p(n.exact)} THEN 0
        WHEN ${expr} ILIKE ${p(n.prefix)} ESCAPE '\\' THEN 1
        ELSE 2 END`

export async function globalSearch(actor: Actor, input: SearchInput): Promise<SearchResult> {
  const { q, limit } = inputSchema.parse(input)

  // Permission filtering happens BEFORE any connection is taken, so a denied
  // group cannot even cost a round trip. Same ordering rule as every write
  // service: authorize ahead of the connection.
  const groups = visibleSearchGroups(actor)

  if (!isSearchable(q) || groups.length === 0) {
    return { query: q, skipped: !isSearchable(q), groups: [] }
  }

  const results = await withTransaction(actor.id, async (tx) => {
    const out: SearchGroupResult[] = []
    for (const g of groups) {
      const hits = await runGroup(tx, actor, g, q, limit)
      if (hits.length > 0) out.push({ key: g.key, label: g.label, hits })
    }
    return out
  })

  return { query: q, skipped: false, groups: results }
}

async function runGroup(
  tx: Tx, actor: Actor, group: SearchGroupDef, q: string, limit: number,
): Promise<SearchHit[]> {
  const n = buildNeedles(q, group.family)
  const params: unknown[] = []
  const p = (v: unknown) => { params.push(v); return `$${params.length}` }

  const toHits = (rows: RankedRow[]): SearchHit[] => rows.map((r) => ({
    id: r.id,
    label: r.label,
    sublabel: r.sublabel,
    href: searchHref(group.key, r.id),
    rank: Number(r.rank),
  }))

  switch (group.key) {
    case 'devices': {
      // device_sn_normalized already carries the ref normalization (fn_device_normalize),
      // and pcba_a_sn_legacy is normalized inline — the legacy serial IS the identity
      // for most migrated rows, where device_sn is blank.
      const sn = 'd.device_sn_normalized'
      const legacy = `lower(translate(coalesce(d.pcba_a_sn_legacy, ''), ' -', ''))`
      const rank = refRank(sn, p, n)
      const { rows } = await tx.query<RankedRow>(
        `SELECT d.id,
                coalesce(d.device_sn, d.pcba_a_sn_legacy, '(no serial)') AS label,
                v.name AS sublabel,
                ${rank} AS rank
           FROM device d
           JOIN device_variant v ON v.id = d.variant_id
          WHERE d.deleted_at IS NULL
            AND (${sn} LIKE ${p(n.contains)} ESCAPE '\\'
                 OR ${legacy} LIKE ${p(n.contains)} ESCAPE '\\')
          ORDER BY rank, d.created_at DESC, d.id DESC
          LIMIT ${p(limit)}`, params)
      return toHits(rows)
    }

    case 'components': {
      const sn = 'cu.serial_no_normalized'
      const rank = refRank(sn, p, n)
      const { rows } = await tx.query<RankedRow>(
        `SELECT cu.id, cu.serial_no AS label, ct.name AS sublabel, ${rank} AS rank
           FROM component_unit cu
           JOIN component_type ct ON ct.id = cu.component_type_id
          WHERE cu.deleted_at IS NULL
            AND ${sn} LIKE ${p(n.contains)} ESCAPE '\\'
          ORDER BY rank, cu.created_at DESC, cu.id DESC
          LIMIT ${p(limit)}`, params)
      return toHits(rows)
    }

    case 'repairs': {
      const expr = `lower(translate(r.repair_no, ' -', ''))`
      const rank = refRank(expr, p, n)
      const { rows } = await tx.query<RankedRow>(
        `SELECT r.id, r.repair_no AS label,
                coalesce(d.device_sn, d.pcba_a_sn_legacy) AS sublabel, ${rank} AS rank
           FROM repair r
           JOIN device d ON d.id = r.device_id
          WHERE r.deleted_at IS NULL
            AND ${expr} LIKE ${p(n.contains)} ESCAPE '\\'
          ORDER BY rank, r.created_at DESC, r.id DESC
          LIMIT ${p(limit)}`, params)
      return toHits(rows)
    }

    case 'modifications': {
      const expr = `m.modification_no`
      const norm = `lower(translate(${expr}, ' -', ''))`
      const rank = refRank(norm, p, n)
      const { rows } = await tx.query<RankedRow>(
        `SELECT m.id, m.modification_no AS label,
                coalesce(d.device_sn, d.pcba_a_sn_legacy) AS sublabel, ${rank} AS rank
           FROM modification m
           JOIN device d ON d.id = m.device_id
          WHERE m.deleted_at IS NULL
            AND ${norm} LIKE ${p(n.contains)} ESCAPE '\\'
          ORDER BY rank, m.created_at DESC, m.id DESC
          LIMIT ${p(limit)}`, params)
      return toHits(rows)
    }

    case 'ecrs': {
      const expr = `lower(translate(e.ecr_no, ' -', ''))`
      const rank = refRank(expr, p, n)
      const { rows } = await tx.query<RankedRow>(
        `SELECT e.id, e.ecr_no AS label, e.title AS sublabel, ${rank} AS rank
           FROM ecr e
          WHERE e.deleted_at IS NULL
            AND ${expr} LIKE ${p(n.contains)} ESCAPE '\\'
          ORDER BY rank, e.created_at DESC, e.id DESC
          LIMIT ${p(limit)}`, params)
      return toHits(rows)
    }

    case 'ecos': {
      const expr = `lower(translate(e.eco_no, ' -', ''))`
      const rank = refRank(expr, p, n)
      const { rows } = await tx.query<RankedRow>(
        `SELECT e.id, e.eco_no AS label, e.title AS sublabel, ${rank} AS rank
           FROM eco e
          WHERE e.deleted_at IS NULL
            AND ${expr} LIKE ${p(n.contains)} ESCAPE '\\'
          ORDER BY rank, e.created_at DESC, e.id DESC
          LIMIT ${p(limit)}`, params)
      return toHits(rows)
    }

    case 'invoices': {
      const expr = `lower(translate(i.invoice_no, ' -', ''))`
      const rank = refRank(expr, p, n)
      const { rows } = await tx.query<RankedRow>(
        `SELECT i.id, i.invoice_no AS label, b.name AS sublabel, ${rank} AS rank
           FROM sales_invoice i
           JOIN buyer b ON b.id = i.buyer_id
          WHERE i.deleted_at IS NULL
            AND ${expr} LIKE ${p(n.contains)} ESCAPE '\\'
          ORDER BY rank, i.created_at DESC, i.id DESC
          LIMIT ${p(limit)}`, params)
      return toHits(rows)
    }

    case 'deliveryOrders': {
      const expr = `lower(translate(o.do_no, ' -', ''))`
      const rank = refRank(expr, p, n)
      const { rows } = await tx.query<RankedRow>(
        `SELECT o.id, o.do_no AS label, o.customer AS sublabel, ${rank} AS rank
           FROM delivery_order o
          WHERE o.deleted_at IS NULL
            AND ${expr} LIKE ${p(n.contains)} ESCAPE '\\'
          ORDER BY rank, o.created_at DESC, o.id DESC
          LIMIT ${p(limit)}`, params)
      return toHits(rows)
    }

    case 'buyers': {
      const rank = nameRank('b.name', p, n)
      const { rows } = await tx.query<RankedRow>(
        `SELECT b.id, b.name AS label, b.country AS sublabel, ${rank} AS rank
           FROM buyer b
          WHERE b.deleted_at IS NULL
            AND b.name ILIKE ${p(n.contains)} ESCAPE '\\'
          ORDER BY rank, b.created_at DESC, b.id DESC
          LIMIT ${p(limit)}`, params)
      return toHits(rows)
    }

    case 'users': {
      const rank = nameRank('u.full_name', p, n)
      const { rows } = await tx.query<RankedRow>(
        `SELECT u.id, u.full_name AS label, u.email AS sublabel, ${rank} AS rank
           FROM app_user u
          WHERE u.deleted_at IS NULL
            AND (u.full_name ILIKE ${p(n.contains)} ESCAPE '\\'
                 OR u.email ILIKE ${p(n.contains)} ESCAPE '\\')
          ORDER BY rank, u.full_name, u.id
          LIMIT ${p(limit)}`, params)
      return toHits(rows)
    }

    case 'failures':
      // Lives in the adapter because agent ENGINEERING's `failure_investigation`
      // is on another branch. It guards on table existence and returns null until
      // that migration lands — `runGroup`'s caller drops an empty group, so an
      // unapplied migration costs a `to_regclass` lookup and nothing else. Without
      // that guard a missing relation would abort the whole search transaction,
      // taking every OTHER group down with it rather than just this one.
      return (await searchFailureInvestigations(tx, actor, n, limit)) ?? []

    case 'tasks':
      return searchTasks(tx, actor, params, p, n, limit)
  }
}

/**
 * Tasks carry a SECOND gate the group registry cannot express: the two-gate
 * visibility rule (spec §8.3) — confidential tasks are creator/assignee/Admin
 * only, and a task linked to a Finance record inherits that module's gate.
 *
 * `canSeeTask` is the SAME pure function the task list and the task detail page
 * use. Spec §8.3 requires exactly that: link-derived confidentiality is computed
 * at query time "so search/autocomplete can't leak them" — search must never
 * surface a task the detail page would refuse.
 *
 * OVER-FETCH THEN FILTER. The visibility rule needs every link's module, so it
 * cannot be a WHERE clause without restating the rule in SQL and letting the two
 * copies drift. Instead the query takes a wider slice, filters it with the real
 * rule, and returns the first `limit` survivors. The over-fetch factor is the
 * price: a user whose visible tasks are all beyond the slice sees fewer hits than
 * exist. Same shape as the carried finding on the task list's `LIMIT 200`, and
 * acceptable here because the palette is a jump-to, not a report.
 */
const TASK_OVERFETCH = 5

async function searchTasks(
  tx: Tx, actor: Actor,
  params: unknown[], p: (v: unknown) => string,
  n: Needles, limit: number,
): Promise<SearchHit[]> {
  const rank = nameRank('t.title', p, n)
  const { rows } = await tx.query<RankedRow & {
    created_by: string; assignee_id: string | null
    confidential: boolean; linked_modules: string[] | null
  }>(
    `SELECT t.id, t.title AS label, t.status AS sublabel, ${rank} AS rank,
            t.created_by, t.assignee_id, t.confidential,
            array_remove(array_agg(DISTINCT l.module), NULL) AS linked_modules
       FROM task t
       LEFT JOIN task_link l ON l.task_id = t.id
      WHERE t.deleted_at IS NULL
        AND t.title ILIKE ${p(n.contains)} ESCAPE '\\'
      GROUP BY t.id, t.title, t.status, t.created_by, t.assignee_id, t.confidential, t.created_at
      ORDER BY rank, t.created_at DESC, t.id DESC
      LIMIT ${p(limit * TASK_OVERFETCH)}`, params)

  return rows
    .filter((r) => canSeeTask(actor, {
      createdBy: r.created_by,
      assigneeId: r.assignee_id,
      confidential: r.confidential,
      linkedModules: (r.linked_modules ?? []) as ModuleKey[],
    }))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      label: r.label,
      sublabel: r.sublabel,
      href: searchHref('tasks', r.id),
      rank: Number(r.rank),
    }))
}
