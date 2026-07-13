import { createAdminClient } from '@/lib/supabase/server'
import { createDevice } from '@/lib/services/deviceService'
import { can, ACTIONS } from '@/lib/auth/permissions'
import { AppError } from '@/lib/types'
import type { ExtractedDeviceDraft, DeviceRow, DeviceInput, Role } from '@/lib/types'

/**
 * Map an extracted_payload fields object → DeviceInput, applying the same
 * defaults used by the draft-promotion flow. Used both when promoting a draft
 * and when the invoice confirm modal calls createDevice directly.
 */
export function fieldsToDeviceInput(
  fields: Record<string, { value: unknown; confidence?: number; source_quote?: string }>
): DeviceInput {
  return {
    device_sn:      (fields.device_sn?.value as string) || null,
    product_name:   (fields.product_name?.value as string) || null,
    model_no:       (fields.model_no?.value as string) || null,
    pcba_a_sn:      (fields.pcba_a_sn?.value as string) ?? '',
    pcba_a_hw_rev:  (fields.pcba_a_hw_rev?.value as string) ?? '',
    pcba_a_bom_rev: (fields.pcba_a_bom_rev?.value as string) ?? '',
    pcba_a_fw_ver:  (fields.pcba_a_fw_ver?.value as string) ?? '',
    pcba_b_sn:      (fields.pcba_b_sn?.value as string) || null,
    pcba_b_hw_rev:  (fields.pcba_b_hw_rev?.value as string) || null,
    pcba_b_bom_rev: (fields.pcba_b_bom_rev?.value as string) || null,
    pcba_b_fw_ver:  (fields.pcba_b_fw_ver?.value as string) || null,
    screen_model:   (fields.screen_model?.value as string) || null,
    hmi_ver:        (fields.hmi_ver?.value as string) || null,
    build_date:     (fields.build_date?.value as string) || null,
    ship_date:      (fields.ship_date?.value as string) || null,
    qty:            fields.qty?.value != null ? Number(fields.qty.value) : null,
    destination:    (fields.destination?.value as string) || null,
    customer:       (fields.customer?.value as string) || null,
    // Defaults must be valid seeded vocabulary codes (status_option / phase_option);
    // otherwise promoting a draft with a missing status/phase fails the DB FK check.
    status:         (fields.status?.value as string) ?? 'Stock',
    phase:          (fields.phase?.value as string) ?? 'Production',
    remarks:        (fields.remarks?.value as string) || null,
  }
}

export async function getPendingDraftCount(): Promise<number> {
  const supabase = createAdminClient()
  const { count, error } = await supabase
    .from('extracted_device_draft')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending_review')
  if (error) throw new Error(error.message)
  return count ?? 0
}

export async function listDrafts(): Promise<ExtractedDeviceDraft[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('extracted_device_draft')
    .select('*')
    .eq('status', 'pending_review')
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as ExtractedDeviceDraft[]
}

export async function getDraft(id: string): Promise<ExtractedDeviceDraft | null> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('extracted_device_draft')
    .select('*')
    .eq('id', id)
    .single()
  if (error) return null
  return data as ExtractedDeviceDraft
}

/**
 * Promote a draft to a real device record, attributed to the reviewing engineer.
 * The draft's extracted_payload is parsed into DeviceInput and passed to createDevice.
 */
export async function promoteDraft(
  id: string,
  reviewerActorId: string,
  actorRole: Role
): Promise<DeviceRow> {
  if (!can(actorRole, ACTIONS.CONFIRM_DRAFT)) {
    throw new AppError({ type: 'permission', message: 'You do not have permission to confirm drafts' })
  }

  const supabase = createAdminClient()
  const draft = await getDraft(id)
  if (!draft) throw new Error('Draft not found')
  if (draft.status !== 'pending_review') {
    throw new AppError({ type: 'validation', message: `Draft is already ${draft.status}`, errors: {} })
  }

  // Parse extracted_payload — format: { version, fields: { <field>: { value, confidence, source_quote } } }
  const payload = draft.extracted_payload as {
    version?: string
    fields?: Record<string, { value: unknown; confidence?: number; source_quote?: string }>
  }

  const deviceInput: DeviceInput = fieldsToDeviceInput(payload?.fields ?? {})

  // Create the device attributed to the reviewer
  const device = await createDevice(deviceInput, reviewerActorId, actorRole)

  // Mark the draft as confirmed
  await supabase
    .from('extracted_device_draft')
    .update({
      status: 'confirmed',
      reviewed_by: reviewerActorId,
      promoted_device_id: device.id,
    })
    .eq('id', id)

  return device
}

/**
 * Reject a draft — dismiss it from the pending queue without promoting to a
 * device. Same permission gate as promoteDraft (whoever can confirm can reject).
 * The draft is retained (never deleted), attributed to the reviewing engineer.
 */
export async function rejectDraft(
  id: string,
  reviewerActorId: string,
  actorRole: Role
): Promise<void> {
  if (!can(actorRole, ACTIONS.CONFIRM_DRAFT)) {
    throw new AppError({ type: 'permission', message: 'You do not have permission to confirm drafts' })
  }

  const supabase = createAdminClient()
  const draft = await getDraft(id)
  if (!draft) throw new Error('Draft not found')
  if (draft.status !== 'pending_review') {
    throw new AppError({ type: 'validation', message: `Draft is already ${draft.status}`, errors: {} })
  }

  await supabase
    .from('extracted_device_draft')
    .update({
      status: 'rejected',
      reviewed_by: reviewerActorId,
    })
    .eq('id', id)
}
