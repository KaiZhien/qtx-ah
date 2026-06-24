import { createAdminClient } from '@/lib/supabase/server'
import { createDevice } from '@/lib/services/deviceService'
import { can, ACTIONS } from '@/lib/auth/permissions'
import { AppError } from '@/lib/types'
import type { ExtractedDeviceDraft, DeviceRow, DeviceInput, Role } from '@/lib/types'

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
    throw new AppError({ type: 'validation', message: `Draft is already ${draft.status}` })
  }

  // Parse extracted_payload — format: { version, fields: { <field>: { value, confidence, source_quote } } }
  const payload = draft.extracted_payload as {
    version?: string
    fields?: Record<string, { value: unknown; confidence?: number; source_quote?: string }>
  }

  const fields = payload?.fields ?? {}
  const deviceInput: DeviceInput = {
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
    status:         (fields.status?.value as string) ?? 'In Production',
    phase:          (fields.phase?.value as string) ?? 'MP',
    remarks:        (fields.remarks?.value as string) || null,
  }

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
