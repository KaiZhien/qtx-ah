import { describe, it, expect } from 'vitest'
import {
  HANDOFF_TEMPLATES, buildHandoffTask, UnknownTemplateError,
  APPROVAL_TEMPLATES, buildApprovalTask, MODULE_DEPARTMENTS,
  type HandoffContext, type ApprovalContext,
} from '@/modules/shared/outbox/domain/handoffTemplates'
import { MODULES } from '@/modules/shared/authz/catalog'

const TITLE_MAX = 200
const DESCRIPTION_MAX = 5000

const ctx = (over: Partial<HandoffContext> = {}): HandoffContext => ({
  deviceId: '11111111-1111-4111-8111-111111111111',
  deviceSn: 'QTX-P-00412',
  pcbaASnLegacy: null,
  fromStatus: 'ready_for_delivery',
  toStatus: 'shipped',
  reason: null,
  changedByName: 'Alice Tan',
  ...over,
})

describe('logistics_prepare_delivery', () => {
  it('produces a task shaped for logistics, naming the device and the mover', () => {
    const task = HANDOFF_TEMPLATES.logistics_prepare_delivery(ctx())

    expect(task.module).toBe('logistics')
    expect(task.priority).toMatch(/^(low|normal|high|urgent)$/)
    expect(task.department.length).toBeGreaterThan(0)
    expect(task.title).toContain('QTX-P-00412')
    expect(task.description).toContain('QTX-P-00412')
    expect(task.description).toContain('Alice Tan')
    expect(task.description.toLowerCase()).toContain('ready for delivery')
    expect(task.description.toLowerCase()).toContain('shipped')
  })

  it('includes the reason when one was given', () => {
    const task = HANDOFF_TEMPLATES.logistics_prepare_delivery(
      ctx({ reason: 'Buyer requested expedited shipping' }),
    )
    expect(task.description).toContain('Buyer requested expedited shipping')
  })

  it('reads coherently when there is no reason — no dangling "Reason given:" label', () => {
    const task = HANDOFF_TEMPLATES.logistics_prepare_delivery(ctx({ reason: null }))
    expect(task.description).not.toMatch(/Reason given:\s*(null|undefined)?\s*\./)
    expect(task.description.toLowerCase()).not.toContain('reason given: null')
    expect(task.description.toLowerCase()).not.toContain('reason given: undefined')
    // Still a well-formed sentence, not truncated mid-clause.
    expect(task.description.trim().endsWith('.')).toBe(true)
  })

  describe('device identity fallback (deviceSn -> pcbaASnLegacy -> deviceId)', () => {
    it('tier 1: uses deviceSn when present, even if pcbaASnLegacy is also present', () => {
      const task = HANDOFF_TEMPLATES.logistics_prepare_delivery(
        ctx({ deviceSn: 'QTX-P-00412', pcbaASnLegacy: 'EE-02A-2603-0001' }),
      )
      expect(task.title).toContain('QTX-P-00412')
      expect(task.title).not.toContain('EE-02A-2603-0001')
    })

    it('tier 2: falls back to pcbaASnLegacy, rendered verbatim, when deviceSn is null', () => {
      const task = HANDOFF_TEMPLATES.logistics_prepare_delivery(
        ctx({ deviceSn: null, pcbaASnLegacy: 'EE-02A-2603-0001 to 0015' }),
      )
      expect(task.title).toContain('EE-02A-2603-0001 to 0015')
      expect(task.description).toContain('EE-02A-2603-0001 to 0015')
    })

    it('tier 2 also applies when deviceSn is blank/whitespace rather than null', () => {
      const task = HANDOFF_TEMPLATES.logistics_prepare_delivery(
        ctx({ deviceSn: '   ', pcbaASnLegacy: 'EE-02A-2603-0001' }),
      )
      expect(task.title).toContain('EE-02A-2603-0001')
    })

    it('tier 3: falls back to a short prefix of deviceId when neither serial is present — never renders "null"', () => {
      const task = HANDOFF_TEMPLATES.logistics_prepare_delivery(
        ctx({ deviceId: '11111111-1111-4111-8111-111111111111', deviceSn: null, pcbaASnLegacy: null }),
      )
      expect(task.title.toLowerCase()).not.toContain('null')
      expect(task.title.toLowerCase()).not.toContain('undefined')
      expect(task.title.length).toBeGreaterThan(0)
      expect(task.title).toContain('11111111')
      expect(task.description.toLowerCase()).not.toContain('null')
      expect(task.description.toLowerCase()).not.toContain('undefined')
    })

    it('tier 3 also applies when both deviceSn and pcbaASnLegacy are blank/whitespace strings', () => {
      const task = HANDOFF_TEMPLATES.logistics_prepare_delivery(
        ctx({ deviceSn: '   ', pcbaASnLegacy: '  ' }),
      )
      expect(task.title.toLowerCase()).not.toContain('null')
      expect(task.title.trim().length).toBeGreaterThan(0)
    })

    it('two devices with no serial of any kind still produce different titles — the property this fix exists for', () => {
      // Every other field matches, only deviceId differs. Before this fix, both
      // would render the identical fixed literal ('device with no serial on
      // file'), making a logistics queue of such tasks indistinguishable at a
      // glance even though each task links to a different device.
      const shared = {
        deviceSn: null, pcbaASnLegacy: null, fromStatus: 'ready_for_delivery',
        toStatus: 'shipped', reason: null, changedByName: 'Alice Tan',
      } as const
      const taskA = HANDOFF_TEMPLATES.logistics_prepare_delivery(
        ctx({ ...shared, deviceId: 'aaaaaaaa-1111-4111-8111-111111111111' }),
      )
      const taskB = HANDOFF_TEMPLATES.logistics_prepare_delivery(
        ctx({ ...shared, deviceId: 'bbbbbbbb-2222-4222-8222-222222222222' }),
      )
      expect(taskA.title).not.toBe(taskB.title)
      expect(taskA.description).not.toBe(taskB.description)
    })
  })

  it('never exceeds the title length createTask enforces (1-200), even with a long serial', () => {
    const longSn = 'SN-' + '9'.repeat(400)
    const task = HANDOFF_TEMPLATES.logistics_prepare_delivery(ctx({ deviceSn: longSn }))
    expect(task.title.length).toBeLessThanOrEqual(TITLE_MAX)
    expect(task.title.length).toBeGreaterThan(0)
  })

  it('truncates an overlong title with an ellipsis rather than throwing', () => {
    const longSn = 'SN-' + 'A'.repeat(400)
    const task = HANDOFF_TEMPLATES.logistics_prepare_delivery(ctx({ deviceSn: longSn }))
    expect(task.title.length).toBe(TITLE_MAX)
    expect(task.title.endsWith('…')).toBe(true)
  })

  it('never exceeds the description length createTask enforces (max 5000), even with a long reason', () => {
    const longReason = 'x'.repeat(6000)
    const task = HANDOFF_TEMPLATES.logistics_prepare_delivery(ctx({ reason: longReason }))
    expect(task.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX)
  })

  it('truncates an overlong description with an ellipsis rather than throwing', () => {
    const longReason = 'y'.repeat(6000)
    const task = HANDOFF_TEMPLATES.logistics_prepare_delivery(ctx({ reason: longReason }))
    expect(task.description.length).toBe(DESCRIPTION_MAX)
    expect(task.description.endsWith('…')).toBe(true)
  })

  it('does not truncate a title or description that already fits', () => {
    const task = HANDOFF_TEMPLATES.logistics_prepare_delivery(ctx())
    expect(task.title.length).toBeLessThan(TITLE_MAX)
    expect(task.title.endsWith('…')).toBe(false)
    expect(task.description.endsWith('…')).toBe(false)
  })

  describe('truncation is UTF-16 surrogate-pair safe', () => {
    // A lone surrogate is not validly encodable as UTF-8, which is what the
    // eventual Postgres `text` insert requires — so a mid-pair cut merely
    // relocates the failure this truncation exists to prevent. Try both an
    // even and an odd repeat count so the fixed-length prefix text ("Prepare
    // delivery for " / the description preamble) can't accidentally hide a
    // parity bug in just one of the two lengths.
    function hasLoneSurrogate(s: string): boolean {
      return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)
    }

    it('never splits a surrogate pair in the title when deviceSn is astral (emoji) and overlong', () => {
      for (const repeat of [150, 151]) {
        const emojiSn = '🎉'.repeat(repeat)
        const task = HANDOFF_TEMPLATES.logistics_prepare_delivery(ctx({ deviceSn: emojiSn }))
        expect(task.title.length).toBeLessThanOrEqual(TITLE_MAX)
        expect(hasLoneSurrogate(task.title)).toBe(false)
      }
    })

    it('never splits a surrogate pair in the description when reason is astral (emoji) and overlong', () => {
      for (const repeat of [3000, 3001]) {
        const emojiReason = '🎉'.repeat(repeat)
        const task = HANDOFF_TEMPLATES.logistics_prepare_delivery(ctx({ reason: emojiReason }))
        expect(task.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX)
        expect(hasLoneSurrogate(task.description)).toBe(false)
      }
    })
  })
})

