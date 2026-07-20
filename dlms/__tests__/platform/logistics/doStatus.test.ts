// __tests__/platform/logistics/doStatus.test.ts
import { describe, it, expect } from 'vitest'
import {
  DO_STATUSES, evaluateDoStatusChange, listAllowedDoTransitions,
  InvalidDoStatusChangeError, messageForDoStatusChangeError,
} from '@/modules/logistics/domain/doStatus'

describe('evaluateDoStatusChange', () => {
  it('allows the full happy path: draft -> prepared -> dispatched -> delivered', () => {
    expect(evaluateDoStatusChange('draft', 'prepared')).toEqual({ ok: true })
    expect(evaluateDoStatusChange('prepared', 'dispatched')).toEqual({ ok: true })
    expect(evaluateDoStatusChange('dispatched', 'delivered')).toEqual({ ok: true })
  })

  it('allows cancellation from draft', () => {
    expect(evaluateDoStatusChange('draft', 'cancelled')).toEqual({ ok: true })
  })

  it('allows cancellation from prepared', () => {
    expect(evaluateDoStatusChange('prepared', 'cancelled')).toEqual({ ok: true })
  })

  it('rejects cancellation from dispatched (fail-closed: no such edge)', () => {
    expect(evaluateDoStatusChange('dispatched', 'cancelled')).toEqual({ ok: false, error: 'transition_forbidden' })
  })

  it('rejects skipping a state: draft -> dispatched', () => {
    expect(evaluateDoStatusChange('draft', 'dispatched')).toEqual({ ok: false, error: 'transition_forbidden' })
  })

  it('rejects skipping straight to delivered', () => {
    expect(evaluateDoStatusChange('draft', 'delivered')).toEqual({ ok: false, error: 'transition_forbidden' })
  })

  it('rejects any move out of delivered (terminal)', () => {
    for (const to of DO_STATUSES) {
      if (to === 'delivered') continue
      expect(evaluateDoStatusChange('delivered', to)).toEqual({ ok: false, error: 'transition_forbidden' })
    }
  })

  it('rejects any move out of cancelled (terminal)', () => {
    for (const to of DO_STATUSES) {
      if (to === 'cancelled') continue
      expect(evaluateDoStatusChange('cancelled', to)).toEqual({ ok: false, error: 'transition_forbidden' })
    }
  })

  it('rejects a no-op self-transition', () => {
    expect(evaluateDoStatusChange('draft', 'draft')).toEqual({ ok: false, error: 'transition_forbidden' })
  })

  it('fails closed on an unrecognized from-status rather than throwing', () => {
    expect(evaluateDoStatusChange('bogus' as never, 'draft')).toEqual({ ok: false, error: 'transition_forbidden' })
  })
})

describe('listAllowedDoTransitions', () => {
  it('lists both edges out of draft', () => {
    expect(listAllowedDoTransitions('draft').sort()).toEqual(['cancelled', 'prepared'])
  })

  it('lists both edges out of prepared', () => {
    expect(listAllowedDoTransitions('prepared').sort()).toEqual(['cancelled', 'dispatched'])
  })

  it('lists the single edge out of dispatched', () => {
    expect(listAllowedDoTransitions('dispatched')).toEqual(['delivered'])
  })

  it('is empty for delivered and cancelled', () => {
    expect(listAllowedDoTransitions('delivered')).toEqual([])
    expect(listAllowedDoTransitions('cancelled')).toEqual([])
  })

  it('returns a fresh array each call (caller mutation-safe)', () => {
    const a = listAllowedDoTransitions('draft')
    a.push('dispatched' as never)
    expect(listAllowedDoTransitions('draft')).toEqual(['prepared', 'cancelled'])
  })
})

describe('messageForDoStatusChangeError', () => {
  it('names both statuses', () => {
    expect(messageForDoStatusChangeError('dispatched', 'cancelled'))
      .toBe('Cannot move a delivery order from "dispatched" to "cancelled".')
  })
})

describe('InvalidDoStatusChangeError', () => {
  it('carries the code and a readable name', () => {
    const e = new InvalidDoStatusChangeError('transition_forbidden', 'nope')
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('transition_forbidden')
    expect(e.name).toBe('InvalidDoStatusChangeError')
  })
})
