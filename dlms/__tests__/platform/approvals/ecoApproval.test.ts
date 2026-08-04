import { describe, it, expect } from 'vitest'
import {
  ECO_APPROVAL_ENTITY_TYPE, ECO_APPROVAL_KIND, ECO_APPROVAL_SUBJECT,
  buildEcoApprovalSnapshot, ecoApprovalRequestable, ecoScopeLockedByApproval,
  type EcoAffectedItemSnapshot,
} from '@/modules/shared/approvals/domain/ecoApproval'
import { evaluateApprovalGate } from '@/modules/shared/approvals/domain/approvalGate'

const VARIANT_A = 'aaaaaaaa-0000-0000-0000-000000000001'
const VARIANT_B = 'bbbbbbbb-0000-0000-0000-000000000002'
const TYPE_PCBA = 'cccccccc-0000-0000-0000-000000000003'
const TYPE_SCREEN = 'dddddddd-0000-0000-0000-000000000004'

const item = (over: Partial<EcoAffectedItemSnapshot> = {}): EcoAffectedItemSnapshot => ({
  variantId: VARIANT_A,
  componentTypeId: TYPE_PCBA,
  disposition: 'change',
  quantity: 1,
  notes: null,
  ...over,
})

const facts = (over: Record<string, unknown> = {}) => ({
  ecoNo: 'ECO-2026-0007',
  title: 'Replace the 3V3 regulator',
  description: 'Thermal margin too small on rev C.',
  ecrId: '11111111-1111-1111-1111-111111111111',
  ecrNo: 'ECR-2026-0003',
  effectivityDate: '2026-09-01',
  effectivitySerial: 'EE-02A-2603-0001 to 0015',
  effectivityNotes: 'Retrofit at next service.',
  affectedItems: [item()],
  ...over,
}) as Parameters<typeof buildEcoApprovalSnapshot>[0]

describe('the ECO approval target', () => {
  it('names the entity type and kind the shared engine registered for ECOs', () => {
    // APPROVAL_TARGETS in approvalService maps kind 'eco' → table/entityType 'eco';
    // a drift between these constants and that registry is a request the service
    // refuses with ApprovalTargetError, so they are pinned.
    expect(ECO_APPROVAL_ENTITY_TYPE).toBe('eco')
    expect(ECO_APPROVAL_KIND).toBe('eco')
    expect(ECO_APPROVAL_SUBJECT).toBe('this ECO')
  })
})

