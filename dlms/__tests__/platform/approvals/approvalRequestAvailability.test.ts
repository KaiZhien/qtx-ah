import { describe, it, expect } from 'vitest'
import {
  approvalRequestAvailability,
} from '@/modules/shared/approvals/domain/approvalRequestAvailability'

/**
 * The rule that decides whether a screen may OFFER "Request approval".
 *
 * It is a pure function rather than three lines inside each panel because the
 * house rule it serves — never offer a control the write will refuse — only holds
 * while the offer and the write agree, and two copies of a boolean expression in
 * two client components is exactly how they stop agreeing. InvoiceApprovalPanel
 * carried the first copy; ECO and repair would have been the second and third.
 */

const SUBMITTED = { requestable: true, requestableReason: null }
const NOT_SUBMITTED = {
  requestable: false,
  requestableReason: 'Only a submitted ECO can be sent for approval — the approval gates the '
    + 'move from submitted to approved, and this ECO is "draft".',
}

describe('approvalRequestAvailability', () => {
  it('offers a first request on a record whose status admits one and has no approval', () => {
    expect(approvalRequestAvailability({
      ...SUBMITTED, approvalStatus: null, drifted: false,
    })).toEqual({ canRequest: true, label: 'Request approval' })
  })

  it("refuses with the SERVICE's own reason when the status does not admit a request", () => {
    // The string is not re-worded here. `ecoApprovalRequestable` /
    // `repairSignOffRequestable` build a sentence naming the current status, and a
    // panel showing a different sentence from the one the write would throw is the
    // drift this function exists to prevent.
    expect(approvalRequestAvailability({
      ...NOT_SUBMITTED, approvalStatus: null, drifted: false,
    })).toEqual({ canRequest: false, reason: NOT_SUBMITTED.requestableReason })
  })

  it('checks the status BEFORE the pending request, matching the service call order', () => {
    // requestEcoApproval runs ecoApprovalRequestable and throws
    // EcoApprovalRequestError before requestApprovalInTx can raise
    // ApprovalAlreadyPendingError. A panel reporting the pending request first
    // would name a different blocker than the one the user would actually hit,
    // which is worse than naming none.
    expect(approvalRequestAvailability({
      ...NOT_SUBMITTED, approvalStatus: 'pending', drifted: false,
    })).toEqual({ canRequest: false, reason: NOT_SUBMITTED.requestableReason })
  })

  it('refuses while a request is pending — the partial unique index would refuse it too', () => {
    const res = approvalRequestAvailability({
      ...SUBMITTED, approvalStatus: 'pending', drifted: false,
    })
    expect(res.canRequest).toBe(false)
    if (!res.canRequest) expect(res.reason).toMatch(/pending/i)
  })

  it('refuses while an approval is live and still describes the record', () => {
    // Nothing to re-decide: a second request would put a duplicate in a real
    // person's queue asking them to agree to what they have already agreed to.
    const res = approvalRequestAvailability({
      ...SUBMITTED, approvalStatus: 'approved', drifted: false,
    })
    expect(res.canRequest).toBe(false)
    if (!res.canRequest) expect(res.reason).toMatch(/already approved/i)
  })

  it('OFFERS a fresh request once an approved snapshot has drifted', () => {
    // This is the whole reason drift gets a surface. The record is blocked and
    // the only way forward is a new request, so the control must be live here
    // even though an approval exists.
    expect(approvalRequestAvailability({
      ...SUBMITTED, approvalStatus: 'approved', drifted: true,
    })).toEqual({ canRequest: true, label: 'Request approval again' })
  })

  it('offers a fresh request after a rejection', () => {
    // A rejected request is never reopened (approvalService); changing what was
    // asked for and asking again is the documented remedy.
    expect(approvalRequestAvailability({
      ...SUBMITTED, approvalStatus: 'rejected', drifted: false,
    })).toEqual({ canRequest: true, label: 'Request approval again' })
  })

  it('never offers a request the status refuses, even after a rejection', () => {
    expect(approvalRequestAvailability({
      ...NOT_SUBMITTED, approvalStatus: 'rejected', drifted: false,
    })).toEqual({ canRequest: false, reason: NOT_SUBMITTED.requestableReason })
  })

  it('falls back to a readable line when the service gave no reason', () => {
    // requestableReason is `string | null` by type. A null alongside
    // requestable:false is a service bug, but a panel rendering "null" — or a
    // disabled button explaining nothing — is a worse one.
    const res = approvalRequestAvailability({
      requestable: false, requestableReason: null, approvalStatus: null, drifted: false,
    })
    expect(res.canRequest).toBe(false)
    if (!res.canRequest) expect(res.reason.trim().length).toBeGreaterThan(0)
  })

  it('ignores drift on a request that was never approved', () => {
    // `drift` is only ever populated for an approved snapshot, but a caller that
    // passed it alongside a pending request must not thereby unlock a second
    // request the unique index would refuse.
    const res = approvalRequestAvailability({
      ...SUBMITTED, approvalStatus: 'pending', drifted: true,
    })
    expect(res.canRequest).toBe(false)
  })
})
