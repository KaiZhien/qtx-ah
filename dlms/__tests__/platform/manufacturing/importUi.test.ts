import { describe, it, expect } from 'vitest'
import {
  resolveRowStatus, advanceCommit, ZERO_COMMIT_TOTALS, MAX_COMMIT_PASSES,
  IMPORT_ROW_STATUSES, type CommitTotals,
} from '@/modules/manufacturing/domain/importUi'

describe('resolveRowStatus', () => {
  it.each(IMPORT_ROW_STATUSES)('passes through the allowlisted status %s', (status) => {
    expect(resolveRowStatus(status)).toBe(status)
  })

  it('falls back to the default tab for anything outside the allowlist', () => {
    // The parameter reaches a SQL predicate, so the allowlist is the whole
    // defence: nothing here may survive as-is.
    for (const bad of [
      '', 'VALID', ' valid', 'valid ', 'Valid', 'committed;drop table import_row',
      "valid' OR '1'='1", '__proto__', 'constructor', 'toString', 'pending', 'null',
    ]) {
      expect(resolveRowStatus(bad)).toBe('valid')
    }
  })

  it('falls back for a repeated query key, which Next hands back as an array', () => {
    // ?status=failed&status=valid
    expect(resolveRowStatus(['failed', 'valid'])).toBe('valid')
    expect(resolveRowStatus(['failed'])).toBe('valid')
    expect(resolveRowStatus([])).toBe('valid')
  })

  it('falls back for a missing or non-string parameter', () => {
    expect(resolveRowStatus(undefined)).toBe('valid')
    expect(resolveRowStatus(null)).toBe('valid')
    expect(resolveRowStatus(0)).toBe('valid')
    expect(resolveRowStatus(true)).toBe('valid')
    expect(resolveRowStatus({ status: 'failed' })).toBe('valid')
    expect(resolveRowStatus(Object.create(null))).toBe('valid')
    expect(resolveRowStatus({ toString: () => 'failed' })).toBe('valid')
  })
})

describe('advanceCommit', () => {
  it('accumulates a pass and keeps going while rows remain', () => {
    const step = advanceCommit(ZERO_COMMIT_TOTALS,
      { committed: 180, failed: 15, skipped: 5, remaining: 300 })
    expect(step).toEqual({
      totals: { committed: 180, failed: 15, skipped: 5, passes: 1 }, stop: null,
    })
  })

  it('sums across passes', () => {
    let totals: CommitTotals = ZERO_COMMIT_TOTALS
    for (const page of [
      { committed: 200, failed: 0, skipped: 0, remaining: 400 },
      { committed: 190, failed: 10, skipped: 0, remaining: 200 },
      { committed: 195, failed: 0, skipped: 5, remaining: 0 },
    ]) {
      totals = advanceCommit(totals, page).totals
    }
    expect(totals).toEqual({ committed: 585, failed: 10, skipped: 5, passes: 3 })
  })

  it('stops as complete when nothing is left', () => {
    const step = advanceCommit(
      { committed: 400, failed: 0, skipped: 0, passes: 2 },
      { committed: 100, failed: 0, skipped: 0, remaining: 0 })
    expect(step.stop).toBe('complete')
    expect(step.totals).toEqual({ committed: 500, failed: 0, skipped: 0, passes: 3 })
  })

  it('stops as complete even when the pass itself touched nothing', () => {
    // Nothing to commit at all: 'complete' beats 'stalled', because there is
    // nothing left to stall on.
    expect(advanceCommit(ZERO_COMMIT_TOTALS,
      { committed: 0, failed: 0, skipped: 0, remaining: 0 }).stop).toBe('complete')
  })

  it('stops as stalled when a pass makes no progress but rows remain', () => {
    // Every remaining row is locked by another pass (SKIP LOCKED), or the batch
    // closed under us. Looping again would report the same thing forever with
    // the whole panel disabled — this is the guarantee the loop terminates on.
    const step = advanceCommit(
      { committed: 12, failed: 0, skipped: 0, passes: 1 },
      { committed: 0, failed: 0, skipped: 0, remaining: 7 })
    expect(step.stop).toBe('stalled')
    expect(step.totals).toEqual({ committed: 12, failed: 0, skipped: 0, passes: 2 })
  })

  it('stops at the pass cap when every pass makes progress but rows never run out', () => {
    let totals: CommitTotals = ZERO_COMMIT_TOTALS
    let stop = null as ReturnType<typeof advanceCommit>['stop']
    let iterations = 0
    // A pass that commits rows while `remaining` never falls: the shape the cap
    // exists for. Bounded well above MAX_COMMIT_PASSES so a broken cap fails
    // the assertion rather than hanging the suite.
    while (stop === null && iterations < MAX_COMMIT_PASSES * 3) {
      iterations++
      const step = advanceCommit(totals, { committed: 1, failed: 0, skipped: 0, remaining: 5 })
      totals = step.totals
      stop = step.stop
    }
    expect(stop).toBe('pass_limit')
    expect(iterations).toBe(MAX_COMMIT_PASSES)
    expect(totals.passes).toBe(MAX_COMMIT_PASSES)
  })

  it('does not mutate the totals it is given', () => {
    const totals: CommitTotals = { committed: 1, failed: 2, skipped: 3, passes: 4 }
    advanceCommit(totals, { committed: 9, failed: 9, skipped: 9, remaining: 9 })
    expect(totals).toEqual({ committed: 1, failed: 2, skipped: 3, passes: 4 })
  })
})
