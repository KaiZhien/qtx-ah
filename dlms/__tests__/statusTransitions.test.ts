import { describe, it, expect } from 'vitest'
import {
  isValidTransition,
  allowedNextStatuses,
  type TransitionStatus,
} from '@/lib/domain/statusTransitions'

// Fixture helper: a status defaults to active, non-terminal, non-initial.
function st(code: string, over: Partial<TransitionStatus> = {}): TransitionStatus {
  return { code, active: true, is_terminal: false, is_initial: false, ...over }
}

// The real seeded vocabulary (supabase/seed.sql), in sort_order. The migration
// flags Retired/Lost as terminal and Stock as initial.
const SEEDED: TransitionStatus[] = [
  st('Stock', { is_initial: true }),
  st('In Use'),
  st('Repair'),
  st('Retired', { is_terminal: true }),
  st('Lost', { is_terminal: true }),
]

// The graph the old hardcoded TRANSITIONS map encoded (membership only — the
// computed rule preserves input order, which need not match this literal order).
const LEGACY_GRAPH: Record<string, string[]> = {
  'Stock':   ['In Use', 'Repair', 'Lost', 'Retired'],
  'In Use':  ['Repair', 'Retired', 'Lost'],
  'Repair':  ['In Use', 'Retired', 'Lost'],
  'Retired': [],
  'Lost':    [],
}

const sorted = (a: string[]) => [...a].sort()

describe('allowedNextStatuses', () => {
  it('reproduces the legacy graph membership from the seeded flags', () => {
    for (const [from, expected] of Object.entries(LEGACY_GRAPH)) {
      expect(sorted(allowedNextStatuses(from, SEEDED))).toEqual(sorted(expected))
    }
  })

  it('returns [] for a terminal source', () => {
    expect(allowedNextStatuses('Retired', SEEDED)).toEqual([])
    expect(allowedNextStatuses('Lost', SEEDED)).toEqual([])
  })

  it('fails closed for an unknown source (returns [])', () => {
    expect(allowedNextStatuses('Bogus', SEEDED)).toEqual([])
    expect(allowedNextStatuses('', SEEDED)).toEqual([])
  })

  it('fails closed on an empty vocabulary', () => {
    expect(allowedNextStatuses('Stock', [])).toEqual([])
  })

  it('makes a new unflagged status reachable as a target', () => {
    const grown = [...SEEDED, st('RMA')]
    expect(allowedNextStatuses('In Use', grown)).toContain('RMA')
  })

  it('makes a new unflagged status a usable source (reachable both ways)', () => {
    const grown = [...SEEDED, st('RMA')]
    // From RMA you can reach every active, non-initial status except RMA itself.
    expect(sorted(allowedNextStatuses('RMA', grown)))
      .toEqual(sorted(['In Use', 'Repair', 'Retired', 'Lost']))
  })

  it('still yields targets when the source status is inactive (leavable)', () => {
    // A device sitting in a deactivated status must still be able to move out.
    const statuses = SEEDED.map(s => s.code === 'Repair' ? { ...s, active: false } : s)
    expect(sorted(allowedNextStatuses('Repair', statuses)))
      .toEqual(sorted(['In Use', 'Retired', 'Lost']))
  })

  it('excludes inactive, initial, and self targets', () => {
    const statuses = [...SEEDED, st('Legacy', { active: false })]
    const targets = allowedNextStatuses('In Use', statuses)
    expect(targets).not.toContain('In Use')   // self
    expect(targets).not.toContain('Stock')    // initial
    expect(targets).not.toContain('Legacy')   // inactive
  })

  it('preserves input order (sort_order pass-through)', () => {
    // Deliberately reversed input → output must follow the same order.
    const reversed = [...SEEDED].reverse()  // Lost, Retired, Repair, In Use, Stock
    expect(allowedNextStatuses('In Use', reversed)).toEqual(['Lost', 'Retired', 'Repair'])
  })
})

describe('isValidTransition', () => {
  it('allows a permitted transition', () => {
    expect(isValidTransition('Stock', 'In Use', SEEDED)).toBe(true)
    expect(isValidTransition('Repair', 'In Use', SEEDED)).toBe(true)
  })

  it('allows a move into an admin-added unflagged status', () => {
    const grown = [...SEEDED, st('RMA')]
    expect(isValidTransition('In Use', 'RMA', grown)).toBe(true)
  })

  it('rejects a move out of a terminal source', () => {
    expect(isValidTransition('Retired', 'In Use', SEEDED)).toBe(false)
    expect(isValidTransition('Lost', 'Stock', SEEDED)).toBe(false)
  })

  it('rejects a move into an initial status', () => {
    expect(isValidTransition('In Use', 'Stock', SEEDED)).toBe(false)
  })

  it('rejects a move into an inactive status', () => {
    const statuses = [...SEEDED, st('Legacy', { active: false })]
    expect(isValidTransition('In Use', 'Legacy', statuses)).toBe(false)
  })

  it('rejects a self-transition', () => {
    expect(isValidTransition('In Use', 'In Use', SEEDED)).toBe(false)
  })

  it('fails closed for an unknown source and on an empty vocabulary', () => {
    expect(isValidTransition('Bogus', 'In Use', SEEDED)).toBe(false)
    expect(isValidTransition('Stock', 'In Use', [])).toBe(false)
  })

  it('allows leaving an inactive source', () => {
    const statuses = SEEDED.map(s => s.code === 'Repair' ? { ...s, active: false } : s)
    expect(isValidTransition('Repair', 'In Use', statuses)).toBe(true)
  })
})
