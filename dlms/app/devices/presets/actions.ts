'use server'
import { getCurrentUser } from '@/lib/auth/session'
import { listPresets, savePreset, deletePreset } from '@/lib/services/filterPresetService'
import { revalidatePath } from 'next/cache'

export async function listPresetsAction() {
  const user = await getCurrentUser()
  if (!user) return []
  return listPresets(user.id)
}

export async function savePresetAction(name: string, queryString: string) {
  const user = await getCurrentUser()
  if (!user) return { error: 'Unauthorized' }
  try {
    const preset = await savePreset(user.id, name, queryString)
    revalidatePath('/devices')
    return { preset }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Save failed' }
  }
}

export async function deletePresetAction(id: string) {
  const user = await getCurrentUser()
  if (!user) return { error: 'Unauthorized' }
  try {
    await deletePreset(id, user.id)
    revalidatePath('/devices')
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Delete failed' }
  }
}
