import { describe, it, expect } from 'vitest'
import {
  APPROVAL_STATUSES, APPROVAL_KINDS,
  APPROVAL_STATUS_LABELS, APPROVAL_KIND_LABELS,
  approvalStatusLabel, approvalKindLabel,
  DECISION_ERROR_CODES, evaluateDecision, messageForDecisionError,
  ApprovalDecisionError,
  snapshotsAgree, describeSnapshotDrift, DRIFT_VALUE_MAX,
  type ApprovalStatus, type DecisionFacts, type ApprovalDecision,
} from '@/modules/shared/approvals/domain/approvalDecision'

// Two distinct actors. Real ids are uuids; the domain only ever compares them.
const REQUESTER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

const facts = (over: Partial<DecisionFacts> = {}): DecisionFacts => ({
  status: 'pending',
  requestedBy: REQUESTER,
  deciderId: OTHER,
  deciderCanApprove: true,
  ...over,
})

describe('approval vocabulary (mirrors the CHECK sets in 20260802000000_platform_approvals.sql)', () => {
  it('defines exactly the three statuses the database allows', () => {
    expect(APPROVAL_STATUSES).toEqual(['pending', 'approved', 'rejected'])
  })

  it('defines exactly the three kinds the database allows (spec BR-4)', () => {
    expect(APPROVAL_KINDS).toEqual(['eco', 'invoice', 'repair_signoff'])
  })

  it('labels every status and every kind', () => {
    for (const s of APPROVAL_STATUSES) expect(APPROVAL_STATUS_LABELS[s]).toBeTruthy()
    for (const k of APPROVAL_KINDS) expect(APPROVAL_KIND_LABELS[k]).toBeTruthy()
  })

  it('falls back to the raw code for an unknown status or kind rather than rendering undefined', () => {
    expect(approvalStatusLabel('pending')).toBe('Pending')
    expect(approvalStatusLabel('nonsense')).toBe('nonsense')
    expect(approvalKindLabel('eco')).toMatch(/engineering change/i)
    expect(approvalKindLabel('nonsense')).toBe('nonsense')
  })
})

describe('evaluateDecision — the full matrix (status x self/other x permission)', () => {
  // Every combination, stated explicitly rather than derived, so the expected
  // outcome of each cell is reviewable on its own line.
  const matrix: [ApprovalStatus, 'self' | 'other', boolean, ApprovalDecision][] = [
    // pending: the only state in which a decision is possible at all.
    ['pending', 'other', true, { ok: true }],
    ['pending', 'other', false, { ok: false, error: 'permission_denied' }],
    ['pending', 'self', true, { ok: false, error: 'self_approval' }],
    ['pending', 'self', false, { ok: false, error: 'permission_denied' }],
    // approved / rejected are terminal: nothing about the actor can revive them.
    ['approved', 'other', true, { ok: false, error: 'already_decided' }],
    ['approved', 'other', false, { ok: false, error: 'already_decided' }],
    ['approved', 'self', true, { ok: false, error: 'already_decided' }],
    ['approved', 'self', false, { ok: false, error: 'already_decided' }],
    ['rejected', 'other', true, { ok: false, error: 'already_decided' }],
    ['rejected', 'other', false, { ok: false, error: 'already_decided' }],
    ['rejected', 'self', true, { ok: false, error: 'already_decided' }],
    ['rejected', 'self', false, { ok: false, error: 'already_decided' }],
  ]

  it.each(matrix)(
    'status=%s decider=%s canApprove=%s',
    (status, who, deciderCanApprove, expected) => {
      expect(evaluateDecision(facts({
        status,
        deciderCanApprove,
        deciderId: who === 'self' ? REQUESTER : OTHER,
      }))).toEqual(expected)
    },
  )

  it('covers every cell of the matrix (3 statuses x 2 actors x 2 permissions)', () => {
    expect(matrix).toHaveLength(APPROVAL_STATUSES.length * 2 * 2)
  })

  it('accepts the one case that should be accepted: a pending request, a different actor, with permission', () => {
    expect(evaluateDecision(facts())).toEqual({ ok: true })
  })
})

