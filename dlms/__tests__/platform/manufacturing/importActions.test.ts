import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireAal2Actor = vi.fn()
const stageImportFile = vi.fn()
const commitImportBatch = vi.fn()
const skipImportRow = vi.fn()
const cancelImportBatch = vi.fn()
const retryFailedRows = vi.fn()
const revalidatePath = vi.fn()

vi.mock('@/modules/shared/auth/session', async () => {
  const actual = await vi.importActual<typeof import('@/modules/shared/auth/session')>(
    '@/modules/shared/auth/session')
  return { ...actual, requireAal2Actor }
})
vi.mock('@/modules/manufacturing/services/importParseService', async () => {
  const actual = await vi.importActual<
    typeof import('@/modules/manufacturing/services/importParseService')>(
    '@/modules/manufacturing/services/importParseService')
  return { ...actual, stageImportFile }
})
vi.mock('@/modules/manufacturing/services/importCommitService', () => ({
  commitImportBatch, skipImportRow, cancelImportBatch, retryFailedRows,
}))
vi.mock('next/cache', () => ({ revalidatePath }))

const actor = { id: 'u1', roleKey: 'manager', permissions: new Set(['import_data']),
                moduleAccess: new Set(['manufacturing']), active: true }

const load = () => import('@/app/(platform)/manufacturing/import/actions')

