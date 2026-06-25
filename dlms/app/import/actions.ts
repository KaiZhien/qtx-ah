'use server'
import { getStatuses, getPhases } from '@/lib/services/vocabularyService'
import { previewCsvRows, importValidRows } from '@/lib/services/importService'
import { previewExcelBuffer } from '@/lib/services/excelImportService'
import { getCurrentUser } from '@/lib/auth/session'
import { can, ACTIONS } from '@/lib/auth/permissions'
import type { ImportPreviewRow, Role } from '@/lib/types'
import { revalidatePath } from 'next/cache'

export async function previewImportAction(csvRows: Record<string, string>[]): Promise<ImportPreviewRow[]> {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.IMPORT_DATA)) throw new Error('Unauthorized')
  const [statuses, phases] = await Promise.all([getStatuses(), getPhases()])
  return previewCsvRows(csvRows, statuses.map(s => s.code), phases.map(p => p.code))
}

export async function importAction(rows: ImportPreviewRow[]): Promise<{ imported: number; skipped: number }> {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.IMPORT_DATA)) throw new Error('Unauthorized')
  const result = await importValidRows(rows, user.id, user.role as Role)
  revalidatePath('/devices')
  return result
}

export async function previewExcelAction(bytes: Uint8Array): Promise<ImportPreviewRow[]> {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.IMPORT_DATA)) throw new Error('Unauthorized')
  const [statuses, phases] = await Promise.all([getStatuses(), getPhases()])
  return previewExcelBuffer(bytes.buffer, statuses.map(s => s.code), phases.map(p => p.code))
}
