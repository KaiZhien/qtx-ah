'use server'

import crypto from 'crypto'
import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth/session'
import { can, ACTIONS } from '@/lib/auth/permissions'
import { createAdminClient } from '@/lib/supabase/server'
import { createDevice, getDeviceByPcbaSn } from '@/lib/services/deviceService'
import { extractInvoiceFields } from '@/lib/services/invoiceExtractionService'
import type { DeviceInput, Role } from '@/lib/types'
import type { ExtractedFields } from '@/lib/services/invoiceExtractionService'

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/jpg',
])
const MAX_BYTES = 25 * 1024 * 1024  // 25 MB

type ExtractResult =
  | { fields: ExtractedFields; fileHash: string; fileName: string; mediaType: string }
  | { error: string }

/**
 * Upload an invoice file, extract device fields via Claude vision, and return the
 * extracted fields for the confirm modal. Nothing is persisted to Storage or DB here.
 */
export async function extractInvoiceAction(formData: FormData): Promise<ExtractResult> {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.CREATE_DEVICE)) {
    return { error: 'Unauthorized — engineer or admin role required' }
  }

  const file = formData.get('file') as File | null
  if (!file) return { error: 'No file provided' }
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return { error: `Unsupported file type "${file.type}". Accepted: PDF, JPG, PNG.` }
  }
  if (file.size > MAX_BYTES) {
    return { error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 25 MB.` }
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer())

    // SHA-256 hash of the raw bytes — used as idempotency key on confirm
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex')

    const fields = await extractInvoiceFields({
      buffer,
      mediaType: file.type as 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/jpg',
    })

    return { fields, fileHash, fileName: file.name, mediaType: file.type }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Extraction failed'
    return { error: `Extraction failed: ${msg}` }
  }
}

type ConfirmResult =
  | { id: string }
  | { error: string; existingId?: string }

/**
 * On Confirm: upload the original invoice file to private Storage, create the device
 * row, and write an audit record to extracted_device_draft.
 * Nothing is called here on Cancel — so the cancel path is truly zero-write.
 */
export async function confirmInvoiceDeviceAction(
  input: DeviceInput,
  formData: FormData,
  fileHash: string,
  extractedFields: ExtractedFields,
): Promise<ConfirmResult> {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.CREATE_DEVICE)) {
    return { error: 'Unauthorized — engineer or admin role required' }
  }

  const file = formData.get('file') as File | null
  if (!file) return { error: 'File missing from confirm request' }

  try {
    // Duplicate detection: check for an existing device with the same PCBA-A S/N
    const existing = await getDeviceByPcbaSn(input.pcba_a_sn)
    if (existing) {
      return {
        error: `A device with PCBA-A S/N "${input.pcba_a_sn}" already exists`,
        existingId: existing.id,
      }
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const supabase = createAdminClient()

    // Derive extension from MIME
    const extMap: Record<string, string> = {
      'application/pdf': 'pdf',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
    }
    const ext = extMap[file.type] ?? 'bin'
    const year = new Date().getFullYear()
    const storagePath = `${year}/${fileHash}.${ext}`

    // Upload to private invoices bucket
    const { error: uploadError } = await supabase.storage
      .from('invoices')
      .upload(storagePath, buffer, {
        contentType: file.type,
        upsert: false,  // reject if already uploaded (idempotency)
      })

    if (uploadError && uploadError.message !== 'The resource already exists') {
      return { error: `File upload failed: ${uploadError.message}` }
    }

    const sourceFilePath = `invoices/${storagePath}`

    // Create the device record (handles all validation + audit logging)
    const device = await createDevice(input, user.id, user.role as Role)

    // Write a confirmed draft record for audit/provenance.
    // source_file_hash has a UNIQUE constraint — provides idempotency.
    // Cast required because Supabase codegen types may not match in this environment.
    await (supabase
      .from('extracted_device_draft') as any)
      .upsert(
        {
          source_file_path: sourceFilePath,
          source_file_hash: fileHash,
          status: 'confirmed',
          extracted_payload: {
            version: '1',
            fields: extractedFields,
          },
          extraction_model_version: 'claude-sonnet-4-6',
          reviewed_by: user.id,
          promoted_device_id: device.id,
        },
        { onConflict: 'source_file_hash', ignoreDuplicates: false }
      )

    revalidatePath('/devices')
    return { id: device.id }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Confirm failed'
    return { error: msg }
  }
}