describe('evaluateDecision — nobody decides their own request', () => {
  it('refuses a requester who HOLDS approve_requests — the rule the domain exists to make unforgettable', () => {
    expect(evaluateDecision(facts({ deciderId: REQUESTER, deciderCanApprove: true })))
      .toEqual({ ok: false, error: 'self_approval' })
  })

  it('compares actor identity case-insensitively — a uuid is hex, so a case mismatch must not slip the rule', () => {
    expect(evaluateDecision(facts({
      requestedBy: REQUESTER.toUpperCase(),
      deciderId: REQUESTER.toLowerCase(),
      deciderCanApprove: true,
    }))).toEqual({ ok: false, error: 'self_approval' })
  })

  it('ignores surrounding whitespace when comparing actors (fails closed, never open)', () => {
    expect(evaluateDecision(facts({
      requestedBy: `  ${REQUESTER}  `,
      deciderId: REQUESTER,
      deciderCanApprove: true,
    }))).toEqual({ ok: false, error: 'self_approval' })
  })

  it('treats two blank ids as the same actor rather than as two strangers', () => {
    expect(evaluateDecision(facts({ requestedBy: '', deciderId: '', deciderCanApprove: true })))
      .toEqual({ ok: false, error: 'self_approval' })
  })

  it('still allows a genuinely different actor whose id merely looks similar', () => {
    expect(evaluateDecision(facts({ requestedBy: REQUESTER, deciderId: OTHER })))
      .toEqual({ ok: true })
  })
})

describe('evaluateDecision — a decision is final in both directions', () => {
  it('refuses a second decision on an approved request', () => {
    expect(evaluateDecision(facts({ status: 'approved' })))
      .toEqual({ ok: false, error: 'already_decided' })
  })

  it('refuses a second decision on a rejected request (re-request instead, never reopen)', () => {
    expect(evaluateDecision(facts({ status: 'rejected' })))
      .toEqual({ ok: false, error: 'already_decided' })
  })

  it('checks the terminal state before anything about the actor', () => {
    // A decided request is finished regardless of who is asking, so the message
    // should describe the record rather than the person.
    expect(evaluateDecision(facts({
      status: 'approved', deciderId: REQUESTER, deciderCanApprove: false,
    }))).toEqual({ ok: false, error: 'already_decided' })
  })

  it('fails closed on a status outside the vocabulary rather than treating it as pending', () => {
    expect(evaluateDecision(facts({ status: 'nonsense' as ApprovalStatus })))
      .toEqual({ ok: false, error: 'already_decided' })
  })
})

describe('evaluateDecision — permission', () => {
  it('refuses a decider without approve_requests', () => {
    expect(evaluateDecision(facts({ deciderCanApprove: false })))
      .toEqual({ ok: false, error: 'permission_denied' })
  })

  it('reports the missing permission ahead of the self-approval rule, mirroring the service gate order', () => {
    expect(evaluateDecision(facts({ deciderId: REQUESTER, deciderCanApprove: false })))
      .toEqual({ ok: false, error: 'permission_denied' })
  })
})

