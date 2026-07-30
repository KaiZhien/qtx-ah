import { describe, it, expect } from 'vitest'
import {
  HANDOFF_TEMPLATES, buildHandoffTask, UnknownTemplateError,
  type HandoffContext,
} from '@/modules/shared/outbox/domain/handoffTemplates'

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
