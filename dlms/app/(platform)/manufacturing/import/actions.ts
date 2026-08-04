'use server'

import { revalidatePath } from 'next/cache'
import {
  requireAal2Actor, MfaRequiredError, UnauthenticatedError, SESSION_EXPIRED_MESSAGE,
} from '@/modules/shared/auth/session'
import { PermissionError } from '@/modules/shared/authz/authorize'
import {
  stageImportFile, ImportParseError,
} from '@/modules/manufacturing/services/importParseService'
import {
  commitImportBatch, skipImportRow, cancelImportBatch, retryFailedRows,
  type CommitResult,
} from '@/modules/manufacturing/services/importCommitService'
import {
  MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL,
} from '@/modules/manufacturing/domain/importLimits'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Single sanitization contract for every import action (mirrors
 * deviceWriteActions.toMessage). Known, safe errors surface their own message;
 * anything else is logged server-side and replaced with a generic line so a raw
 * Postgres/internal error can never reach the browser.
 */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  if (err instanceof UnauthenticatedError) return SESSION_EXPIRED_MESSAGE
  // The user's own file is the subject of this message, so it is safe (and
  // useful) to pass it through unchanged.
  if (err instanceof ImportParseError) return err.message
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'import action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

/**
 * Stage an uploaded spreadsheet. Nothing is written to the device registry here
 * — the file becomes an import_batch the reviewer then commits.
 *
 * Size and extension are checked from the File itself: the form's `accept`
 * attribute is a browser convenience that a direct action POST never sees.
 */
export async function uploadImportAction(
  form: FormData,
): Promise<ActionResult<{ batchId: string }>> {
  try {
    const actor = await requireAal2Actor()

    const file = form.get('file')
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, error: 'Choose a file to import.' }
    }
    // The cap and its wording both come from importLimits.ts, which the form's
    // helper text reads too — so the advertised limit and the enforced one are
    // one value.
    if (file.size > MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        error: `That file is larger than ${MAX_UPLOAD_LABEL} — split it and import in parts.`,
      }
    }
    const lower = file.name.toLowerCase()
    const kind = lower.endsWith('.xlsx') ? 'xlsx' : lower.endsWith('.csv') ? 'csv' : null
    if (kind === null) return { ok: false, error: 'Upload a .xlsx or .csv file.' }

    const variantCode = String(form.get('variantCode') ?? '').trim()
    if (!variantCode) return { ok: false, error: 'Choose the device variant for this file.' }

    const { batchId } = await stageImportFile(actor, {
      filename: file.name, kind,
      bytes: new Uint8Array(await file.arrayBuffer()),
      defaultVariantCode: variantCode,
    })
    revalidatePath('/manufacturing/import')
    return { ok: true, data: { batchId } }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

/**
 * Commit one page of the batch's pending rows. Returns what is left, so the
 * caller drives a large file as several round trips rather than one long
 * request — see ImportCommitPanel.
 */
export async function commitBatchAction(
  input: { batchId: string; limit?: number },
): Promise<ActionResult<CommitResult>> {
  try {
    const actor = await requireAal2Actor()
    const result = await commitImportBatch(actor, input)
    revalidatePath(`/manufacturing/import/${input.batchId}`)
    revalidatePath('/manufacturing/devices')
    return { ok: true, data: result }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function skipRowAction(
  input: { batchId: string; rowId: string },
): Promise<ActionResult<null>> {
  try {
    const actor = await requireAal2Actor()
    await skipImportRow(actor, input.batchId, input.rowId)
    revalidatePath(`/manufacturing/import/${input.batchId}`)
    return { ok: true, data: null }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function cancelBatchAction(
  input: { batchId: string },
): Promise<ActionResult<null>> {
  try {
    const actor = await requireAal2Actor()
    await cancelImportBatch(actor, input.batchId)
    revalidatePath(`/manufacturing/import/${input.batchId}`)
    return { ok: true, data: null }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

/**
 * Put the batch's failed rows back in the pending pool. Explicit rather than
 * automatic: a row failed for a reason (a missing permission, a status
 * deactivated mid-import), and requeueing should follow fixing that reason.
 */
export async function retryFailedRowsAction(
  input: { batchId: string },
): Promise<ActionResult<{ requeued: number }>> {
  try {
    const actor = await requireAal2Actor()
    const result = await retryFailedRows(actor, input.batchId)
    revalidatePath(`/manufacturing/import/${input.batchId}`)
    return { ok: true, data: result }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
