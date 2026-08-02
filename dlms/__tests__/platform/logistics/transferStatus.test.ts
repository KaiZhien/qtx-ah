// __tests__/platform/logistics/transferStatus.test.ts
import { describe, it, expect } from 'vitest'
import {
  STOCK_TRANSFER_STATUSES, evaluateTransferStatusChange, listAllowedTransferTransitions,
  isTransferPosted, InvalidTransferStatusChangeError, messageForTransferStatusChangeError,
} from '@/modules/logistics/domain/transferStatus'

describe('evaluateTransferStatusChange', () => {
  it('allows the happy path: draft -> dispatched -> received', () => {
    expect(evaluateTransferStatusChange('draft', 'dispatched')).toEqual({ ok: true })
    expect(evaluateTransferStatusChange('dispatched', 'received')).toEqual({ ok: true })
  })

  it('allows cancellation from draft and from dispatched', () => {
    // Cancelling a dispatched transfer is safe precisely BECAUSE dispatch posts
    // nothing — all stock movement happens at receive. If posting ever moves to
    // dispatch time, this edge has to grow a compensating reversal.
    expect(evaluateTransferStatusChange('draft', 'cancelled')).toEqual({ ok: true })
    expect(evaluateTransferStatusChange('dispatched', 'cancelled')).toEqual({ ok: true })
  })

  it('rejects skipping dispatch: draft -> received', () => {
    expect(evaluateTransferStatusChange('draft', 'received'))
      .toEqual({ ok: false, error: 'transition_forbidden' })
  })

  it('rejects re-receiving an already-received transfer (the idempotency guard)', () => {
    // This is what makes receiveStockTransfer idempotent: the second receive
    // finds status='received', has no outgoing edge, and fails closed BEFORE
    // any stock is posted a second time.
    expect(evaluateTransferStatusChange('received', 'received'))
      .toEqual({ ok: false, error: 'transition_forbidden' })
  })

  it('treats received and cancelled as sinks', () => {
    for (const to of STOCK_TRANSFER_STATUSES) {
      expect(evaluateTransferStatusChange('received', to)).toEqual({ ok: false, error: 'transition_forbidden' })
      expect(evaluateTransferStatusChange('cancelled', to)).toEqual({ ok: false, error: 'transition_forbidden' })
    }
  })

  it('rejects a self-transition on every status', () => {
    for (const s of STOCK_TRANSFER_STATUSES) {
      expect(evaluateTransferStatusChange(s, s)).toEqual({ ok: false, error: 'transition_forbidden' })
    }
  })

  it('fails closed on an unrecognized `from` status', () => {
    expect(evaluateTransferStatusChange('bogus' as never, 'dispatched'))
      .toEqual({ ok: false, error: 'transition_forbidden' })
  })

  it('fails closed on an unrecognized `to` status', () => {
    expect(evaluateTransferStatusChange('draft', 'bogus' as never))
      .toEqual({ ok: false, error: 'transition_forbidden' })
  })
})

describe('listAllowedTransferTransitions', () => {
  it('lists the outgoing edges for each status', () => {
    expect(listAllowedTransferTransitions('draft')).toEqual(['dispatched', 'cancelled'])
    expect(listAllowedTransferTransitions('dispatched')).toEqual(['received', 'cancelled'])
    expect(listAllowedTransferTransitions('received')).toEqual([])
    expect(listAllowedTransferTransitions('cancelled')).toEqual([])
  })

  it('returns [] for an unrecognized status rather than throwing', () => {
    expect(listAllowedTransferTransitions('bogus' as never)).toEqual([])
  })

  it('returns a fresh array a caller cannot use to mutate the graph', () => {
    const first = listAllowedTransferTransitions('draft')
    first.push('received')
    expect(listAllowedTransferTransitions('draft')).toEqual(['dispatched', 'cancelled'])
  })
})

describe('isTransferPosted', () => {
  it('is true only for received — the one status that has moved stock', () => {
    expect(isTransferPosted('received')).toBe(true)
    expect(isTransferPosted('draft')).toBe(false)
    expect(isTransferPosted('dispatched')).toBe(false)
    expect(isTransferPosted('cancelled')).toBe(false)
  })
})

describe('InvalidTransferStatusChangeError', () => {
  it('carries the code and reads as a named error', () => {
    const err = new InvalidTransferStatusChangeError(
      'transition_forbidden', messageForTransferStatusChangeError('received', 'received'))
    expect(err.name).toBe('InvalidTransferStatusChangeError')
    expect(err.code).toBe('transition_forbidden')
    expect(err).toBeInstanceOf(Error)
  })

  it('builds a message naming both ends of the rejected edge', () => {
    expect(messageForTransferStatusChangeError('received', 'received'))
      .toBe('Cannot move a stock transfer from "received" to "received".')
  })
})