describe('decision error messages', () => {
  it('produces a distinct, non-empty message per code', () => {
    const messages = DECISION_ERROR_CODES.map(messageForDecisionError)
    for (const m of messages) expect(m.length).toBeGreaterThan(0)
    expect(new Set(messages).size).toBe(DECISION_ERROR_CODES.length)
  })

  it('says what each refusal actually means', () => {
    expect(messageForDecisionError('already_decided')).toMatch(/already|decided/i)
    expect(messageForDecisionError('self_approval')).toMatch(/own request/i)
    expect(messageForDecisionError('permission_denied')).toMatch(/permission/i)
  })

  it('carries the code on the typed error, in the shape the other domains use', () => {
    const err = new ApprovalDecisionError('self_approval', messageForDecisionError('self_approval'))
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ApprovalDecisionError')
    expect(err.code).toBe('self_approval')
    expect(err.message).toMatch(/own request/i)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Snapshot comparison — the correctness heart of the engine.
// ───────────────────────────────────────────────────────────────────────────

describe('snapshotsAgree — identical content', () => {
  it('agrees with itself', () => {
    const snap = { total: '12000.00', buyer: 'Acme', lines: [{ qty: 2 }] }
    expect(snapshotsAgree(snap, snap)).toBe(true)
    expect(snapshotsAgree(snap, structuredClone(snap))).toBe(true)
  })

  it('agrees on two empty objects (the DB forbids them; the function must not crash on one)', () => {
    expect(snapshotsAgree({}, {})).toBe(true)
  })
})

describe('snapshotsAgree — key order is NOT significant', () => {
  // jsonb does not preserve key order, so an order-sensitive comparison would
  // report drift on every single approval that round-trips through Postgres.
  it('agrees when the same keys arrive in a different order', () => {
    expect(snapshotsAgree(
      { total: '12000.00', buyer: 'Acme', invoiceNo: 'INV-1' },
      { invoiceNo: 'INV-1', total: '12000.00', buyer: 'Acme' },
    )).toBe(true)
  })

  it('agrees when a NESTED object is reordered too', () => {
    expect(snapshotsAgree(
      { buyer: { name: 'Acme', country: 'SG' } },
      { buyer: { country: 'SG', name: 'Acme' } },
    )).toBe(true)
  })
})

describe('snapshotsAgree — the change the engine exists to catch', () => {
  it('disagrees when the invoice total was edited after approval', () => {
    expect(snapshotsAgree({ total: '12000.00' }, { total: '18500.00' })).toBe(false)
  })

  it('disagrees on a nested change', () => {
    expect(snapshotsAgree(
      { buyer: { name: 'Acme', country: 'SG' } },
      { buyer: { name: 'Acme', country: 'MY' } },
    )).toBe(false)
  })

  it('disagrees on a change buried in an array element', () => {
    expect(snapshotsAgree(
      { lines: [{ qty: 2, price: '10.00' }, { qty: 1, price: '5.00' }] },
      { lines: [{ qty: 2, price: '10.00' }, { qty: 1, price: '9.00' }] },
    )).toBe(false)
  })
})

describe('snapshotsAgree — numbers that arrive as strings from the driver', () => {
  // node-postgres returns `numeric` (and `bigint`) columns as STRINGS. A snapshot
  // built from a zod-parsed JS number and a re-read built from a driver row
  // therefore differ in TYPE while describing the same money. Refusing those
  // would report drift on every unchanged invoice, so a number and a well-formed
  // decimal string are compared BY VALUE.
  it('agrees between a JS number and the same amount as a numeric string', () => {
    expect(snapshotsAgree({ total: 12000 }, { total: '12000.00' })).toBe(true)
    expect(snapshotsAgree({ total: '12000.00' }, { total: 12000 })).toBe(true)
  })

  it('agrees on 0 vs "0" — and on 0 vs "0.00"', () => {
    expect(snapshotsAgree({ tax: 0 }, { tax: '0' })).toBe(true)
    expect(snapshotsAgree({ tax: 0 }, { tax: '0.00' })).toBe(true)
    expect(snapshotsAgree({ tax: -0 }, { tax: '0' })).toBe(true)
  })

  it('still disagrees when the numeric VALUE changed, whatever the types', () => {
    expect(snapshotsAgree({ total: 12000 }, { total: '18500.00' })).toBe(false)
    expect(snapshotsAgree({ total: '12000.00' }, { total: 18500 })).toBe(false)
  })

  it('compares as decimal text, not as floats — no precision collapse on long numerics', () => {
    // Number("12000.000000000000000001") === 12000, so a Number()-based
    // comparison would call these equal and wave through a real edit.
    expect(snapshotsAgree(
      { total: 12000 }, { total: '12000.000000000000000001' },
    )).toBe(false)
    expect(snapshotsAgree(
      { id: 10000000000000000000 }, { id: '10000000000000000001' },
    )).toBe(false)
  })

  it('accepts a bigint against its decimal string (bigint columns arrive as strings too)', () => {
    // BigInt(...) rather than a `n` literal: tsconfig targets ES2017.
    const n = BigInt('10000000000000000001')
    expect(snapshotsAgree({ n }, { n: '10000000000000000001' })).toBe(true)
    expect(snapshotsAgree({ n }, { n: '10000000000000000002' })).toBe(false)
  })

  it('does NOT apply the numeric rule between two strings — "0012" is not "12"', () => {
    // Invoice numbers, serials and part codes carry meaningful leading zeros.
    expect(snapshotsAgree({ invoiceNo: '0012' }, { invoiceNo: '12' })).toBe(false)
    expect(snapshotsAgree({ total: '12000.00' }, { total: '12000.000' })).toBe(false)
  })

  it('never coerces a non-numeric string, or a boolean, into a number', () => {
    expect(snapshotsAgree({ v: 0 }, { v: '' })).toBe(false)
    expect(snapshotsAgree({ v: 0 }, { v: '   ' })).toBe(false)
    expect(snapshotsAgree({ v: 0 }, { v: false })).toBe(false)
    expect(snapshotsAgree({ v: 1 }, { v: true })).toBe(false)
    expect(snapshotsAgree({ v: true }, { v: 'true' })).toBe(false)
    expect(snapshotsAgree({ v: 16 }, { v: '0x10' })).toBe(false)
    expect(snapshotsAgree({ v: 1000 }, { v: '1,000' })).toBe(false)
    expect(snapshotsAgree({ v: 0 }, { v: null })).toBe(false)
  })

  it('treats a non-finite number as not comparable (fails closed)', () => {
    expect(snapshotsAgree({ v: NaN }, { v: NaN })).toBe(false)
    expect(snapshotsAgree({ v: Infinity }, { v: '1e400' })).toBe(false)
  })
})

describe('snapshotsAgree — null versus a missing key', () => {
  // jsonb distinguishes them, and so does this: a field that VANISHED from the
  // projection is a different event from a field that was set to null, and both
  // deserve to be named in a refusal.
  it('disagrees between an explicit null and an absent key', () => {
    expect(snapshotsAgree({ note: null }, {})).toBe(false)
    expect(snapshotsAgree({}, { note: null })).toBe(false)
  })

  it('agrees between two explicit nulls', () => {
    expect(snapshotsAgree({ note: null }, { note: null })).toBe(true)
  })

  it('treats an undefined-valued key as ABSENT — jsonb cannot store it, so it must not read as drift', () => {
    expect(snapshotsAgree({ note: undefined }, {})).toBe(true)
    expect(snapshotsAgree({ a: 1, note: undefined }, { a: 1 })).toBe(true)
    // ...and undefined is still not null.
    expect(snapshotsAgree({ note: undefined }, { note: null })).toBe(false)
  })
})

describe('snapshotsAgree — arrays', () => {
  it('agrees on identical arrays', () => {
    expect(snapshotsAgree({ lines: [1, 2, 3] }, { lines: [1, 2, 3] })).toBe(true)
  })

  it('treats array ORDER as significant, unlike object key order', () => {
    // Line 1 and line 2 of an invoice are not interchangeable.
    expect(snapshotsAgree({ lines: [1, 2, 3] }, { lines: [3, 2, 1] })).toBe(false)
    expect(snapshotsAgree(
      { lines: [{ sku: 'A' }, { sku: 'B' }] },
      { lines: [{ sku: 'B' }, { sku: 'A' }] },
    )).toBe(false)
  })

  it('disagrees when an element was added or removed', () => {
    expect(snapshotsAgree({ lines: [1, 2] }, { lines: [1, 2, 3] })).toBe(false)
    expect(snapshotsAgree({ lines: [1, 2, 3] }, { lines: [1, 2] })).toBe(false)
  })

  it('agrees on two empty arrays and on nested arrays', () => {
    expect(snapshotsAgree({ lines: [] }, { lines: [] })).toBe(true)
    expect(snapshotsAgree({ m: [[1, 2], [3]] }, { m: [[1, 2], [3]] })).toBe(true)
    expect(snapshotsAgree({ m: [[1, 2], [3]] }, { m: [[1, 2], [4]] })).toBe(false)
  })

  it('never confuses an array with an object', () => {
    expect(snapshotsAgree({ v: [] }, { v: {} })).toBe(false)
    expect(snapshotsAgree({ v: [1] }, { v: { 0: 1 } })).toBe(false)
  })

  it('reads a hole or an undefined element as null, exactly as JSON.stringify would', () => {
    expect(snapshotsAgree({ v: [1, undefined] }, { v: [1, null] })).toBe(true)
  })
})

describe('snapshotsAgree — values a naive deep-equal mishandles', () => {
  it('compares a Date against its ISO string (a jsonb round-trip produces the string)', () => {
    const iso = '2026-08-02T00:00:00.000Z'
    expect(snapshotsAgree({ at: new Date(iso) }, { at: iso })).toBe(true)
    expect(snapshotsAgree({ at: new Date(iso) }, { at: new Date(iso) })).toBe(true)
    expect(snapshotsAgree({ at: new Date(iso) }, { at: '2026-08-03T00:00:00.000Z' })).toBe(false)
  })

  it('refuses to compare an exotic object rather than seeing it as an empty one', () => {
    // JSON.stringify(new Map()) is "{}", so a stringify- or key-walk-based
    // comparison would call every Map equal to every other Map and to {}.
    expect(snapshotsAgree({ v: new Map([['a', 1]]) }, { v: {} })).toBe(false)
    expect(snapshotsAgree({ v: new Map([['a', 1]]) }, { v: new Map([['a', 1]]) })).toBe(false)
    expect(snapshotsAgree({ v: new Set([1]) }, { v: {} })).toBe(false)
    expect(snapshotsAgree({ v: new Date('nonsense') }, { v: {} })).toBe(false)
  })

  it('only ever reads OWN keys — an inherited or polluted member is not content', () => {
    const polluted = Object.create({ total: '18500.00' }) as Record<string, unknown>
    polluted.buyer = 'Acme'
    expect(snapshotsAgree({ buyer: 'Acme' }, polluted)).toBe(true)
    // A real own key named like a prototype member is still content.
    expect(snapshotsAgree({ buyer: 'Acme' }, { buyer: 'Acme', constructor: 1 })).toBe(false)
    expect(snapshotsAgree({}, Object.create(null) as object)).toBe(true)
  })

  it('fails closed on a cycle instead of blowing the stack', () => {
    const a: Record<string, unknown> = { total: '12000.00' }
    a.self = a
    const b: Record<string, unknown> = { total: '12000.00' }
    b.self = b
    expect(() => snapshotsAgree(a, b)).not.toThrow()
    expect(snapshotsAgree(a, b)).toBe(false)
  })

  it('handles a non-object root without crashing (the signature takes unknown)', () => {
    expect(snapshotsAgree(null, null)).toBe(true)
    expect(snapshotsAgree(null, {})).toBe(false)
    expect(snapshotsAgree(5, 5)).toBe(true)
    expect(snapshotsAgree(5, 6)).toBe(false)
  })
})

describe('describeSnapshotDrift — names WHAT changed', () => {
  it('is empty when the snapshots agree, including on reordered keys', () => {
    expect(describeSnapshotDrift({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([])
    expect(describeSnapshotDrift({ total: 12000 }, { total: '12000.00' })).toEqual([])
  })

  it('names the field and BOTH values, not merely that something changed', () => {
    const drift = describeSnapshotDrift({ total: '12000.00' }, { total: '18500.00' })
    expect(drift).toHaveLength(1)
    expect(drift[0]).toContain('total')
    expect(drift[0]).toContain('12000.00')
    expect(drift[0]).toContain('18500.00')
  })

  it('names an ADDED key and its new value', () => {
    const drift = describeSnapshotDrift({ total: 1 }, { total: 1, discount: 500 })
    expect(drift).toHaveLength(1)
    expect(drift[0]).toContain('discount')
    expect(drift[0]).toMatch(/added/i)
    expect(drift[0]).toContain('500')
  })

  it('names a REMOVED key and the value it used to hold', () => {
    const drift = describeSnapshotDrift({ total: 1, discount: 500 }, { total: 1 })
    expect(drift).toHaveLength(1)
    expect(drift[0]).toContain('discount')
    expect(drift[0]).toMatch(/removed/i)
    expect(drift[0]).toContain('500')
  })

  it('distinguishes "set to null" from "removed"', () => {
    const removed = describeSnapshotDrift({ note: 'x' }, {})
    const nulled = describeSnapshotDrift({ note: 'x' }, { note: null })
    expect(removed[0]).toMatch(/removed/i)
    expect(nulled[0]).not.toMatch(/removed/i)
    expect(nulled[0]).toContain('null')
  })

  it('gives a dotted path for a nested field', () => {
    const drift = describeSnapshotDrift(
      { buyer: { name: 'Acme', country: 'SG' } },
      { buyer: { name: 'Acme', country: 'MY' } },
    )
    expect(drift).toEqual([expect.stringContaining('buyer.country')])
    expect(drift[0]).toContain('SG')
    expect(drift[0]).toContain('MY')
  })

  it('gives an indexed path for an array element', () => {
    const drift = describeSnapshotDrift(
      { lines: [{ qty: 2 }, { qty: 1 }] },
      { lines: [{ qty: 2 }, { qty: 7 }] },
    )
    expect(drift).toEqual([expect.stringContaining('lines[1].qty')])
  })

  it('names added and removed array elements by index', () => {
    expect(describeSnapshotDrift({ lines: [1] }, { lines: [1, 2] }))
      .toEqual([expect.stringMatching(/lines\[1\].*added/i)])
    expect(describeSnapshotDrift({ lines: [1, 2] }, { lines: [1] }))
      .toEqual([expect.stringMatching(/lines\[1\].*removed/i)])
  })

  it('quotes a key that is not a plain identifier instead of producing an unreadable path', () => {
    const drift = describeSnapshotDrift({ 'unit price': 1 }, { 'unit price': 2 })
    expect(drift[0]).toContain('unit price')
  })

  it('reports every change, not just the first', () => {
    const drift = describeSnapshotDrift(
      { total: 1, buyer: 'Acme', note: 'x' },
      { total: 2, buyer: 'Globex' },
    )
    expect(drift).toHaveLength(3)
    expect(drift.join(' | ')).toContain('total')
    expect(drift.join(' | ')).toContain('buyer')
    expect(drift.join(' | ')).toContain('note')
  })

  it('renders strings quoted, so a whitespace-only edit is visible rather than invisible', () => {
    const drift = describeSnapshotDrift({ note: '' }, { note: '   ' })
    expect(drift).toHaveLength(1)
    expect(drift[0]).toContain('""')
    expect(drift[0]).toContain('"   "')
  })

  it('is deterministic: the same pair produces the same lines whatever order the keys arrive in', () => {
    const a = { z: 1, a: 2, m: 3 }
    const b = { m: 4, z: 5, a: 6 }
    const reordered = { a: 6, m: 4, z: 5 }
    expect(describeSnapshotDrift(a, b)).toEqual(describeSnapshotDrift(a, reordered))
    expect(describeSnapshotDrift(a, b)).toEqual([...describeSnapshotDrift(a, b)].sort())
  })

  it('caps how much of a huge value it prints, and never splits a surrogate pair doing it', () => {
    const drift = describeSnapshotDrift({ blob: 'x'.repeat(5000) }, { blob: '🎉'.repeat(5000) })
    expect(drift).toHaveLength(1)
    expect(drift[0].length).toBeLessThan(DRIFT_VALUE_MAX * 2 + 100)
    expect(drift[0]).toContain('…')
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(drift[0]))
      .toBe(false)
  })

  it('describes a whole-snapshot change when the root is not an object', () => {
    const drift = describeSnapshotDrift(5, 6)
    expect(drift).toHaveLength(1)
    expect(drift[0]).toContain('5')
    expect(drift[0]).toContain('6')
  })

  it('does not throw on a cycle, and still reports the drift it fails closed on', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    const b: Record<string, unknown> = {}
    b.self = b
    expect(() => describeSnapshotDrift(a, b)).not.toThrow()
    expect(describeSnapshotDrift(a, b).length).toBeGreaterThan(0)
  })

  it('reads as a refusal a human can act on', () => {
    const drift = describeSnapshotDrift(
      { invoiceNo: 'INV-1', total: 12000, buyer: 'Acme' },
      { invoiceNo: 'INV-1', total: 18500, buyer: 'Acme' },
    )
    expect(drift).toEqual(['total: 12000 → 18500'])
  })
})

describe('snapshotsAgree and describeSnapshotDrift never disagree with each other', () => {
  // The invariant that makes a refusal trustworthy: if the engine blocks an
  // action it must be able to say why, and if it can say nothing it must not block.
  const pairs: [unknown, unknown][] = [
    [{ a: 1 }, { a: 1 }],
    [{ a: 1, b: 2 }, { b: 2, a: 1 }],
    [{ a: 1 }, { a: 2 }],
    [{ a: 1 }, {}],
    [{}, { a: 1 }],
    [{ a: null }, {}],
    [{ a: undefined }, {}],
    [{ a: 12000 }, { a: '12000.00' }],
    [{ a: '0012' }, { a: '12' }],
    [{ a: [1, 2] }, { a: [2, 1] }],
    [{ a: [1, 2] }, { a: [1, 2] }],
    [{ a: [1] }, { a: [1, 2] }],
    [{ a: { b: { c: 1 } } }, { a: { b: { c: 1 } } }],
    [{ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }],
    [{ a: new Date('2026-08-02T00:00:00.000Z') }, { a: '2026-08-02T00:00:00.000Z' }],
    [{ a: new Map() }, { a: new Map() }],
    [{ a: NaN }, { a: NaN }],
    [{ a: [] }, { a: {} }],
    [5, 5],
    [5, 6],
    [null, null],
    [null, {}],
  ]

  it.each(pairs.map((p, i) => [i, p[0], p[1]] as const))(
    'pair %i: agreement is exactly an empty drift list',
    (_i, approved, current) => {
      expect(describeSnapshotDrift(approved, current).length === 0)
        .toBe(snapshotsAgree(approved, current))
    },
  )

  it('is symmetric about agreement (drift wording is directional, agreement is not)', () => {
    for (const [approved, current] of pairs) {
      expect(snapshotsAgree(approved, current)).toBe(snapshotsAgree(current, approved))
    }
  })
})
