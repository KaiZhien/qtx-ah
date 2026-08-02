import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireAal2Actor = vi.fn()
const mockCreate = vi.fn()
const mockChangeStatus = vi.fn()
const mockReceive = vi.fn()
const mockList = vi.fn()

vi.mock('@/modules/shared/auth/session', () => ({
  requireAal2Actor: mockRequireAal2Actor,
  MfaRequiredError: class MfaRequiredError extends Error {},
}))
vi.mock('@/modules/logistics/services/stockTransferService', () => ({
  listStockTransfers: mockList,
  createStockTransfer: mockCreate,
  changeTransferStatus: mockChangeStatus,
  receiveStockTransfer: mockReceive,
  StockTransferNotFoundError: class StockTransferNotFoundError extends Error {},
  DuplicateTransferNumberError: class DuplicateTransferNumberError extends Error {},
  InsufficientStockError: class InsufficientStockError extends Error {},
  TrackingModeMismatchError: class TrackingModeMismatchError extends Error {},
  UnknownReferenceError: class UnknownReferenceError extends Error {},
  SerializedUnitNotAtSourceError: class SerializedUnitNotAtSourceError extends Error {},
  StockPostingError: class StockPostingError extends Error {},
}))
vi.mock('@/modules/logistics/domain/transferStatus', () => ({
  InvalidTransferStatusChangeError: class InvalidTransferStatusChangeError extends Error {},
}))
vi.mock('@/modules/shared/authz/authorize', () => ({
  PermissionError: class PermissionError extends Error {},
}))
vi.mock('@/lib/db/tx', () => ({
  OptimisticLockError: class OptimisticLockError extends Error {},
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const {
  createStockTransferAction, changeTransferStatusAction, receiveStockTransferAction,
  loadMoreStockTransfersAction,
} = await import('@/app/(platform)/logistics/transfers/actions')

const ACTOR = {
  id: 'u1', roleKey: 'operator' as const,
  permissions: new Set(['edit_records' as const]),
  moduleAccess: new Set(['logistics' as const]), active: true,
}

const CREATE_INPUT = {
  transferNo: 'ST-1', fromLocationId: 'a', toLocationId: 'b',
  batchLines: [{ componentTypeId: 't1', qty: 5 }],
}
const RECEIVE_INPUT = { stockTransferId: 'st1', version: 1 }

const MFA_MESSAGE = 'Two-factor authentication required — reload the page to finish signing in.'

beforeEach(() => {
  mockRequireAal2Actor.mockReset().mockResolvedValue(ACTOR)
  mockCreate.mockReset()
  mockChangeStatus.mockReset()
  mockReceive.mockReset()
  mockList.mockReset()
})

describe('createStockTransferAction', () => {
  it('reports the new id on success', async () => {
    mockCreate.mockResolvedValue({ id: 'st1', status: 'draft' })
    expect(await createStockTransferAction(CREATE_INPUT)).toEqual({ ok: true, data: { id: 'st1' } })
  })

  it('surfaces a duplicate transfer number verbatim', async () => {
    const { DuplicateTransferNumberError } = await import(
      '@/modules/logistics/services/stockTransferService')
    mockCreate.mockRejectedValue(new DuplicateTransferNumberError('ST-1 already exists'))
    expect(await createStockTransferAction(CREATE_INPUT))
      .toEqual({ ok: false, error: 'ST-1 already exists' })
  })

  it('surfaces a tracking-mode mismatch so the user can fix the line', async () => {
    const { TrackingModeMismatchError } = await import(
      '@/modules/logistics/services/stockTransferService')
    mockCreate.mockRejectedValue(new TrackingModeMismatchError(
      'pcba_a is a serialized component — transfer it by unit serial number, not by quantity'))
    const res = await createStockTransferAction(CREATE_INPUT)
    expect(res).toEqual({ ok: false, error:
      'pcba_a is a serialized component — transfer it by unit serial number, not by quantity' })
  })

  it('never leaks an internal DB error', async () => {
    mockCreate.mockRejectedValue(
      new Error('duplicate key value violates unique constraint "stock_transfer_no_unique"'))
    const res = await createStockTransferAction(CREATE_INPUT)
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).not.toContain('constraint')
  })
})

describe('receiveStockTransferAction', () => {
  it('reports the posted status on success', async () => {
    mockReceive.mockResolvedValue({ status: 'received', version: 2, postedBalances: [] })
    expect(await receiveStockTransferAction(RECEIVE_INPUT))
      .toEqual({ ok: true, data: { status: 'received', version: 2 } })
  })

  it('shows the insufficient-stock message verbatim — the clerk needs the detail', async () => {
    const { InsufficientStockError } = await import(
      '@/modules/logistics/services/stockTransferService')
    mockReceive.mockRejectedValue(new InsufficientStockError(
      'Not enough pcba_a at SG-WH: tried to move 5.000, only 2.000 on hand'))
    expect(await receiveStockTransferAction(RECEIVE_INPUT)).toEqual({
      ok: false, error: 'Not enough pcba_a at SG-WH: tried to move 5.000, only 2.000 on hand' })
  })

  it('maps a duplicate receive to the transition error, not a generic failure', async () => {
    // The idempotency guard's user-visible face: receiving twice says "already
    // received" rather than silently succeeding or dumping a raw error.
    const { InvalidTransferStatusChangeError } = await import(
      '@/modules/logistics/domain/transferStatus')
    mockReceive.mockRejectedValue(new InvalidTransferStatusChangeError(
      'Cannot move a stock transfer from "received" to "received".'))
    expect(await receiveStockTransferAction(RECEIVE_INPUT)).toEqual({
      ok: false, error: 'Cannot move a stock transfer from "received" to "received".' })
  })

  it('maps a moved serialized unit to its own message', async () => {
    const { SerializedUnitNotAtSourceError } = await import(
      '@/modules/logistics/services/stockTransferService')
    mockReceive.mockRejectedValue(new SerializedUnitNotAtSourceError(
      'Unit SN-9 is not at SG-WH — it was moved since this transfer was raised'))
    const res = await receiveStockTransferAction(RECEIVE_INPUT)
    expect((res as { error: string }).error).toContain('SN-9')
  })

  it('maps an optimistic lock clash to a reload prompt', async () => {
    const { OptimisticLockError } = await import('@/lib/db/tx')
    mockReceive.mockRejectedValue(new OptimisticLockError('boom'))
    expect(await receiveStockTransferAction(RECEIVE_INPUT))
      .toEqual({ ok: false, error: 'Someone else changed this transfer. Reload and try again.' })
  })

  it('never leaks an internal DB error', async () => {
    mockReceive.mockRejectedValue(
      new Error('new row for relation "stock_level" violates check constraint "stock_level_qty_check"'))
    const res = await receiveStockTransferAction(RECEIVE_INPUT)
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).not.toContain('constraint')
  })
})

describe('changeTransferStatusAction', () => {
  it('reports the new status on success', async () => {
    mockChangeStatus.mockResolvedValue({ status: 'dispatched', version: 2 })
    expect(await changeTransferStatusAction({
      stockTransferId: 'st1', toStatus: 'dispatched', version: 1,
    })).toEqual({ ok: true, data: { status: 'dispatched', version: 2 } })
  })

  it('maps a forbidden transition to its message', async () => {
    const { InvalidTransferStatusChangeError } = await import(
      '@/modules/logistics/domain/transferStatus')
    mockChangeStatus.mockRejectedValue(new InvalidTransferStatusChangeError(
      'Cannot move a stock transfer from "cancelled" to "dispatched".'))
    const res = await changeTransferStatusAction({
      stockTransferId: 'st1', toStatus: 'dispatched', version: 1 })
    expect((res as { error: string }).error).toContain('Cannot move a stock transfer')
  })
})

describe('the AAL2 guard is inside the try block', () => {
  // Regression pin matching __tests__/actionMfaMapping.test.ts: a guard called
  // ABOVE the try lets MfaRequiredError escape unmapped. Every action here must
  // RESOLVE to the friendly message rather than reject.
  it.each([
    ['createStockTransferAction', () => createStockTransferAction(CREATE_INPUT)],
    ['changeTransferStatusAction', () => changeTransferStatusAction({
      stockTransferId: 'st1', toStatus: 'cancelled' as const, version: 1 })],
    ['receiveStockTransferAction', () => receiveStockTransferAction(RECEIVE_INPUT)],
  ])('%s resolves to the friendly MFA error', async (_name, invoke) => {
    const { MfaRequiredError } = await import('@/modules/shared/auth/session')
    mockRequireAal2Actor.mockRejectedValue(new MfaRequiredError())
    await expect(invoke()).resolves.toEqual({ ok: false, error: MFA_MESSAGE })
  })

  it('loadMoreStockTransfersAction resolves to the friendly MFA error', async () => {
    const { MfaRequiredError } = await import('@/modules/shared/auth/session')
    mockRequireAal2Actor.mockRejectedValue(new MfaRequiredError())
    await expect(loadMoreStockTransfersAction({})).resolves.toEqual({ error: MFA_MESSAGE })
  })
})

describe('loadMoreStockTransfersAction', () => {
  it('passes the filter straight through and returns the page', async () => {
    mockList.mockResolvedValue({ items: [], nextCursor: 'c2' })
    expect(await loadMoreStockTransfersAction({ cursor: 'c1' })).toEqual({ items: [], nextCursor: 'c2' })
    expect(mockList).toHaveBeenCalledWith(ACTOR, { cursor: 'c1' })
  })

  it('never leaks an internal error', async () => {
    mockList.mockRejectedValue(new Error('relation "stock_transfer" does not exist'))
    const res = await loadMoreStockTransfersAction({})
    expect((res as { error: string }).error).not.toContain('relation')
  })
})
