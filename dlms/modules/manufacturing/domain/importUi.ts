/**
 * The two pieces of decision logic the import UI runs, extracted so they can be
 * unit-tested: a page and a client component are not testable surfaces in this
 * codebase, and both of these are non-trivial enough to deserve tests.
 *
 * Pure by contract — no database, no fetch, no file system, no clock. Imported
 * by both a server page and a client component, so it must also stay free of
 * anything that would drag the service layer (and `pg`) into the browser bundle:
 * this module deliberately depends on nothing.
 */

/**
 * Every resting state a staging row can be in, in the order the review tabs
 * show them. The canonical list lives here rather than in the service so that a
 * client component can read it without importing the service.
 */
export const IMPORT_ROW_STATUSES = [
  'valid', 'needs_review', 'invalid', 'committed', 'skipped', 'failed',
] as const

export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number]

/**
 * How many rows one `listImportRows` call returns. Shared with the review table,
 * which uses it to tell whether the page it was handed is the whole story: the
 * counts and the rows come from two different transactions, so comparing them
 * to each other reports a phantom truncation whenever a concurrent skip lands
 * between the two reads.
 */
export const IMPORT_ROW_PAGE_LIMIT = 2000

/**
 * Which status tab `?status=` selects. The parameter is attacker-controlled and
 * arrives as `string | string[] | undefined` (Next gives an array for a repeated
 * key), so everything outside the allowlist — an array, an object, a prototype
 * key, a near-miss like `VALID` — falls back to the default tab rather than
 * reaching a SQL parameter.
 */
export function resolveRowStatus(param: unknown): ImportRowStatus {
  if (typeof param !== 'string') return 'valid'
  return (IMPORT_ROW_STATUSES as readonly string[]).includes(param)
    ? (param as ImportRowStatus)
    : 'valid'
}

/** Running totals across a multi-pass commit. */
export type CommitTotals = {
  committed: number; failed: number; skipped: number
  /** How many server round trips have completed. */
  passes: number
}

/** What one `commitBatchAction` pass reported. */
export type CommitPage = {
  committed: number; failed: number; skipped: number; remaining: number
}

/** Why the commit loop stopped, or null while it should keep going. */
export type CommitStop = 'complete' | 'stalled' | 'pass_limit'

export type CommitStep = { totals: CommitTotals; stop: CommitStop | null }

export const ZERO_COMMIT_TOTALS: CommitTotals = {
  committed: 0, failed: 0, skipped: 0, passes: 0,
}

/**
 * A commit pass is capped at 500 rows, so 200 passes is 100,000 rows — far past
 * any real traceability sheet. The cap exists so an unforeseen shape (a pass
 * that reports progress without reducing `remaining`) ends with a message
 * instead of spinning forever behind a disabled panel.
 */
export const MAX_COMMIT_PASSES = 200

/**
 * Fold one pass's result into the running totals and decide whether to go again.
 *
 * Three stop conditions, in priority order:
 *  - `complete`  — nothing is left to commit.
 *  - `stalled`   — rows remain but this pass touched none of them. Every
 *                  remaining row is held by another pass, or the batch closed
 *                  under us; another round trip would report the same thing.
 *  - `pass_limit`— the belt-and-braces bound above.
 */
export function advanceCommit(totals: CommitTotals, page: CommitPage): CommitStep {
  const next: CommitTotals = {
    committed: totals.committed + page.committed,
    failed: totals.failed + page.failed,
    skipped: totals.skipped + page.skipped,
    passes: totals.passes + 1,
  }
  if (page.remaining === 0) return { totals: next, stop: 'complete' }
  if (page.committed + page.failed + page.skipped === 0) {
    return { totals: next, stop: 'stalled' }
  }
  if (next.passes >= MAX_COMMIT_PASSES) return { totals: next, stop: 'pass_limit' }
  return { totals: next, stop: null }
}