describe('buildEcoApprovalSnapshot — what an approver is agreeing to', () => {
  it('captures the change itself, not merely its id', () => {
    // "a snapshot of only the id authorises nothing" — the migration header.
    const snap = buildEcoApprovalSnapshot(facts())
    expect(snap).toEqual({
      ecoNo: 'ECO-2026-0007',
      title: 'Replace the 3V3 regulator',
      description: 'Thermal margin too small on rev C.',
      ecrId: '11111111-1111-1111-1111-111111111111',
      ecrNo: 'ECR-2026-0003',
      effectivityDate: '2026-09-01',
      effectivitySerial: 'EE-02A-2603-0001 to 0015',
      effectivityNotes: 'Retrofit at next service.',
      affectedItems: [{
        variantId: VARIANT_A, componentTypeId: TYPE_PCBA,
        disposition: 'change', quantity: 1, notes: null,
      }],
    })
  })

  it('carries exactly the ECO’s editable content — no optimistic-lock counter', () => {
    // `version` is excluded on purpose: it would readmit every field the type
    // deliberately leaves out and would make an edit that is PUT BACK stay
    // drifted forever, which Finance's gate does not do.
    expect(Object.keys(buildEcoApprovalSnapshot(facts())).sort()).toEqual([
      'affectedItems', 'description', 'ecoNo', 'ecrId', 'ecrNo',
      'effectivityDate', 'effectivityNotes', 'effectivitySerial', 'title',
    ])
  })

  it('projects each affected item by IDENTITY, never by display name', () => {
    // The whole trap: `listAffectedItems` orders by `v.name, ct.sort, ct.name` and
    // returns those names. Renaming a variant would then re-order the array AND
    // change its content, reporting drift on an ECO nobody touched — which trains
    // people to ignore the one warning that matters. The snapshot carries ids.
    const [only] = buildEcoApprovalSnapshot(facts()).affectedItems
    expect(Object.keys(only).sort()).toEqual([
      'componentTypeId', 'disposition', 'notes', 'quantity', 'variantId',
    ])
  })

  it('copies the affected-items array rather than aliasing the caller’s', () => {
    // The builder is used to STORE the snapshot; a shared reference would let a
    // later mutation of the source list rewrite what was already agreed to.
    const source = [item()]
    const snap = buildEcoApprovalSnapshot(facts({ affectedItems: source }))
    source.push(item({ variantId: VARIANT_B }))
    expect(snap.affectedItems).toHaveLength(1)
  })

  it('is a non-empty plain object the engine will accept as a snapshot', () => {
    // approvalService refuses `{}` — it would compare equal to everything and make
    // the re-check pass vacuously.
    const snap = buildEcoApprovalSnapshot(facts()) as Record<string, unknown>
    expect(Object.keys(snap).length).toBeGreaterThan(0)
    expect(JSON.stringify(snap)).not.toBe('{}')
  })

  it('keeps nulls as nulls rather than dropping the keys', () => {
    // `null` is not a missing key: a field CLEARED after approval must read as a
    // changed value, not as an absent one, so the drift line can say which.
    const snap = buildEcoApprovalSnapshot(facts({
      description: null, ecrId: null, ecrNo: null,
      effectivityDate: null, effectivitySerial: null, effectivityNotes: null,
    })) as Record<string, unknown>
    for (const key of ['description', 'ecrId', 'effectivityDate', 'effectivitySerial']) {
      expect(Object.prototype.hasOwnProperty.call(snap, key)).toBe(true)
      expect(snap[key]).toBeNull()
    }
  })
})

describe('the ECO snapshot catches the edits that matter', () => {
  const gate = (current: Record<string, unknown>, approvedSnap: Record<string, unknown>) =>
    evaluateApprovalGate({
      subject: ECO_APPROVAL_SUBJECT, action: 'approved', requiredWithoutRequest: false,
      current, approval: { status: 'approved', snapshot: approvedSnap, decisionNote: null },
    })

  it('permits approving an ECO nobody touched', () => {
    expect(gate(buildEcoApprovalSnapshot(facts()), buildEcoApprovalSnapshot(facts())))
      .toEqual({ ok: true })
  })

  it('refuses when the EFFECTIVITY SERIAL RANGE widened', () => {
    // effectivity_serial is WHICH DEVICES the change applies to — the serial-range
    // axis of the scope. It is NOT the affected-items list (that is `affectedItems`,
    // covered in its own block below): widening the range changes which units get
    // the change, while an added affected item changes WHAT the change is.
    const result = gate(
      buildEcoApprovalSnapshot(facts({ effectivitySerial: 'EE-02A-2603-0001 to 0090' })),
      buildEcoApprovalSnapshot(facts()))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('approval_drifted')
    expect(result.message).toContain('effectivitySerial')
    expect(result.message).toContain('0090')
  })

  it('refuses when the change itself was rewritten', () => {
    const result = gate(
      buildEcoApprovalSnapshot(facts({ title: 'Replace the 5V regulator' })),
      buildEcoApprovalSnapshot(facts()))
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('title')
  })

  it('refuses when the ECO is re-pointed at a different ECR', () => {
    // The originating request is part of what was approved: an order realising
    // ECR-3 is not the same order once it realises ECR-9.
    const result = gate(
      buildEcoApprovalSnapshot(facts({
        ecrId: '22222222-2222-2222-2222-222222222222', ecrNo: 'ECR-2026-0009',
      })),
      buildEcoApprovalSnapshot(facts()))
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('ecrId')
  })

  it('agrees again once an edit is PUT BACK — the check is on state, not on edits', () => {
    // The behaviour excluding `version` buys, and the reason Finance's gate has
    // it too: a mistaken keystroke and its correction must not permanently
    // invalidate an approval that describes the ECO perfectly.
    const approvedSnap = buildEcoApprovalSnapshot(facts())
    const edited = buildEcoApprovalSnapshot(facts({ effectivityNotes: 'oops' }))
    expect(gate(edited, approvedSnap).ok).toBe(false)
    expect(gate(buildEcoApprovalSnapshot(facts()), approvedSnap)).toEqual({ ok: true })
  })

  it('refuses when effectivity is CLEARED, not only when it is changed', () => {
    const result = gate(
      buildEcoApprovalSnapshot(facts({ effectivityDate: null })),
      buildEcoApprovalSnapshot(facts()))
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('effectivityDate')
  })
})

