import { describe, it, expect } from 'vitest'
import {
  HANDOFF_TEMPLATES, buildHandoffTask, UnknownTemplateError,
  type HandoffContext,
} from '@/modules/shared/outbox/domain/handoffTemplates'

const TITLE_MAX = 200
const DESCRIPTION_MAX = 5000

const ctx = (over: Partial<HandoffContext> = {}): HandoffContext => ({
  deviceSn: 'QTX-P-00412',
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

  it('reads coherently when there is no reason — no dangling "Reason:" label', () => {
    const task = HANDOFF_TEMPLATES.logistics_prepare_delivery(ctx({ reason: null }))
    expect(task.description).not.toMatch(/Reason:\s*(null|undefined)?\s*\./)
    expect(task.description.toLowerCase()).not.toContain('reason: null')
    expect(task.description.toLowerCase()).not.toContain('reason: undefined')
    // Still a well-formed sentence, not truncated mid-clause.
    expect(task.description.trim().endsWith('.')).toBe(true)
  })

  it('falls back to a usable identity when device_sn is null — never renders "null"', () => {
    const task = HANDOFF_TEMPLATES.logistics_prepare_delivery(ctx({ deviceSn: null }))
    expect(task.title.toLowerCase()).not.toContain('null')
    expect(task.title.toLowerCase()).not.toContain('undefined')
    expect(task.title.length).toBeGreaterThan(0)
    expect(task.description.toLowerCase()).not.toContain('null')
    expect(task.description.toLowerCase()).not.toContain('undefined')
  })

  it('falls back the same way when device_sn is an empty/blank string', () => {
    const task = HANDOFF_TEMPLATES.logistics_prepare_delivery(ctx({ deviceSn: '   ' }))
    expect(task.title.toLowerCase()).not.toContain('null')
    expect(task.title.trim().length).toBeGreaterThan(0)
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
})