describe('buildHandoffTask', () => {
  it('dispatches to the registered template for a known key', () => {
    const task = buildHandoffTask('logistics_prepare_delivery', ctx())
    expect(task.module).toBe('logistics')
    expect(task.title).toContain('QTX-P-00412')
  })

  it('throws UnknownTemplateError for a key nothing registered, rather than inventing a task', () => {
    expect(() => buildHandoffTask('some_unregistered_key', ctx()))
      .toThrow(UnknownTemplateError)
  })

  it('names the offending key in the error so a failed drain attempt is diagnosable', () => {
    try {
      buildHandoffTask('finance_reconcile_invoice', ctx())
      expect.unreachable('expected UnknownTemplateError to be thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownTemplateError)
      expect((err as Error).message).toContain('finance_reconcile_invoice')
    }
  })

  describe('is safe against Object.prototype key collisions', () => {
    // task_template_key is admin-editable free text on status_transition, so
    // any string — including the name of an inherited Object.prototype member
    // — is a plausible input. A plain-object truthiness lookup either hands
    // back an inherited method mistyped as HandoffTask or throws a raw
    // TypeError; only own, registered keys should ever resolve.
    const pollutingKeys = [
      'constructor',
      'toString',
      'hasOwnProperty',
      'valueOf',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toLocaleString',
      '__proto__',
    ]

    it.each(pollutingKeys)(
      'throws UnknownTemplateError for the inherited key %s instead of returning garbage or a raw TypeError',
      (key) => {
        expect(() => buildHandoffTask(key, ctx())).toThrow(UnknownTemplateError)
      },
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// The APPROVAL registry (spec §6.3). Same output shape, same limits, same
// own-property-guarded lookup — keyed on `approval.kind` instead of on a
// status_transition template key.
describe('APPROVAL_TEMPLATES', () => {
  const actx = (over: Partial<ApprovalContext> = {}): ApprovalContext => ({
    approvalId: '22222222-2222-4222-8222-222222222222',
    entityType: 'sales_invoice',
    entityId: '33333333-3333-4333-8333-333333333333',
    module: 'finance',
    label: 'INV-2026-0042',
    requestedByName: 'Rita Requester',
    ...over,
  })

  it('produces a Finance-queued task naming the record and the requester', () => {
    const task = buildApprovalTask('invoice', actx())
    expect(task.module).toBe('finance')
    expect(task.department).toBe('Finance')
    expect(task.priority).toBe('high')
    expect(task.title).toContain('INV-2026-0042')
    expect(task.description).toContain('INV-2026-0042')
    expect(task.description).toContain('Rita Requester')
    // The two rules an approver has to know are in the task itself, not only in the UI.
    expect(task.description.toLowerCase()).toContain('note')
    expect(task.description.toLowerCase()).toContain('own request')
  })

  /**
   * The module comes from the EVENT, not from a kind→module map restated here: the
   * approvals migration's header is explicit that the module is a property of the
   * entity, so a map in this module would go stale the day a kind spans two of them
   * while the stored column stays true.
   */
  it('takes the module (and therefore the department queue) from the context', () => {
    const task = buildApprovalTask('invoice', actx({ module: 'logistics' }))
    expect(task.module).toBe('logistics')
    expect(task.department).toBe('Logistics')
  })

  /**
   * Without a per-record identifier every serial-less approval renders the same
   * title, and a queue of identical titles is useless even though each task links to
   * a different record.
   */
  it('falls back to the entity type and a uuid prefix when no label was carried', () => {
    const task = buildApprovalTask('invoice', actx({ label: null }))
    expect(task.title).toContain('sales invoice')
    expect(task.title).toContain('33333333')
    expect(task.title).not.toContain('null')
  })

  it('ignores a blank label rather than rendering an empty identifier', () => {
    const task = buildApprovalTask('invoice', actx({ label: '   ' }))
    expect(task.title).toContain('33333333')
  })

  it('keeps the title and description within createTask’s limits', () => {
    const task = buildApprovalTask('invoice', actx({ label: 'X'.repeat(500) }))
    expect(task.title.length).toBeLessThanOrEqual(TITLE_MAX)
    expect(task.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX)
  })

  /**
   * eco and repair_signoff became registered when their flows moved onto the
   * engine: each now has a decided destination queue and a task that says what the
   * approver must check. Before that they parked deliberately — a task answering no
   * question is worse than a visible backlog — which is why the register/park line
   * is pinned in BOTH directions rather than assumed.
   */
  it.each(['eco', 'repair_signoff'])('builds a real task for the migrated kind %s', (kind) => {
    const task = buildApprovalTask(kind, actx())
    expect(task.title).toMatch(/\S/)
    expect(task.description).toMatch(/\S/)
    // An approval BLOCKS the work that asked for it, so it outranks an ordinary
    // department handoff — same reasoning as `invoice`.
    expect(task.priority).toBe('high')
    // Nobody decides their own request, and a rejection needs a note: both are
    // rules the approver has to know BEFORE they open the queue.
    expect(task.description.toLowerCase()).toContain('own request')
    expect(task.description.toLowerCase()).toContain('reject')
  })

  it('routes each migrated kind to its own module’s department queue', () => {
    expect(buildApprovalTask('eco', actx({ module: 'engineering' })).department)
      .toBe('Engineering')
    expect(buildApprovalTask('repair_signoff', actx({ module: 'maintenance' })).department)
      .toBe('Maintenance')
  })

  it('points the ECO approver at the effectivity — the scope that must not drift', () => {
    const task = buildApprovalTask('eco', actx())
    expect(task.description.toLowerCase()).toContain('effectivity')
  })

  it('points the sign-off approver at the testing notes and the parts claim', () => {
    const task = buildApprovalTask('repair_signoff', actx())
    expect(task.description.toLowerCase()).toContain('testing notes')
    expect(task.description.toLowerCase()).toContain('parts-replaced')
  })

  it.each(['eco', 'repair_signoff'])(
    'keeps the migrated kind %s within createTask’s limits', (kind) => {
      const task = buildApprovalTask(kind, actx({ label: 'X'.repeat(500) }))
      expect(task.title.length).toBeLessThanOrEqual(TITLE_MAX)
      expect(task.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX)
    })

  /**
   * The PARKING behaviour itself is unchanged and must stay that way: a kind
   * nobody registered still throws rather than inventing a generic task. Growing
   * the CHECK set without growing this registry has to remain visible as a parked
   * outbox row, not silently land "something needs approving" in someone's queue.
   */
  it('still throws for a kind nobody registered, instead of inventing a task', () => {
    expect(() => buildApprovalTask('quorum_signoff', actx())).toThrow(UnknownTemplateError)
  })

  it('names the kind in the error so a parked event is diagnosable from last_error', () => {
    try {
      buildApprovalTask('quorum_signoff', actx())
      expect.unreachable('expected UnknownTemplateError to be thrown')
    } catch (err) {
      expect((err as Error).message).toContain('quorum_signoff')
      expect((err as Error).message).toContain('approval kind')
    }
  })

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'throws for the inherited key %s rather than returning garbage', (key) => {
      expect(() => buildApprovalTask(key, actx())).toThrow(UnknownTemplateError)
    })

  it('registers a department for every module, so no kind can queue into `undefined`', () => {
    for (const m of MODULES) expect(MODULE_DEPARTMENTS[m]).toMatch(/\S/)
  })

  /**
   * Pinned as a fact rather than left implicit: registering a kind is what turns its
   * events from parked backlog into tasks in someone's queue, so growing this set is a
   * decision about whose queue fills up — not a detail to notice in a diff.
   */
  it('registers exactly the kinds that have a queue destination today', () => {
    expect(Object.keys(APPROVAL_TEMPLATES).sort())
      .toEqual(['eco', 'invoice', 'repair_signoff'])
  })
})