const fileForm = (name: string, size = 100) => {
  const form = new FormData()
  form.set('variantCode', 'pro')
  form.set('file', new File(['x'.repeat(size)], name, {
    type: name.endsWith('.csv') ? 'text/csv'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  return form
}

beforeEach(() => {
  vi.clearAllMocks()
  requireAal2Actor.mockResolvedValue(actor)
})

describe('uploadImportAction', () => {
  it('stages the file and returns its batch id', async () => {
    stageImportFile.mockResolvedValue({ batchId: 'b1', rowCount: 3, valid: 3,
                                        invalid: 0, needsReview: 0, unmappedHeaders: [] })
    const { uploadImportAction } = await load()
    const res = await uploadImportAction(fileForm('sheet.xlsx'))
    expect(res).toEqual({ ok: true, data: { batchId: 'b1' } })
    expect(stageImportFile).toHaveBeenCalledWith(actor, expect.objectContaining({
      filename: 'sheet.xlsx', kind: 'xlsx', defaultVariantCode: 'pro' }))
  })

  it('hands the file\'s actual bytes to the service', async () => {
    // objectContaining on filename/kind alone passes for an implementation that
    // forwards empty bytes, which would stage an empty batch off a real file.
    stageImportFile.mockResolvedValue({ batchId: 'b1', rowCount: 1, valid: 1,
                                       invalid: 0, needsReview: 0, unmappedHeaders: [] })
    const { uploadImportAction } = await load()
    await uploadImportAction(fileForm('sheet.csv', 40))
    const [, arg] = stageImportFile.mock.calls[0] as [unknown, { bytes: Uint8Array }]
    expect(arg.bytes).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(arg.bytes)).toBe('x'.repeat(40))
  })

  it('recognises a csv upload', async () => {
    stageImportFile.mockResolvedValue({ batchId: 'b2', rowCount: 1, valid: 1,
                                        invalid: 0, needsReview: 0, unmappedHeaders: [] })
    const { uploadImportAction } = await load()
    await uploadImportAction(fileForm('sheet.csv'))
    expect(stageImportFile).toHaveBeenCalledWith(actor, expect.objectContaining({ kind: 'csv' }))
  })

  it('rejects an unsupported file type without calling the service', async () => {
    const { uploadImportAction } = await load()
    const res = await uploadImportAction(fileForm('notes.pdf'))
    expect(res).toEqual({ ok: false, error: 'Upload a .xlsx or .csv file.' })
    expect(stageImportFile).not.toHaveBeenCalled()
  })

  it('rejects a file over 4 MB without calling the service', async () => {
    // 4 MB is the number next.config.mjs's serverActions.bodySizeLimit and the
    // form's helper text both carry; asserting the copy pins all three together.
    const { uploadImportAction } = await load()
    const res = await uploadImportAction(fileForm('big.xlsx', 4 * 1024 * 1024 + 1))
    expect(res).toEqual({
      ok: false, error: 'That file is larger than 4 MB — split it and import in parts.' })
    expect(stageImportFile).not.toHaveBeenCalled()
  })

  it('accepts a file just under 4 MB', async () => {
    stageImportFile.mockResolvedValue({ batchId: 'b1', rowCount: 1, valid: 1,
                                       invalid: 0, needsReview: 0, unmappedHeaders: [] })
    const { uploadImportAction } = await load()
    expect((await uploadImportAction(fileForm('big.xlsx', 4 * 1024 * 1024))).ok).toBe(true)
  })

  it('rejects a missing file', async () => {
    const form = new FormData()
    form.set('variantCode', 'pro')
    const { uploadImportAction } = await load()
    expect(await uploadImportAction(form))
      .toEqual({ ok: false, error: 'Choose a file to import.' })
    expect(stageImportFile).not.toHaveBeenCalled()
  })

  it('rejects an empty file', async () => {
    // A picked-then-emptied file, or a truncated upload: it has a name and a
    // valid extension, so only the size arm catches it.
    const form = new FormData()
    form.set('variantCode', 'pro')
    form.set('file', new File([], 'sheet.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    const { uploadImportAction } = await load()
    expect(await uploadImportAction(form))
      .toEqual({ ok: false, error: 'Choose a file to import.' })
    expect(stageImportFile).not.toHaveBeenCalled()
  })

  it('rejects a missing variant without calling the service', async () => {
    const form = new FormData()
    form.set('file', new File(['x'], 'sheet.csv', { type: 'text/csv' }))
    const { uploadImportAction } = await load()
    expect(await uploadImportAction(form))
      .toEqual({ ok: false, error: 'Choose the device variant for this file.' })
    expect(stageImportFile).not.toHaveBeenCalled()
  })

  it('turns a permission failure into a friendly message, never a throw', async () => {
    const { PermissionError } = await import('@/modules/shared/authz/authorize')
    stageImportFile.mockRejectedValue(new PermissionError('import_data', 'manufacturing'))
    const { uploadImportAction } = await load()
    expect(await uploadImportAction(fileForm('s.xlsx')))
      .toEqual({ ok: false, error: "You don't have permission to do that." })
  })

  it('surfaces a parse failure verbatim — it is the user\'s file, not an internal', async () => {
    const { ImportParseError } = await import(
      '@/modules/manufacturing/services/importParseService')
    stageImportFile.mockRejectedValue(new ImportParseError('Could not find a header row'))
    const { uploadImportAction } = await load()
    expect(await uploadImportAction(fileForm('s.xlsx')))
      .toEqual({ ok: false, error: 'Could not find a header row' })
  })

  it('never leaks an unexpected error', async () => {
    stageImportFile.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.4:5432'))
    const { uploadImportAction } = await load()
    const res = await uploadImportAction(fileForm('s.xlsx'))
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error).not.toMatch(/ECONNREFUSED/)
  })

  it('reports an expired MFA session in plain language', async () => {
    const { MfaRequiredError } = await import('@/modules/shared/auth/session')
    requireAal2Actor.mockRejectedValue(new MfaRequiredError())
    const { uploadImportAction } = await load()
    const res = await uploadImportAction(fileForm('s.xlsx'))
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error).toMatch(/Two-factor/)
    expect(stageImportFile).not.toHaveBeenCalled()
  })
})

describe('commitBatchAction / skipRowAction / cancelBatchAction', () => {
  it('commits and revalidates the batch page', async () => {
    commitImportBatch.mockResolvedValue({ committed: 2, failed: 0, skipped: 0, remaining: 1 })
    const { commitBatchAction } = await load()
    const res = await commitBatchAction({ batchId: 'b1' })
    expect(res).toEqual({ ok: true, data: { committed: 2, failed: 0, skipped: 0, remaining: 1 } })
    expect(revalidatePath).toHaveBeenCalledWith('/manufacturing/import/b1')
    expect(revalidatePath).toHaveBeenCalledWith('/manufacturing/devices')
  })

  it('passes a page limit through to the service', async () => {
    commitImportBatch.mockResolvedValue({ committed: 0, failed: 0, skipped: 0, remaining: 0 })
    const { commitBatchAction } = await load()
    await commitBatchAction({ batchId: 'b1', limit: 200 })
    expect(commitImportBatch).toHaveBeenCalledWith(actor, { batchId: 'b1', limit: 200 })
  })

  it('never leaks an unexpected commit error', async () => {
    commitImportBatch.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.4:5432'))
    const { commitBatchAction } = await load()
    const res = await commitBatchAction({ batchId: 'b1' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error).not.toMatch(/ECONNREFUSED/)
  })

  it('skips a row, batch-scoped', async () => {
    skipImportRow.mockResolvedValue(undefined)
    const { skipRowAction } = await load()
    expect(await skipRowAction({ batchId: 'b1', rowId: 'r1' })).toEqual({ ok: true, data: null })
    expect(skipImportRow).toHaveBeenCalledWith(actor, 'b1', 'r1')
  })

  it('cancels a batch', async () => {
    cancelImportBatch.mockResolvedValue(undefined)
    const { cancelBatchAction } = await load()
    expect(await cancelBatchAction({ batchId: 'b1' })).toEqual({ ok: true, data: null })
    expect(cancelImportBatch).toHaveBeenCalledWith(actor, 'b1')
    expect(revalidatePath).toHaveBeenCalledWith('/manufacturing/import/b1')
  })

  // One MFA-expiry test per action, deliberately not one shared test.
  // requireAal2Actor() must sit INSIDE each action's try so its MfaRequiredError
  // becomes the friendly message rather than a throw that reaches the error
  // boundary — this project has shipped that regression before, and
  // actionAalPinning.test.ts only greps for the identifier, never its placement.
  // Without a case per action, moving the guard above the try in any of these
  // leaves the suite green.
  const expireMfa = async () => {
    const { MfaRequiredError } = await import('@/modules/shared/auth/session')
    requireAal2Actor.mockRejectedValue(new MfaRequiredError())
  }

  it('reports an expired MFA session in plain language: commitBatchAction', async () => {
    await expireMfa()
    const { commitBatchAction } = await load()
    const res = await commitBatchAction({ batchId: 'b1' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error).toMatch(/Two-factor/)
    expect(commitImportBatch).not.toHaveBeenCalled()
  })

  it('reports an expired MFA session in plain language: skipRowAction', async () => {
    await expireMfa()
    const { skipRowAction } = await load()
    const res = await skipRowAction({ batchId: 'b1', rowId: 'r1' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error).toMatch(/Two-factor/)
    expect(skipImportRow).not.toHaveBeenCalled()
  })

  it('reports an expired MFA session in plain language: cancelBatchAction', async () => {
    await expireMfa()
    const { cancelBatchAction } = await load()
    const res = await cancelBatchAction({ batchId: 'b1' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error).toMatch(/Two-factor/)
    expect(cancelImportBatch).not.toHaveBeenCalled()
  })

  it('turns a skip permission failure into a friendly message, never a throw', async () => {
    const { PermissionError } = await import('@/modules/shared/authz/authorize')
    skipImportRow.mockRejectedValue(new PermissionError('import_data', 'manufacturing'))
    const { skipRowAction } = await load()
    expect(await skipRowAction({ batchId: 'b1', rowId: 'r1' }))
      .toEqual({ ok: false, error: "You don't have permission to do that." })
  })

  it('never leaks an unexpected cancel error', async () => {
    cancelImportBatch.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.4:5432'))
    const { cancelBatchAction } = await load()
    const res = await cancelBatchAction({ batchId: 'b1' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error).not.toMatch(/ECONNREFUSED/)
  })
})

describe('retryFailedRowsAction', () => {
  it('requeues the batch failed rows and revalidates the batch page', async () => {
    retryFailedRows.mockResolvedValue({ requeued: 3 })
    const { retryFailedRowsAction } = await load()
    expect(await retryFailedRowsAction({ batchId: 'b1' }))
      .toEqual({ ok: true, data: { requeued: 3 } })
    expect(retryFailedRows).toHaveBeenCalledWith(actor, 'b1')
    expect(revalidatePath).toHaveBeenCalledWith('/manufacturing/import/b1')
  })

  it('turns a permission failure into a friendly message', async () => {
    const { PermissionError } = await import('@/modules/shared/authz/authorize')
    retryFailedRows.mockRejectedValue(new PermissionError('import_data', 'manufacturing'))
    const { retryFailedRowsAction } = await load()
    expect(await retryFailedRowsAction({ batchId: 'b1' }))
      .toEqual({ ok: false, error: "You don't have permission to do that." })
  })

  it('never leaks an unexpected error', async () => {
    retryFailedRows.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.4:5432'))
    const { retryFailedRowsAction } = await load()
    const res = await retryFailedRowsAction({ batchId: 'b1' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error).not.toMatch(/ECONNREFUSED/)
  })

  // See the note above the commit/skip/cancel MFA cases: this pins
  // requireAal2Actor INSIDE this action's try, which no grep-based test can.
  it('reports an expired MFA session in plain language', async () => {
    const { MfaRequiredError } = await import('@/modules/shared/auth/session')
    requireAal2Actor.mockRejectedValue(new MfaRequiredError())
    const { retryFailedRowsAction } = await load()
    const res = await retryFailedRowsAction({ batchId: 'b1' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error).toMatch(/Two-factor/)
    expect(retryFailedRows).not.toHaveBeenCalled()
  })
})
