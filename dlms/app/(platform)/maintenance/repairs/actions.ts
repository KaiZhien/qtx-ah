'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import {
  requireAal2Actor, MfaRequiredError, UnauthenticatedError, SESSION_EXPIRED_MESSAGE,
} from '@/modules/shared/auth/session'
import {
  createRepair, updateRepair, changeRepairStatus, signOffRepair,
  requestRepairSignOffApproval,
  RepairNotFoundError, RepairDeviceNotFoundError, RepairSignOffRequestError,
  type CreateRepairInput, type UpdateRepairInput,
  type ChangeRepairStatusInput, type SignOffRepairInput,
  type RequestRepairSignOffApprovalInput,
} from '@/modules/maintenance/services/repairService'
import {
  InvalidRepairTransitionError, RepairSignOffError,
} from '@/modules/maintenance/domain/repairStatus'
import { InvalidStatusChangeError } from '@/modules/manufacturing/domain/deviceStatus'
import { ApprovalGateError } from '@/modules/shared/approvals/domain/approvalGate'
import { ApprovalAlreadyPendingError } from '@/modules/shared/approvals/services/approvalService'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Single sanitization contract for every repair write action (mirrors
 * deviceWriteActions.toMessage). Known, safe errors surface their own message;
 * anything else is logged server-side and replaced with a generic line so a raw
 * Postgres/internal error can never reach the browser.
 */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  if (err instanceof UnauthenticatedError) return SESSION_EXPIRED_MESSAGE
  // A ZodError is a stale screen or a malformed id disagreeing with the schema,
  // which the user can act on by reloading. Same treatment as the four other
  // action files that map it.
  if (err instanceof z.ZodError) {
    return err.errors[0]?.message ?? 'That request could not be read. Reload and try again.'
  }
  if (err instanceof InvalidRepairTransitionError) return err.message
  if (err instanceof RepairSignOffError) return err.message
  // THE APPROVAL GATE'S REFUSALS, WHICH THIS FILE MAPPED NOWHERE UNTIL NOW.
  // `RepairSignOffApprovalError extends ApprovalGateError`, so before this line
  // every drift refusal fell to the generic branch below: the signer was told
  // "Something went wrong" — losing the one sentence naming what moved, e.g.
  // recordedReplacementCount "1" → "2", which is the difference between "reload"
  // and "somebody swapped a second board since this was reviewed" — and the
  // system logged its own deliberate refusal at ERROR while doing so.
  if (err instanceof ApprovalGateError) return err.message
  // "Only a repair that is awaiting sign-off can be sent for sign-off approval."
  // The panel disables the control for exactly this reason, so reaching here
  // means a stale screen; the sentence names the current status.
  if (err instanceof RepairSignOffRequestError) return err.message
  // Expected traffic, not a bug: the honest double-click produces it.
  if (err instanceof ApprovalAlreadyPendingError) return err.message
  // A repair write can now fail on the DEVICE half: since the device move shares
  // the repair's transaction, a move the status graph refuses aborts the whole
  // write instead of being swallowed into `deviceMoved: false`. The message is
  // already the human one Manufacturing composes ("A device cannot move from
  // X to Y"), so it passes through — without this line the user would be told
  // "Something went wrong" about a rule the system knows how to explain.
  if (err instanceof InvalidStatusChangeError) return err.message
  if (err instanceof RepairDeviceNotFoundError) {
    return 'That device no longer exists. Reload and try again.'
  }
  if (err instanceof RepairNotFoundError) {
    return 'That repair no longer exists. Reload and try again.'
  }
  if (err instanceof OptimisticLockError) {
    return 'Someone else changed this repair. Reload and try again.'
  }
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'repair write action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

export async function createRepairAction(
  input: CreateRepairInput,
): Promise<ActionResult<{ repairId: string; deviceMoved: boolean }>> {
  try {
    const actor = await requireAal2Actor()
    const { repairId, deviceMoved } = await createRepair(actor, input)
    revalidatePath('/maintenance')
    revalidatePath('/maintenance/repairs')
    return { ok: true, data: { repairId, deviceMoved } }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function updateRepairAction(
  input: UpdateRepairInput,
): Promise<ActionResult<{ version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await updateRepair(actor, input)
    revalidatePath(`/maintenance/repairs/${input.repairId}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function changeRepairStatusAction(
  input: ChangeRepairStatusInput,
): Promise<ActionResult<{ status: string; version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await changeRepairStatus(actor, input)
    revalidatePath('/maintenance')
    revalidatePath(`/maintenance/repairs/${input.repairId}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function signOffRepairAction(
  input: SignOffRepairInput,
): Promise<ActionResult<{ deviceReturned: boolean }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await signOffRepair(actor, input)
    revalidatePath('/maintenance')
    revalidatePath(`/maintenance/repairs/${input.repairId}`)
    return { ok: true, data: { deviceReturned: res.deviceReturned } }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

/**
 * Ask for a second pair of eyes before a repair is signed off (spec §5.5, AP2).
 *
 * THE MISSING HALF, exactly as on the ECO side: `requestRepairSignOffApproval`
 * shipped implemented, tested, templated and registered, and nothing called it —
 * so "requested ⇒ binding" was vacuous for Maintenance and no repair could ever
 * appear in `/approvals`.
 *
 * IT DOES NOT MAKE SIGN-OFF REQUIRE AN APPROVAL. `requiredWithoutRequest` stays
 * `false`: a repair nobody raised a request for signs off exactly as before,
 * under the same `sign_off_repairs` gate and the same three-fact precondition.
 * The gate on the requester here is `edit_records` — the technician who did the
 * work is the person who should be able to ask, and since nobody may decide
 * their own request, demanding the signer's permission to ASK would make the
 * request close to useless.
 *
 * Revalidates the repair page AND the approvals queue: the queue reads `approval`
 * directly, so the request is visible there the instant it commits, drain or no
 * drain.
 */
export async function requestRepairSignOffApprovalAction(
  input: RequestRepairSignOffApprovalInput,
): Promise<ActionResult<{ approvalId: string }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await requestRepairSignOffApproval(actor, input)
    revalidatePath(`/maintenance/repairs/${input.repairId}`)
    revalidatePath('/approvals')
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
