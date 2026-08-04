import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireAal2Actor = vi.fn()
const mockCreate = vi.fn()
const mockChangeStatus = vi.fn()
const mockReceive = vi.fn()
const mockList = vi.fn()
const mockOptions = vi.fn()

vi.mock('@/modules/shared/auth/session', () => ({
  requireAal2Actor: mockRequireAal2Actor,
  MfaRequiredError: FakeMfaRequired,
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  SESSION_EXPIRED_MESSAGE: 'Your session has expired. Sign in again.',
}))
// The real error classes take structured constructor arguments (component code,
// location code, requested, available). These stand-ins take a plain message so
// each test can assert on the exact string the action surfaces, and are used
// DIRECTLY in the assertions below rather than re-imported — re-importing would
// bring the real constructor signatures back with them.
class FakeNotFound extends Error {}
class FakeDuplicateNo extends Error {}
class FakeInsufficientStock extends Error {}
class FakeTrackingMismatch extends Error {}
class FakeUnknownReference extends Error {}
class FakeUnitNotAtSource extends Error {}
class FakeUnitNotAvailable extends Error {}
class FakeStockPosting extends Error {}
class FakeInvalidTransition extends Error {}
class FakePermission extends Error {}
class FakeOptimisticLock extends Error {}
class FakeMfaRequired extends Error {}

vi.mock('@/modules/logistics/services/stockTransferService', () => ({
  listStockTransfers: mockList,
  listTransferOptions: mockOptions,
  createStockTransfer: mockCreate,
  changeTransferStatus: mockChangeStatus,
  receiveStockTransfer: mockReceive,
  StockTransferNotFoundError: FakeNotFound,
  DuplicateTransferNumberError: FakeDuplicateNo,
  InsufficientStockError: FakeInsufficientStock,
  TrackingModeMismatchError: FakeTrackingMismatch,
  UnknownReferenceError: FakeUnknownReference,
  SerializedUnitNotAtSourceError: FakeUnitNotAtSource,
  ComponentUnitNotAvailableError: FakeUnitNotAvailable,
  StockPostingError: FakeStockPosting,
}))
vi.mock('@/modules/logistics/domain/transferStatus', () => ({
  InvalidTransferStatusChangeError: FakeInvalidTransition,
}))
vi.mock('@/modules/shared/authz/authorize', () => ({ PermissionError: FakePermission }))
vi.mock('@/lib/db/tx', () => ({ OptimisticLockError: FakeOptimisticLock }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const {
  createStockTransferAction, changeTransferStatusAction, receiveStockTransferAction,
  loadMoreStockTransfersAction, loadTransferOptionsAction,
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
  mockOptions.mockReset()
})

describe('createStockTransferAction', () => {
  it('reports the new id on success', async () => {
    mockCreate.mockResolvedValue({ id: 'st1', status: 'draft' })
    expect(await createStockTransferAction(CREATE_INPUT)).toEqual({ ok: true, data: { id: 'st1' } })
  })

  it('surfaces a duplicate transfer number verbatim', async () => {
    mockCreate.mockRejectedValue(new FakeDuplicateNo('ST-1 already exists'))
    expect(await createStockTransferAction(CREATE_INPUT))
      .toEqual({ ok: false, error: 'ST-1 already exists' })
  })

  it('surfaces a tracking-mode mismatch so the user can fix the line', async () => {
    mockCreate.mockRejectedValue(new FakeTrackingMismatch(
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
    mockReceive.mockRejectedValue(new FakeInsufficientStock(
      'Not enough pcba_a at SG-WH: tried to move 5.000, only 2.000 on hand'))
    expect(await receiveStockTransferAction(RECEIVE_INPUT)).toEqual({
      ok: false, error: 'Not enough pcba_a at SG-WH: tried to move 5.000, only 2.000 on hand' })
  })

  it('maps a duplicate receive to the transition error, not a generic failure', async () => {
    // The idempotency guard's user-visible face: receiving twice says "already
    // received" rather than silently succeeding or dumping a raw error.
    mockReceive.mockRejectedValue(new FakeInvalidTransition(
      'Cannot move a stock transfer from "received" to "received".'))
    expect(await receiveStockTransferAction(RECEIVE_INPUT)).toEqual({
      ok: false, error: 'Cannot move a stock transfer from "received" to "received".' })
  })

  it('maps a moved serialized unit to its own message', async () => {
    mockReceive.mockRejectedValue(new FakeUnitNotAtSource(
      'Unit SN-9 is not at SG-WH — it was moved since this transfer was raised'))
    const res = await receiveStockTransferAction(RECEIVE_INPUT)
    expect((res as { error: string }).error).toContain('SN-9')
  })

  it('refuses an installed unit with a message naming the unit (I1)', async () => {
    // The day-one hazard: a migrated board is disposition='installed' with no
    // location_id. The clerk must be told WHY it cannot move, not fobbed off
    // with the generic line.
    mockReceive.mockRejectedValue(new FakeUnitNotAvailable(
      'Unit SN-7 is installed in a device and cannot be transferred as stock'))
    const res = await receiveStockTransferAction(RECEIVE_INPUT)
    expect(res).toEqual({ ok: false, error:
      'Unit SN-7 is installed in a device and cannot be transferred as stock' })
  })

  it('maps an optimistic lock clash to a reload prompt', async () => {
    mockReceive.mockRejectedValue(new FakeOptimisticLock('boom'))
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

describe('validation failures reach the user, not the generic line', () => {
  it('surfaces the first ZodError issue', async () => {
    const { ZodError } = await import('zod')
    mockCreate.mockRejectedValue(new ZodError([
      { code: 'custom', path: ['transferNo'], message: 'Transfer number is required' },
    ] as never))
    const res = await createStockTransferAction(CREATE_INPUT)
    expect(res).toEqual({ ok: false, error: 'Transfer number is required' })
  })

  it('rejects a non-uuid location in loadTransferOptionsAction', async () => {
    // Server actions are reachable with any argument regardless of the form.
    const res = await loadTransferOptionsAction('not-a-uuid')
    expect(res.ok).toBe(false)
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
    mockChangeStatus.mockRejectedValue(new FakeInvalidTransition(
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
    mockRequireAal2Actor.mockRejectedValue(new FakeMfaRequired())
    await expect(invoke()).resolves.toEqual({ ok: false, error: MFA_MESSAGE })
  })

  it('loadMoreStockTransfersAction resolves to the friendly MFA error', async () => {
    mockRequireAal2Actor.mockRejectedValue(new FakeMfaRequired())
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
