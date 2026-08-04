import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireAal2Actor = vi.fn()
const mockRequestInvoiceApproval = vi.fn()
const mockChangeInvoiceStatus = vi.fn()

vi.mock('@/modules/shared/auth/session', () => ({
  requireAal2Actor: mockRequireAal2Actor,
  MfaRequiredError: class MfaRequiredError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  SESSION_EXPIRED_MESSAGE: 'Your session has expired. Sign in again.',
}))
vi.mock('@/modules/finance/services/invoiceService', () => ({
  createInvoice: vi.fn(),
  updateInvoice: vi.fn(),
  changeInvoiceStatus: mockChangeInvoiceStatus,
  requestInvoiceApproval: mockRequestInvoiceApproval,
  InvoiceNotFoundError: class InvoiceNotFoundError extends Error {},
  DuplicateInvoiceNoError: class DuplicateInvoiceNoError extends Error {},
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const { requestInvoiceApprovalAction, changeInvoiceStatusAction } =
  await import('@/app/(platform)/finance/invoices/invoiceWriteActions')
const { InvoiceApprovalError } = await import('@/modules/finance/domain/invoiceApproval')
const { ApprovalAlreadyPendingError } =
  await import('@/modules/shared/approvals/services/approvalService')
const { SettingUnavailableError } =
  await import('@/modules/shared/settings/services/settingService')

const ACTOR = {
  id: 'u1', roleKey: 'finance' as const,
  permissions: new Set(['manage_finance' as const]),
  moduleAccess: new Set(['finance' as const]), active: true,
}

beforeEach(() => {
  mockRequireAal2Actor.mockReset().mockResolvedValue(ACTOR)
  mockRequestInvoiceApproval.mockReset()
  mockChangeInvoiceStatus.mockReset()
})

describe('requestInvoiceApprovalAction', () => {
  it('returns the new approval id when the service commits', async () => {
    mockRequestInvoiceApproval.mockResolvedValue({ approvalId: 'a1' })
    expect(await requestInvoiceApprovalAction({ invoiceId: 'i1', version: 1 }))
      .toEqual({ ok: true, data: { approvalId: 'a1' } })
  })

  it('passes an ApprovalAlreadyPendingError through as guidance, not as a 500', async () => {
    mockRequestInvoiceApproval.mockRejectedValue(
      new ApprovalAlreadyPendingError('sales_invoice', 'invoice'))
    const res = await requestInvoiceApprovalAction({ invoiceId: 'i1', version: 1 })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toContain('already has a pending')
  })

  it('passes the below-threshold refusal through verbatim', async () => {
    mockRequestInvoiceApproval.mockRejectedValue(
      new InvoiceApprovalError('below_threshold', 'This invoice is below the S$5000 threshold.'))
    expect(await requestInvoiceApprovalAction({ invoiceId: 'i1', version: 1 }))
      .toEqual({ ok: false, error: 'This invoice is below the S$5000 threshold.' })
  })

  it('never leaks an internal error message', async () => {
    mockRequestInvoiceApproval.mockRejectedValue(
      new Error('duplicate key value violates unique constraint "approval_one_pending_idx"'))
    const res = await requestInvoiceApprovalAction({ invoiceId: 'i1', version: 1 })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).not.toContain('constraint')
  })
})

describe('changeInvoiceStatusAction and the approval gate', () => {
  it('shows the drift refusal exactly as the gate worded it — it names the field', async () => {
    mockChangeInvoiceStatus.mockRejectedValue(new InvoiceApprovalError(
      'approval_drifted',
      'This invoice changed after it was approved: totalSgd: "12000.00" → "18500.00".'))
    const res = await changeInvoiceStatusAction({ invoiceId: 'i1', toStatus: 'issued', version: 2 })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toContain('totalSgd')
    expect((res as { error: string }).error).toContain('18500.00')
  })

  it('says the threshold is unset rather than pretending the invoice issued', async () => {
    mockChangeInvoiceStatus.mockRejectedValue(
      new SettingUnavailableError('finance_approval_threshold_sgd', 'has never been set'))
    const res = await changeInvoiceStatusAction({ invoiceId: 'i1', toStatus: 'issued', version: 2 })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toContain('finance_approval_threshold_sgd')
  })
})