/**
 * THE AFFECTED-ITEMS CASE, which `effectivity_serial` does not cover and never did.
 *
 * `ec_affected_item` alone decides WHICH VARIANT, WHICH COMPONENT TYPE, add/change/
 * remove and WHAT QUANTITY — the four facts `applyEcoEffectivityTx` loops over to
 * rewrite the BOM. `variant_id` is NOT NULL per item, so a newly added item can name
 * a variant the approved serial range never contained. An approval that did not
 * carry these rows authorised a line item, not a change.
 */
describe('the ECO snapshot covers the affected items', () => {
  const gate = (current: Record<string, unknown>, approvedSnap: Record<string, unknown>) =>
    evaluateApprovalGate({
      subject: ECO_APPROVAL_SUBJECT, action: 'applied to the BOM',
      requiredWithoutRequest: false,
      current, approval: { status: 'approved', snapshot: approvedSnap, decisionNote: null },
    })

  /**
   * THE REVIEWER'S SCENARIO, at the level where it is decided: an approval granted
   * for a ONE-line change must not authorise a FIVE-line change across three
   * variants. Before this slice the snapshot held no items at all, so this gate
   * returned `{ ok: true }` and the widened ECO applied.
   */
  it('refuses when four items were ADDED across other variants after approval', () => {
    const approvedAtOneItem = buildEcoApprovalSnapshot(facts())
    const nowFiveItems = buildEcoApprovalSnapshot(facts({
      affectedItems: [
        item(),
        item({ componentTypeId: TYPE_SCREEN }),
        item({ variantId: VARIANT_B }),
        item({ variantId: VARIANT_B, componentTypeId: TYPE_SCREEN, disposition: 'add' }),
        item({ variantId: VARIANT_B, componentTypeId: TYPE_PCBA, disposition: 'remove',
               quantity: null }),
      ],
    }))

    const result = gate(nowFiveItems, approvedAtOneItem)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('approval_drifted')
    expect(result.message).toContain('affectedItems')
    // Named, so the approver can see WHAT arrived rather than only that something did.
    expect(result.message).toContain(VARIANT_B)
  })

  it('refuses when the only affected item was REMOVED after approval', () => {
    const result = gate(
      buildEcoApprovalSnapshot(facts({ affectedItems: [] })),
      buildEcoApprovalSnapshot(facts()))
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('affectedItems')
  })

  it('refuses when an item is re-pointed at a DIFFERENT VARIANT', () => {
    // effectivity_serial cannot see this at all: the range is unchanged, and the
    // BOM being rewritten is a different variant's.
    const result = gate(
      buildEcoApprovalSnapshot(facts({ affectedItems: [item({ variantId: VARIANT_B })] })),
      buildEcoApprovalSnapshot(facts()))
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('variantId')
  })

  it('refuses when the DISPOSITION flips from change to remove', () => {
    const result = gate(
      buildEcoApprovalSnapshot(facts({
        affectedItems: [item({ disposition: 'remove', quantity: null })] })),
      buildEcoApprovalSnapshot(facts()))
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('disposition')
  })

  it('refuses when a QUANTITY moved, which no other field records', () => {
    const result = gate(
      buildEcoApprovalSnapshot(facts({ affectedItems: [item({ quantity: 4 })] })),
      buildEcoApprovalSnapshot(facts()))
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('quantity')
  })

  it('refuses when an item’s NOTES changed — they are copied onto the new BOM line', () => {
    const result = gate(
      buildEcoApprovalSnapshot(facts({ affectedItems: [item({ notes: 'use rev D' })] })),
      buildEcoApprovalSnapshot(facts()))
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('notes')
  })

  it('permits an unchanged list — the projection must not report drift on its own', () => {
    expect(gate(buildEcoApprovalSnapshot(facts()), buildEcoApprovalSnapshot(facts())))
      .toEqual({ ok: true })
  })

  it('permits an ECO that affects nothing, on both sides', () => {
    // An ECO with no affected items alters no BOM. Empty must agree with empty
    // rather than reading as "the whole snapshot changed".
    expect(gate(
      buildEcoApprovalSnapshot(facts({ affectedItems: [] })),
      buildEcoApprovalSnapshot(facts({ affectedItems: [] })))).toEqual({ ok: true })
  })

  it('treats ARRAY ORDER as significant, which is why the projection is ordered by id', () => {
    // snapshotsAgree compares arrays positionally (jsonb preserves array order), so
    // an unordered projection would report drift every time Postgres returned the
    // rows differently. The order must come from an IMMUTABLE key.
    const two = [item(), item({ variantId: VARIANT_B })]
    const reversed = [...two].reverse()
    expect(gate(
      buildEcoApprovalSnapshot(facts({ affectedItems: reversed })),
      buildEcoApprovalSnapshot(facts({ affectedItems: two }))).ok).toBe(false)
  })
})

