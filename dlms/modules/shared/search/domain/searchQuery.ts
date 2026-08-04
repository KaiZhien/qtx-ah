/**
 * The pure half of global search (spec §8.4) — normalization, escaping, and the
 * ordering rule. No I/O, so every rule below is unit-testable without a database.
 *
 * TWO NORMALIZATION FAMILIES, DELIBERATELY. They are not interchangeable and the
 * SQL side must use the matching expression index or the query silently falls
 * back to a sequential scan:
 *
 *   'ref'  — device SNs, component SNs, invoice/DO numbers, REP-/MOD-/ECR-/ECO-
 *            refs. Lowercased with whitespace AND hyphens stripped, because
 *            people type "00412" or "REP 2026 0001" for "QTX-P-00412" /
 *            "REP-2026-0001". This is the EXACT normalization
 *            device_sn_normalized and component_unit.serial_no_normalized
 *            already carry (fn_device_normalize / fn_component_unit_normalize),
 *            which is why those two columns need no new index.
 *
 *   'name' — buyer names, task titles, user names. Lowercased and
 *            whitespace-collapsed, but separators are KEPT. Stripping them would
 *            fold "Acme Corp" and "AcmeCorp" together, and word boundaries are
 *            most of what makes a name searchable. Matched with ILIKE against the
 *            raw column, which gin_trgm_ops supports directly.
 *
 * Changing either normalization is a migration, not a code change: the expression
 * indexes in 20260803160000_platform_search_indexes.sql transcribe them.
 */

/**
 * Below this, a query is not run at all. Two characters is the point where a
 * trigram index stops being useful — pg_trgm indexes 3-grams, so a 1-character
 * needle degenerates to a full scan of every table in every group at once.
 */
export const MIN_QUERY_LENGTH = 2

/** Mirrors deviceReadService's `q: z.string().max(100)` filter bound. */
export const MAX_QUERY_LENGTH = 100

/**
 * Rows returned per group. Global search fires one query per permitted group on
 * (debounced) every keystroke, so this is a latency budget, not a page size — the
 * palette shows the best few per group and links to the module's own list page
 * for the rest.
 */
export const PER_GROUP_LIMIT = 5

/** Reference/serial family: lowercase, strip ALL whitespace and hyphens. */
export function normalizeRef(raw: string): string {
  return raw.toLowerCase().replace(/[\s-]/g, '')
}

/**
 * Name/title family: lowercase, collapse whitespace runs, trim. Separators kept.
 *
 * ── THE COLLAPSE IS ONE-SIDED, AND KNOWING WHICH SIDE MATTERS ──────────────
 * This normalizes the QUERY. The COLUMN is matched raw — `b.name ILIKE '%…%'` —
 * because the name-family index is a plain `gin_trgm_ops` over the raw column
 * (20260803160000_platform_search_indexes.sql), and gin_trgm_ops supports ILIKE
 * on it directly. So the two directions are not symmetric:
 *
 *   typed "acme  corp"  → "acme corp"  → MATCHES a stored "Acme Corp"   ✓
 *   typed "acme corp"   → "acme corp"  → MISSES  a stored "Acme  Corp"  ✗
 *
 * The collapse fixes sloppy typing, which is the common case; it cannot fix a
 * doubled space in the stored value, which is the rare one. Closing that second
 * gap means matching `regexp_replace(lower(name), '\s+', ' ', 'g')`, and a
 * Postgres expression index is used only when the query's expression matches it
 * character for character — so it is a MIGRATION (a new expression index on
 * every name-family column), not a change to this function. Editing only the
 * TypeScript would leave the predicate unable to use any index and turn every
 * keystroke into a sequential scan of every searchable table at once, which is
 * the failure this module's header warns about. Left as-is deliberately; see the
 * carried findings.
 */
export function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Escapes the LIKE/ILIKE metacharacters, backslash FIRST.
 *
 * Order is load-bearing: escaping `%` before `\` would turn the input `\` into
 * `\\` only after it had already been used to escape something, and a serial
 * containing `%` would act as a wildcard against every row in the table. Every
 * LIKE/ILIKE in the search service must therefore carry `ESCAPE '\'`.
 */
export function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/[%_]/g, (c) => `\\${c}`)
}

export type SearchFamily = 'ref' | 'name'

export function normalizeFor(raw: string, family: SearchFamily): string {
  return family === 'ref' ? normalizeRef(raw) : normalizeName(raw)
}

/**
 * Whether this query is worth running at all.
 *
 * Length is measured AFTER normalization on purpose. "--" and "- -" are two and
 * three characters of user input that normalize to the empty string in the ref
 * family; without this, they would reach the database as `LIKE '%%'` and scan
 * every searchable table at once. The check uses the ref family because it is the
 * more aggressive of the two — anything it reduces below the floor is not a query.
 */
export function isSearchable(raw: string): boolean {
  if (raw.length > MAX_QUERY_LENGTH) return false
  return normalizeRef(raw).length >= MIN_QUERY_LENGTH
}

export type Needles = {
  /** Compared with `=`. Never escaped — escaping is a LIKE concern only. */
  exact: string
  /** `needle%` — escaped, used with `LIKE … ESCAPE '\'`. */
  prefix: string
  /** `%needle%` — escaped, used with `LIKE … ESCAPE '\'`. */
  contains: string
}

export function buildNeedles(raw: string, family: SearchFamily): Needles {
  const normalized = normalizeFor(raw, family)
  const escaped = escapeLike(normalized)
  return { exact: normalized, prefix: `${escaped}%`, contains: `%${escaped}%` }
}

/**
 * THE ORDERING RULE (spec §8.4 "exact + prefix + trigram partial"), as a number:
 * 0 exact, 1 prefix, 2 contains, null no match.
 *
 * Lower sorts first. The service transcribes this as a SQL CASE so Postgres can
 * apply it before LIMIT — ranking in JS after a capped fetch would rank only
 * whichever rows the database happened to return, which is the bug this shape
 * exists to prevent. Within a rank, rows are ordered by recency.
 *
 * Exact is checked before prefix because an exact match is also a prefix match,
 * and reporting rank 1 for it would sort the row the user actually typed below
 * rows that merely start with it.
 */
export type MatchRank = 0 | 1 | 2

export function rankOf(candidate: string, needle: string): MatchRank | null {
  if (candidate === needle) return 0
  if (candidate.startsWith(needle)) return 1
  if (candidate.includes(needle)) return 2
  return null
}