/**
 * The other half of the fix: once the gated edge has been crossed, the scope is
 * FROZEN. Without this the drift check only ever fires at the moment nobody is
 * editing, and the edits happen afterwards.
 */
describe('ecoScopeLockedByApproval', () => {
  it('does not lock an ECO nobody raised a request for, in any status', () => {
    // "Requested ⇒ binding" — no request, no new refusal, exactly as before.
    for (const status of ['draft', 'submitted', 'approved', 'implemented', 'rejected']) {
      expect(ecoScopeLockedByApproval(status, false)).toEqual({ locked: false })
    }
  })

  it('does not lock while the ECO is still SUBMITTED, even with an approval', () => {
    // The gated edge has not been crossed yet, so every later edit is still
    // re-checked at submitted → approved. Locking here would also break the
    // put-it-back behaviour the gate deliberately has.
    expect(ecoScopeLockedByApproval('submitted', true)).toEqual({ locked: false })
  })

  it('locks once the ECO has LEFT submitted with a request on it', () => {
    for (const status of ['approved', 'implemented', 'rejected']) {
      const decision = ecoScopeLockedByApproval(status, true)
      expect(decision.locked).toBe(true)
      if (!decision.locked) throw new Error('unreachable')
      expect(decision.message).toMatch(/approv/i)
    }
  })
})

describe('ecoApprovalRequestable', () => {
  it('permits a request only while the ECO is submitted', () => {
    // The gated edge is submitted → approved. Requesting approval for a draft
    // asks someone to agree to something still being written; requesting one for
    // an already-approved ECO asks for a decision that changes nothing.
    expect(ecoApprovalRequestable('submitted')).toEqual({ ok: true })
    for (const status of ['draft', 'approved', 'implemented', 'rejected']) {
      const result = ecoApprovalRequestable(status)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.message).toContain('submitted')
    }
  })
})
